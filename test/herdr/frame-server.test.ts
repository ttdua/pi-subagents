import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMarkdownTheme, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeMessage, MessageSplitter, type PiMessage, type ViewerMessage } from "#src/herdr/frame-protocol";
import { FrameServer } from "#src/herdr/frame-server";
import { ViewerRenderer } from "#src/herdr/viewer-renderer";
import type { ViewerTarget } from "#src/herdr/viewer-source";
import type { SessionMessage } from "#src/types";
import type { EntryHeading, NavigableSubagent } from "#src/ui/session-navigation";
import { makeNavigable } from "#test/helpers/make-navigable";

beforeAll(() => initTheme(undefined, false));

const heading: EntryHeading = { name: "Explore", modeLabel: undefined, description: "d" };
const targetOf = (record: NavigableSubagent = makeNavigable({})): ViewerTarget => ({ kind: "record", record, heading });

interface FakeRenderer {
	resize: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	wheel: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	send: (lines: string[]) => void;
}

const fakes: FakeRenderer[] = [];
const fakeFactory = (_t: ViewerTarget, send: (lines: string[]) => void): ViewerRenderer => {
	const r: FakeRenderer = { resize: vi.fn(), input: vi.fn(), wheel: vi.fn(), refresh: vi.fn(), dispose: vi.fn(), send };
	fakes.push(r);
	return r as unknown as ViewerRenderer;
};

const roots: string[] = [];
const servers: FrameServer[] = [];
const clients: Socket[] = [];

function makeServer(createRenderer = fakeFactory, root?: string): FrameServer {
	const dir = root ?? mkdtempSync(join(tmpdir(), "hf-"));
	roots.push(dir);
	const server = new FrameServer({ root: dir, pid: process.pid, createRenderer });
	servers.push(server);
	return server;
}

class Client {
	readonly messages: PiMessage[] = [];
	closed = false;
	private readonly splitter = new MessageSplitter(1 << 24);
	constructor(readonly socket: Socket) {
		socket.on("data", (c) => {
			for (const l of this.splitter.push(c).lines) this.messages.push(JSON.parse(l) as PiMessage);
		});
		socket.on("close", () => {
			this.closed = true;
		});
		socket.on("error", () => {});
	}
	send(m: ViewerMessage | { type: string; [k: string]: unknown }): void {
		this.socket.write(encodeMessage(m as ViewerMessage));
	}
}

async function connect(path: string): Promise<Client> {
	const socket = createConnection(path);
	clients.push(socket);
	await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
	return new Client(socket);
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
};
const settle = () => new Promise((r) => setTimeout(r, 60));

async function hello(server: FrameServer, key: string, cols = 80, rows = 24): Promise<Client> {
	const path = await server.socketPath();
	const client = await connect(path as string);
	client.send({ type: "hello", key, cols, rows });
	return client;
}

afterEach(async () => {
	for (const c of clients.splice(0)) c.destroy();
	for (const s of servers.splice(0)) await s.close();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	fakes.length = 0;
});

