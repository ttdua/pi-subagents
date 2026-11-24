/**
 * frame-server.ts — Main-process Unix-socket server connecting Herdr viewer processes to their
 * ViewerRenderers. One `ViewerConnection` per viewer; a failing connection closes alone.
 * The server and every socket are unref'd.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { debugLog } from "#src/debug";
import { encodeMessage, MAX_VIEWER_LINE, MessageSplitter, parseViewerMessage } from "#src/herdr/frame-protocol";
import type { ViewerRenderer } from "#src/herdr/viewer-renderer";
import type { ViewerTarget } from "#src/herdr/viewer-source";

/** Longest Unix socket path accepted (sun_path is 104 bytes on macOS including the NUL). */
const MAX_SOCKET_PATH = 103;

export interface FrameServerOptions {
	root: string;
	pid: number;
	createRenderer: (target: ViewerTarget, send: (lines: string[]) => void) => ViewerRenderer;
}

interface ConnectionHost {
	/** The target for `key`, or `undefined` when it is not registered. */
	targetOf(key: string): ViewerTarget | undefined;
	/** Called once a hello is accepted; replaces any older connection for the key. */
	claim(key: string, connection: ViewerConnection): void;
	release(key: string, connection: ViewerConnection): void;
	createRenderer: FrameServerOptions["createRenderer"];
}

/** One viewer socket: parses its lines, owns its renderer and its single pending frame. */
class ViewerConnection {
	private readonly splitter = new MessageSplitter(MAX_VIEWER_LINE);
	private renderer: ViewerRenderer | undefined;
	private key: string | undefined;
	private pending: string[] | undefined;
	private closed = false;

	constructor(
		private readonly socket: Socket,
		private readonly host: ConnectionHost,
	) {
		socket.unref();
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("drain", () => this.flush());
		socket.on("error", (err) => this.fail("viewer socket error", err));
		socket.on("close", () => this.close());
	}

	refresh(): void {
		this.renderer?.refresh();
	}

	/** Destroys the socket and disposes the renderer; safe to call repeatedly. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.pending = undefined;
		this.socket.destroy();
		const renderer = this.renderer;
		this.renderer = undefined;
		if (this.key !== undefined) this.host.release(this.key, this);
		try {
			renderer?.dispose();
		} catch (err) {
			debugLog("viewer renderer dispose", err);
		}
	}

	private fail(context: string, err: unknown): void {
		debugLog(context, err);
		this.close();
	}

	private onData(chunk: Buffer): void {
		if (this.closed) return;
		const { lines, overflow } = this.splitter.push(chunk);
		if (overflow) {
			this.close();
			return;
		}
		for (const line of lines) {
			if (this.closed) return;
			this.onLine(line);
		}
	}

	private onLine(line: string): void {
		const message = parseViewerMessage(line);
		if (message === undefined) {
			this.close();
			return;
		}
		try {
			this.dispatch(message);
		} catch (err) {
			this.fail("viewer message", err);
		}
	}

	private dispatch(message: NonNullable<ReturnType<typeof parseViewerMessage>>): void {
		const renderer = this.renderer;
		if (renderer === undefined) {
			if (message.type === "hello") this.start(message.key, message.cols, message.rows);
			else this.close();
			return;
		}
		switch (message.type) {
			case "hello":
				this.close();
				break;
			case "resize":
				renderer.resize(message.cols, message.rows);
				break;
			case "input":
				renderer.input(message.data);
				break;
			case "wheel":
				renderer.wheel(message.delta);
				break;
		}
	}

	private start(key: string, cols: number, rows: number): void {
		const target = this.host.targetOf(key);
		if (target === undefined) {
			this.close();
			return;
		}
		this.key = key;
		this.host.claim(key, this);
		this.renderer = this.host.createRenderer(target, (lines) => this.send(lines));
		this.renderer.resize(cols, rows);
	}

	/** Never throws: a failed write closes only this connection. */
	private send(lines: string[]): void {
		if (this.closed) return;
		if (this.socket.writableNeedDrain) {
			this.pending = lines;
			return;
		}
		this.write(lines);
	}

	private flush(): void {
		const lines = this.pending;
		this.pending = undefined;
		if (lines !== undefined && !this.closed) this.write(lines);
	}

	private write(lines: string[]): void {
		try {
			this.socket.write(encodeMessage({ type: "frame", lines }), (err) => {
				if (err) this.fail("viewer socket write", err);
			});
		} catch (err) {
			this.fail("viewer socket write", err);
		}
	}
}

export class FrameServer implements ConnectionHost {
	private readonly targets = new Map<string, ViewerTarget>();
	private readonly connections = new Map<string, ViewerConnection>();
	private readonly all = new Set<ViewerConnection>();
	private listening: Promise<string | undefined> | undefined;
	private server: Server | undefined;
	private dir: string | undefined;
	private shut = false;

	constructor(private readonly o: FrameServerOptions) {}

	/** Listens lazily, once; `undefined` when the socket cannot be created. */
	socketPath(): Promise<string | undefined> {
		this.listening ??= this.listen();
		return this.listening;
	}

	register(key: string, target: ViewerTarget): void {
		this.targets.set(key, target);
	}

	refresh(key: string): void {
		this.connections.get(key)?.refresh();
	}

	unregister(key: string): void {
		this.targets.delete(key);
		this.connections.get(key)?.close();
	}

	async close(): Promise<void> {
		this.shut = true;
		for (const connection of [...this.all]) connection.close();
		this.connections.clear();
		const server = this.server;
		this.server = undefined;
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}

	createRenderer: FrameServerOptions["createRenderer"] = (target, send) => this.o.createRenderer(target, send);

	targetOf(key: string): ViewerTarget | undefined {
		return this.targets.get(key);
	}

	claim(key: string, connection: ViewerConnection): void {
		const older = this.connections.get(key);
		this.connections.set(key, connection);
		older?.close();
	}

	release(key: string, connection: ViewerConnection): void {
		if (this.connections.get(key) === connection) this.connections.delete(key);
		this.all.delete(connection);
	}

	private async listen(): Promise<string | undefined> {
		if (this.shut) return undefined;
		try {
			mkdirSync(this.o.root, { recursive: true, mode: 0o700 });
			const dir = mkdtempSync(join(this.o.root, `${this.o.pid}-`));
			this.dir = dir;
			chmodSync(dir, 0o700);
			const path = join(dir, "s");
			if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
				debugLog("frame server socket path too long", path);
				this.cleanup();
				return undefined;
			}
			await this.bind(path);
			return path;
		} catch (err) {
			debugLog("frame server listen", err);
			this.cleanup();
			return undefined;
		}
	}

	private bind(path: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => {
				const connection = new ViewerConnection(socket, this);
				this.all.add(connection);
			});
			server.unref();
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				server.on("error", (err) => debugLog("frame server error", err));
				this.server = server;
				resolve();
			});
		});
	}

	private cleanup(): void {
		if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}
}
