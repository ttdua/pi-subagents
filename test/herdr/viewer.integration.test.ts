import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeMessage, type ViewerMessage } from "#src/herdr/frame-protocol";
import { RESTORE } from "#src/herdr/viewer";

const SRC = path.resolve(import.meta.dirname, "../../src/herdr");
const VIEWER = path.join(SRC, "viewer.ts");
const ANSI = /\x1b\[[0-9;]*m/g;
const TEST_TIMEOUT_MS = 6000;

interface Viewer {
	proc: ChildProcess;
	raw(): string;
	output(): string;
	waitForOutput(text: string, ms: number): Promise<void>;
	waitForExit(ms: number): Promise<number | null>;
}

interface Channel {
	sock: string;
	messages: ViewerMessage[];
	socket(): net.Socket | undefined;
	waitFor(match: (m: ViewerMessage) => boolean, ms?: number): Promise<ViewerMessage>;
	send(raw: string): void;
}

let dir: string;
const spawned: ChildProcess[] = [];
const servers: net.Server[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlive = (proc: ChildProcess) => proc.exitCode === null && proc.signalCode === null;
const track = (proc: ChildProcess): ChildProcess => {
	spawned.push(proc);
	return proc;
};

function listen(): Promise<Channel> {
	const sock = path.join(dir, "v.sock");
	const messages: ViewerMessage[] = [];
	let current: net.Socket | undefined;
	const server = net.createServer((s) => {
		current = s;
		let buf = "";
		s.setEncoding("utf8");
		s.on("error", () => {});
		s.on("data", (d: string) => {
			buf += d;
			const parts = buf.split("\n");
			buf = parts.pop() ?? "";
			for (const p of parts) if (p) messages.push(JSON.parse(p));
		});
	});
	servers.push(server);
	return new Promise((resolve) =>
		server.listen(sock, () =>
			resolve({
				sock,
				messages,
				socket: () => current,
				send: (raw) => void current?.write(raw),
				waitFor: async (match, ms = 3000) => {
					const started = Date.now();
					for (;;) {
						const found = messages.find(match);
						if (found) return found;
						if (Date.now() - started > ms) throw new Error(`timed out; messages: ${JSON.stringify(messages)}`);
						await sleep(20);
					}
				},
			}),
		),
	);
}

function startViewer(
	sock: string,
	opts: { pid?: number; env?: Record<string, string>; parentTerminal?: string; script?: string; cwd?: string } = {},
): Viewer {
	const args = [opts.script ?? VIEWER, "--socket", sock, "--key", "k1", "--pid", String(opts.pid ?? process.pid)];
	if (opts.parentTerminal) args.push("--parent-terminal", opts.parentTerminal);
	const proc = track(spawn(process.execPath, args, { stdio: "pipe", cwd: opts.cwd, env: { ...process.env, HC_TERMINAL_ID: "", ...opts.env } }));
	let out = "";
	proc.stdout?.on("data", (c: Buffer) => {
		out += c.toString("utf8");
	});
	proc.stderr?.on("data", (c: Buffer) => {
		out += c.toString("utf8");
	});
	const output = () => out.replace(ANSI, "");
	const waitForOutput = async (text: string, ms: number) => {
		const started = Date.now();
		while (!output().includes(text)) {
			if (Date.now() - started > ms) throw new Error(`timed out waiting for ${JSON.stringify(text)}; output: ${JSON.stringify(out)}`);
			await sleep(20);
		}
	};
	const waitForExit = (ms: number) =>
		new Promise<number | null>((resolve, reject) => {
			if (proc.exitCode !== null) return resolve(proc.exitCode);
			const timer = setTimeout(() => reject(new Error("viewer did not exit")), ms);
			proc.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	return { proc, raw: () => out, output, waitForOutput, waitForExit };
}

const frame = (...lines: string[]) => encodeMessage({ type: "frame", lines });

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "hv-"));
});