describe("FrameServer", () => {
	it("opens no socket before first use", () => {
		const root = mkdtempSync(join(tmpdir(), "hf-"));
		const server = makeServer(fakeFactory, root);
		server.register("a", targetOf());
		expect(existsSync(root) && statSync(root).isDirectory()).toBe(true);
		expect(require("node:fs").readdirSync(root)).toEqual([]);
	});

	it("creates a 0700 directory", async () => {
		const server = makeServer();
		const path = await server.socketPath();
		expect(statSync(dirname(path as string)).mode & 0o777).toBe(0o700);
	});

	it("shares one listen between concurrent callers", async () => {
		const server = makeServer();
		const [a, b] = await Promise.all([server.socketPath(), server.socketPath()]);
		expect(a).toBe(b);
	});

	it("renders for a registered hello", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const client = await hello(server, "a", 90, 30);
		await until(() => fakes.length === 1 && fakes[0].resize.mock.calls.length === 1);
		expect(fakes[0].resize).toHaveBeenCalledWith(90, 30);
		fakes[0].send(["a"]);
		await until(() => client.messages.length === 1);
		expect(client.messages[0]).toEqual({ type: "frame", lines: ["a"] });
	});

	it("closes an unknown key", async () => {
		const server = makeServer();
		const client = await hello(server, "nope");
		await until(() => client.closed);
		expect(fakes).toHaveLength(0);
	});

	it("routes resize, input and wheel", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const client = await hello(server, "a");
		await until(() => fakes.length === 1);
		client.send({ type: "resize", cols: 100, rows: 40 });
		client.send({ type: "input", data: "x" });
		client.send({ type: "wheel", delta: -3 });
		await until(() => fakes[0].wheel.mock.calls.length === 1);
		expect(fakes[0].resize).toHaveBeenLastCalledWith(100, 40);
		expect(fakes[0].input).toHaveBeenCalledWith("x");
		expect(fakes[0].wheel).toHaveBeenCalledWith(-3);
	});

	it("a newer connection replaces the older", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const first = await hello(server, "a");
		await until(() => fakes.length === 1);
		const second = await hello(server, "a");
		await until(() => fakes.length === 2);
		expect(fakes[0].dispose).toHaveBeenCalledTimes(1);
		await until(() => first.closed);
		fakes[1].send(["new"]);
		await until(() => second.messages.length === 1);
		expect(fakes[1].dispose).not.toHaveBeenCalled();
	});

	it("keeps one pending frame for a blocked reader", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const client = await hello(server, "a");
		await until(() => fakes.length === 1);
		client.socket.pause();
		const big = "x".repeat(256 * 1024);
		for (let i = 0; i < 1000; i++) fakes[0].send([big, String(i)]);
		client.socket.resume();
		await until(() => (client.messages.at(-1)?.lines[1] ?? "") === "999");
		expect(client.messages.length).toBeLessThan(10);
	});

	it("closes only the connection with an oversized line", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		server.register("b", targetOf());
		const a = await hello(server, "a");
		const b = await hello(server, "b");
		await until(() => fakes.length === 2);
		a.socket.write(`${JSON.stringify({ type: "input", data: "x" })}${" ".repeat(70000)}\n`);
		await until(() => a.closed);
		fakes[1].send(["still"]);
		await until(() => b.messages.length === 1);
		expect(b.closed).toBe(false);
	});

	it("closes only the connection with an invalid message", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		server.register("b", targetOf());
		const good = await hello(server, "b");
		await until(() => fakes.length === 1);
		const badHello = await hello(server, "a", 1001, 10);
		await until(() => badHello.closed);
		const path = (await server.socketPath()) as string;
		for (const bad of [{ type: "input", data: "x".repeat(4097) }, { type: "nope" }]) {
			const c = await connect(path);
			c.send({ type: "hello", key: "a", cols: 80, rows: 24 });
			await until(() => fakes.length >= 2);
			c.send(bad);
			await until(() => c.closed);
		}
		const first = await connect(path);
		first.send({ type: "input", data: "x" });
		await until(() => first.closed);
		fakes[0].send(["ok"]);
		await until(() => good.messages.length === 1);
		expect(good.closed).toBe(false);
	});

	it("closes only the failing viewer", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		server.register("b", targetOf());
		const a = await hello(server, "a");
		const b = await hello(server, "b");
		await until(() => fakes.length === 2);
		a.socket.destroy();
		await until(() => fakes[0].dispose.mock.calls.length === 1);
		expect(() => fakes[0].send(["x"])).not.toThrow();
		fakes[1].send(["y"]);
		await until(() => b.messages.length === 1);
		expect(fakes[1].dispose).not.toHaveBeenCalled();
	});

	it("one renderer failing leaves another updating", async () => {
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getThinkingBorderColor: () => (t: string) => t };
		const keys = new KeybindingsManager(TUI_KEYBINDINGS, {});
		const broken = { on: false };
		const tool = {
			name: "mytool",
			label: "mytool",
			description: "d",
			parameters: {},
			execute: async () => ({}),
			renderCall: () => ({
				render: () => {
					if (broken.on) throw new Error("boom");
					return ["TOOL"];
				},
				invalidate: () => {},
			}),
		} as unknown as ToolDefinition;
		const messages = [
			{ role: "user", content: "hi" },
		] as unknown as SessionMessage[];
		let listeners: Array<(e?: never) => void> = [];
		const recordA = makeNavigable({
			isSessionReady: () => true,
			subscribeToUpdates: (fn) => {
				listeners.push(fn as never);
				return () => {
					listeners = listeners.filter((l) => l !== (fn as never));
				};
			},
			getToolDefinition: () => tool,
		});
		Object.defineProperty(recordA, "agentMessages", { get: () => messages });
		const recordB = makeNavigable({ isSessionReady: () => true });
		Object.defineProperty(recordB, "agentMessages", { get: () => [{ role: "user", content: "b" }] });
		const factory = (target: ViewerTarget, send: (l: string[]) => void) =>
			new ViewerRenderer({ target, send, theme, keys, cwd: "/cwd", markdownTheme: getMarkdownTheme() });
		const server = makeServer(factory);
		server.register("a", targetOf(recordA));
		server.register("b", targetOf(recordB));
		const a = await hello(server, "a");
		const b = await hello(server, "b");
		await until(() => a.messages.length > 0 && b.messages.length > 0);
		const aBefore = a.messages.length;
		const bBefore = b.messages.length;
		messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id: "t", name: "mytool", arguments: {} }], stopReason: "toolUse", timestamp: 1 } as never,
		);
		broken.on = true;
		for (const l of [...listeners]) l();
		server.refresh("a");
		await settle();
		expect(a.messages.length).toBe(aBefore);
		(recordB as unknown as { agentMessages: unknown[] });
		server.refresh("b");
		a.send({ type: "wheel", delta: 1 });
		b.send({ type: "resize", cols: 70, rows: 20 });
		await until(() => b.messages.length > bBefore);
		expect(b.closed).toBe(false);
	});

	it("refresh reaches the renderer", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		await hello(server, "a");
		await until(() => fakes.length === 1);
		server.refresh("a");
		server.refresh("missing");
		expect(fakes[0].refresh).toHaveBeenCalledTimes(1);
	});

	it("unregister disposes the renderer", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const client = await hello(server, "a");
		await until(() => fakes.length === 1);
		server.unregister("a");
		expect(fakes[0].dispose).toHaveBeenCalledTimes(1);
		await until(() => client.closed);
	});

	it("reports no socket when the path is too long", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "hf-")), "x".repeat(120));
		const server = makeServer(fakeFactory, root);
		expect(await server.socketPath()).toBeUndefined();
	});

	it("close removes sockets, renderers and the directory", async () => {
		const server = makeServer();
		server.register("a", targetOf());
		const client = await hello(server, "a");
		await until(() => fakes.length === 1);
		const dir = dirname((await server.socketPath()) as string);
		await server.close();
		await server.close();
		expect(fakes[0].dispose).toHaveBeenCalledTimes(1);
		expect(existsSync(dir)).toBe(false);
		await until(() => client.closed);
	});
});
