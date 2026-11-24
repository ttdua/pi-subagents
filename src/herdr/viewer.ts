// Frame painter Herdr runs in its own terminal for one subagent: it paints frames the Pi process
// renders and forwards keys and wheel input back over a Unix socket.
// Runs outside Pi's loader (Node type stripping or Bun): node: built-ins and erasable syntax only.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
	chunkInput,
	encodeMessage,
	InputFramer,
	MAX_FRAME_LINE,
	MessageSplitter,
	parsePiMessage,
	sanitizeFrameLine,
	type ViewerMessage,
} from "./frame-protocol.ts";

export interface ViewerArgs {
	socket: string;
	key: string;
	pid: number;
	parentTerminal: string | undefined;
}

const PARENT_CHECK_MS = 1000;
const HC_TIMEOUT_MS = 800;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
export const RESTORE = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

function flagValues(argv: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag.startsWith("--") && value !== undefined) {
			values.set(flag.slice(2), value);
			i++;
		}
	}
	return values;
}

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`missing --${name}`);
	return value;
}

export function parseArgs(argv: string[]): ViewerArgs {
	const values = flagValues(argv);
	const pid = Number(required(values, "pid"));
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid must be a positive integer");
	return {
		socket: required(values, "socket"),
		key: required(values, "key"),
		pid,
		parentTerminal: values.get("parent-terminal") || undefined,
	};
}

/** One synchronized repaint; rows must already be sanitized. */
export function paintFrame(lines: string[], rows: number): string {
	return `\x1b[?2026h\x1b[H${lines
		.slice(0, rows)
		.map((l) => `${l}\x1b[K`)
		.join("\r\n")}\x1b[J\x1b[?2026l`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
}

function keepOwnTerminalOff(parentTerminal: string | undefined): void {
	const own = process.env.HC_TERMINAL_ID;
	if (!own || own === parentTerminal) return;
	spawnSync("hc", ["keep", own, "--off"], { stdio: "ignore", timeout: HC_TIMEOUT_MS });
}

/** Raw mode keeps keystrokes from echoing; a TTY error must not crash the viewer. */
export function enableRawMode(stdin: { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown }): void {
	if (!stdin.isTTY) return;
	try {
		stdin.setRawMode?.(true);
	} catch {
		// Keep running without raw mode.
	}
}

export interface ExitDeps {
	write: (s: string) => void;
	stdin: { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
	keepOff: () => void;
	exit: (code: number) => void;
}

/** Idempotent: restores the terminal, releases the keep and exits once. */
export function createExit(deps: ExitDeps): () => void {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		try {
			deps.write(RESTORE);
		} catch {
			// The terminal is gone.
		}
		try {
			if (deps.stdin.isTTY) deps.stdin.setRawMode?.(false);
		} catch {
			// Nothing left to restore.
		}
		deps.keepOff();
		deps.exit(0);
	};
}

const size = (): { cols: number; rows: number } => ({
	cols: process.stdout.columns || DEFAULT_COLS,
	rows: process.stdout.rows || DEFAULT_ROWS,
});

function safeWrite(text: string): void {
	try {
		process.stdout.write(text);
	} catch {
		// The terminal is gone.
	}
}

type HelloMessage = Extract<ViewerMessage, { type: "hello" }>;

export interface Sender {
	hello(message: HelloMessage): void;
	send(message: ViewerMessage): void;
}

/**
 * Keeps `hello` first on the channel: messages sent before it are queued and flushed after it in order.
 * Queued resizes are dropped, since `hello` carries the size current when it is sent.
 */
export function createSender(writeLine: (line: string) => void): Sender {
	let ready = false;
	const queued: ViewerMessage[] = [];
	return {
		hello(message) {
			if (ready) return;
			ready = true;
			writeLine(encodeMessage(message));
			for (const m of queued.splice(0)) writeLine(encodeMessage(m));
		},
		send(message) {
			if (ready) writeLine(encodeMessage(message));
			else if (message.type !== "resize") queued.push(message);
		},
	};
}

/** How long a held prefix (a lone Escape) waits for the rest of a sequence before it is sent alone. */
export const ESCAPE_FLUSH_MS = 50;

export interface InputForwarder {
	push(chunk: string): void;
	dispose(): void;
}

/**
 * Frames stdin chunks into input and wheel messages. A prefix the framer holds is sent alone
 * after `ESCAPE_FLUSH_MS`, so a lone Escape never merges with the next key (read as Alt+key).
 */
export function createInputForwarder(sender: Sender): InputForwarder {
	const framer = new InputFramer();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const sendInput = (text: string) => {
		for (const data of chunkInput(text)) sender.send({ type: "input", data });
	};
	const clear = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	return {
		push(chunk) {
			clear();
			for (const event of framer.push(chunk)) {
				if (event.type === "wheel") sender.send(event);
				else sendInput(event.data);
			}
			if (!framer.holding) return;
			timer = setTimeout(() => {
				timer = undefined;
				sendInput(framer.flush());
			}, ESCAPE_FLUSH_MS);
			timer.unref?.();
		},
		dispose: clear,
	};
}

function forwardInput(sender: Sender): InputForwarder {
	const forwarder = createInputForwarder(sender);
	const stdin = process.stdin;
	stdin.setEncoding("utf8");
	stdin.on("error", () => {});
	stdin.on("data", (chunk: string) => forwarder.push(chunk));
	stdin.resume();
	return forwarder;
}

function paintIncoming(socket: net.Socket, onOverflow: () => void): void {
	const splitter = new MessageSplitter(MAX_FRAME_LINE);
	socket.on("data", (chunk: Buffer) => {
		const { lines, overflow } = splitter.push(chunk);
		if (overflow) return onOverflow();
		for (const line of lines) {
			const message = line.trim() === "" ? undefined : parsePiMessage(line);
			if (message) safeWrite(paintFrame(message.lines.map(sanitizeFrameLine), process.stdout.rows || DEFAULT_ROWS));
		}
	});
}

function main(argv: string[]): void {
	const args = parseArgs(argv);
	let input: InputForwarder | undefined;
	const exit = createExit({
		write: safeWrite,
		stdin: process.stdin,
		keepOff: () => {
			input?.dispose();
			keepOwnTerminalOff(args.parentTerminal);
		},
		exit: (code) => process.exit(code),
	});
	// Async write errors (EPIPE) arrive as events; the listener stays attached so RESTORE's own error is handled too.
	process.stdout.on("error", exit);
	safeWrite(ENTER);
	enableRawMode(process.stdin);
	const socket = net.createConnection(args.socket);
	const sender = createSender((line) => {
		if (!socket.destroyed) socket.write(line);
	});
	socket.on("connect", () => sender.hello({ type: "hello", key: args.key, ...size() }));
	socket.on("close", exit);
	socket.on("error", exit);
	paintIncoming(socket, exit);
	input = forwardInput(sender);
	process.on("SIGWINCH", () => sender.send({ type: "resize", ...size() }));
	process.on("SIGTERM", exit);
	setInterval(() => {
		if (!isProcessAlive(args.pid)) exit();
	}, PARENT_CHECK_MS);
}

function isEntryModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isEntryModule()) main(process.argv.slice(2));