afterEach(async () => {
	for (const proc of spawned.splice(0)) if (isAlive(proc)) proc.kill("SIGKILL");
	for (const s of servers.splice(0)) {
		await new Promise((r) => s.close(r));
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("viewer program", () => {
	it(
		"sends hello with key and size",
		async () => {
			const ch = await listen();
			startViewer(ch.sock);
			const hello = await ch.waitFor((m) => m.type === "hello");
			expect(hello).toMatchObject({ type: "hello", key: "k1" });
			expect((hello as { cols: number }).cols).toBeGreaterThan(0);
			expect((hello as { rows: number }).rows).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"paints received frames sanitized",
		async () => {
			const ch = await listen();
			const v = startViewer(ch.sock);
			await ch.waitFor((m) => m.type === "hello");
			ch.send(frame("\x1b]0;evil\x07ok"));
			await v.waitForOutput("ok", 2000);
			expect(v.output()).not.toContain("]0;evil");
			expect(v.raw()).not.toContain("\x1b]0;");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"forwards typed keys as input",
		async () => {
			const ch = await listen();
			const v = startViewer(ch.sock);
			await ch.waitFor((m) => m.type === "hello");
			v.proc.stdin?.write("abc");
			await ch.waitFor((m) => m.type === "input" && m.data.includes("abc"));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"forwards wheel as wheel",
		async () => {
			const ch = await listen();
			const v = startViewer(ch.sock);
			await ch.waitFor((m) => m.type === "hello");
			v.proc.stdin?.write("\x1b[<65;3;4M");
			const m = await ch.waitFor((x) => x.type === "wheel");
			expect(m).toMatchObject({ type: "wheel", delta: 3 });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"splits a large paste into capped input messages",
		async () => {
			const ch = await listen();
			const v = startViewer(ch.sock);
			await ch.waitFor((m) => m.type === "hello");
			const paste = "x".repeat(10000);
			v.proc.stdin?.write(paste);
			const joined = () => ch.messages.flatMap((m) => (m.type === "input" ? [m.data] : [])).join("");
			const started = Date.now();
			while (joined().length < paste.length && Date.now() - started < 3000) await sleep(20);
			expect(joined()).toBe(paste);
			for (const m of ch.messages) if (m.type === "input") expect(m.data.length).toBeLessThanOrEqual(4096);
			expect(isAlive(v.proc)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	describe("restores the terminal and exits", () => {
		const expectRestored = async (v: Viewer) => {
			expect(await v.waitForExit(2000)).toBe(0);
			expect(v.raw().endsWith(RESTORE)).toBe(true);
		};

		it(
			"when the channel closes",
			async () => {
				const ch = await listen();
				const v = startViewer(ch.sock);
				await ch.waitFor((m) => m.type === "hello");
				ch.socket()?.end();
				await expectRestored(v);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"when the channel errors",
			async () => {
				const ch = await listen();
				const v = startViewer(ch.sock);
				await ch.waitFor((m) => m.type === "hello");
				ch.socket()?.destroy(new Error("boom"));
				await expectRestored(v);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"on an oversized frame line",
			async () => {
				const ch = await listen();
				const v = startViewer(ch.sock);
				await ch.waitFor((m) => m.type === "hello");
				const chunk = "a".repeat(1 << 20);
				const s = ch.socket();
				for (let i = 0; i < 5 && s && !s.destroyed; i++) s.write(chunk);
				await expectRestored(v);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"on SIGTERM",
			async () => {
				const ch = await listen();
				const v = startViewer(ch.sock);
				await ch.waitFor((m) => m.type === "hello");
				v.proc.kill("SIGTERM");
				await expectRestored(v);
			},
			TEST_TIMEOUT_MS,
		);
	});

	it(
		"Pi process gone",
		async () => {
			const ch = await listen();
			const pi = track(spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], { stdio: "ignore" }));
			const v = startViewer(ch.sock, { pid: pi.pid });
			await ch.waitFor((m) => m.type === "hello");
			await new Promise((r) => (pi.exitCode !== null ? r(null) : pi.once("exit", r)));
			expect(await v.waitForExit(2000)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"starts without Pi packages",
		async () => {
			const iso = mkdtempSync(path.join(tmpdir(), "hv-"));
			try {
				copyFileSync(VIEWER, path.join(iso, "viewer.ts"));
				copyFileSync(path.join(SRC, "frame-protocol.ts"), path.join(iso, "frame-protocol.ts"));
				const ch = await listen();
				const env = { NODE_PATH: "" } as Record<string, string>;
				const v = startViewer(ch.sock, { script: path.join(iso, "viewer.ts"), cwd: iso, env });
				await ch.waitFor((m) => m.type === "hello");
				ch.send(frame("isolated-ok"));
				await v.waitForOutput("isolated-ok", 2000);
			} finally {
				rmSync(iso, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps own terminal keep off on exit",
		async () => {
			const bin = path.join(dir, "bin");
			const callLog = path.join(dir, "hc-calls.log");
			mkdirSync(bin);
			writeFileSync(path.join(bin, "hc"), `#!/bin/sh\necho "$@" >> "${callLog}"\n`);
			chmodSync(path.join(bin, "hc"), 0o755);
			const ch = await listen();
			const v = startViewer(ch.sock, {
				env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HC_TERMINAL_ID: "tv1" },
				parentTerminal: "tp1",
			});
			await ch.waitFor((m) => m.type === "hello");
			ch.socket()?.end();
			expect(await v.waitForExit(2000)).toBe(0);
			expect(readFileSync(callLog, "utf8").trim()).toBe("keep tv1 --off");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"skips keep off when its id equals the parent terminal",
		async () => {
			const bin = path.join(dir, "bin");
			const callLog = path.join(dir, "hc-calls.log");
			mkdirSync(bin);
			writeFileSync(path.join(bin, "hc"), `#!/bin/sh\necho "$@" >> "${callLog}"\n`);
			chmodSync(path.join(bin, "hc"), 0o755);
			const ch = await listen();
			const v = startViewer(ch.sock, {
				env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HC_TERMINAL_ID: "tp1" },
				parentTerminal: "tp1",
			});
			await ch.waitFor((m) => m.type === "hello");
			ch.socket()?.end();
			expect(await v.waitForExit(2000)).toBe(0);
			expect(existsSync(callLog)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
