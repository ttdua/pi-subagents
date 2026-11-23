import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const VIEWER = path.resolve(import.meta.dirname, "../../src/herdr/viewer.ts");
const ANSI = /\x1b\[[0-9;]*m/g;
const TEST_TIMEOUT_MS = 6000;

const userEntry = (text: string) => `${JSON.stringify({ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const assistantEntry = (text: string) =>
	`${JSON.stringify({ type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

interface Viewer {
	proc: ChildProcess;
	output(): string;
	waitForOutput(text: string, ms: number): Promise<void>;
	waitForExit(ms: number): Promise<number | null>;
}

let dir: string;
let file: string;
let status: string;
const spawned: ChildProcess[] = [];

function track(proc: ChildProcess): ChildProcess {
	spawned.push(proc);
	return proc;
}

function startViewer(opts: { pid?: number; env?: Record<string, string>; parentTerminal?: string } = {}): Viewer {
	const args = [VIEWER, "--file", file, "--status", status, "--pid", String(opts.pid ?? process.pid), "--title", "Explore · test"];
	if (opts.parentTerminal) args.push("--parent-terminal", opts.parentTerminal);
	const proc = track(spawn(process.execPath, args, { stdio: "pipe", env: { ...process.env, HC_TERMINAL_ID: "", ...opts.env } }));
	let out = "";
	proc.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	const output = () => out.replace(ANSI, "");
	const waitForOutput = (text: string, ms: number) =>
		new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const tick = setInterval(() => {
				if (output().includes(text)) {
					clearInterval(tick);
					resolve();
				} else if (Date.now() - started > ms) {
					clearInterval(tick);
					reject(new Error(`timed out waiting for ${JSON.stringify(text)}; output: ${JSON.stringify(output())}`));
				}
			}, 20);
		});
	const waitForExit = (ms: number) =>
		new Promise<number | null>((resolve, reject) => {
			if (proc.exitCode !== null) return resolve(proc.exitCode);
			const timer = setTimeout(() => reject(new Error("viewer did not exit")), ms);
			proc.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	return { proc, output, waitForOutput, waitForExit };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlive = (proc: ChildProcess) => proc.exitCode === null && proc.signalCode === null;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "herdr-viewer-"));
	file = path.join(dir, "session.jsonl");
	status = path.join(dir, "status.json");
});

afterEach(() => {
	for (const proc of spawned.splice(0)) if (isAlive(proc)) proc.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

describe("viewer program", () => {
	it(
		"File appears later",
		async () => {
			const v = startViewer();
			await v.waitForOutput("Explore · test", 1000);
			await sleep(200);
			writeFileSync(file, userEntry("hello"));
			await v.waitForOutput("> hello", 1000);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Follows appended entries",
		async () => {
			writeFileSync(file, userEntry("start"));
			const v = startViewer();
			await v.waitForOutput("> start", 1000);
			appendFileSync(file, assistantEntry("appended answer"));
			await v.waitForOutput("appended answer", 1000);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"prints a line only once it is complete",
		async () => {
			writeFileSync(file, userEntry("start"));
			const v = startViewer();
			await v.waitForOutput("> start", 1000);
			const line = assistantEntry("split entry");
			appendFileSync(file, line.slice(0, 20));
			await sleep(700);
			expect(v.output()).not.toContain("split entry");
			appendFileSync(file, line.slice(20));
			await v.waitForOutput("split entry", 1000);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Unparsable line",
		async () => {
			writeFileSync(file, `not json\n${assistantEntry("valid entry")}`);
			const v = startViewer();
			await v.waitForOutput("valid entry", 1000);
			expect(isAlive(v.proc)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Input is discarded",
		async () => {
			writeFileSync(file, userEntry("start"));
			const v = startViewer();
			await v.waitForOutput("> start", 1000);
			v.proc.stdin?.write("abc\r");
			await sleep(500);
			expect(isAlive(v.proc)).toBe(true);
			expect(v.output()).not.toContain("abc");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reprints after the transcript is rewritten",
		async () => {
			writeFileSync(file, userEntry("first long entry with padding ".repeat(4)));
			const v = startViewer();
			await v.waitForOutput("> first", 1000);
			writeFileSync(file, userEntry("new"));
			await v.waitForOutput("(transcript rewritten)", 1000);
			await v.waitForOutput("> new", 1000);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"prints a bare done when the status carries no run status",
		async () => {
			const v = startViewer();
			await v.waitForOutput("Explore · test", 1000);
			writeFileSync(status, JSON.stringify({ state: "done" }));
			await v.waitForOutput("done", 1000);
			expect(v.output()).not.toContain("done (");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"prints status changes once and ignores half-written status",
		async () => {
			const v = startViewer();
			await v.waitForOutput("Explore · test", 1000);
			writeFileSync(status, JSON.stringify({ state: "done", status: "completed" }));
			await v.waitForOutput("done (completed)", 1000);
			writeFileSync(status, '{"state":"runn');
			await sleep(700);
			expect(v.output()).not.toContain("running again");
			writeFileSync(status, JSON.stringify({ state: "running" }));
			await v.waitForOutput("running again", 1000);
			await sleep(700);
			expect(v.output().match(/done \(completed\)/g)).toHaveLength(1);
			expect(v.output().match(/running again/g)).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Pi process gone",
		async () => {
			const pi = track(spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], { stdio: "ignore" }));
			const v = startViewer({ pid: pi.pid });
			await v.waitForOutput("Explore · test", 1000);
			await new Promise((r) => (pi.exitCode !== null ? r(null) : pi.once("exit", r)));
			expect(await v.waitForExit(2000)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	describe("own keep off on parent exit", () => {
		let callLog: string;
		let fakeEnv: Record<string, string>;

		beforeEach(() => {
			const bin = path.join(dir, "bin");
			callLog = path.join(dir, "hc-calls.log");
			const hc = path.join(bin, "hc");
			mkdirSync(bin);
			writeFileSync(hc, `#!/bin/sh\necho "$@" >> "${callLog}"\n`);
			chmodSync(hc, 0o755);
			fakeEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
		});

		const exitedPi = async () => {
			const pi = track(spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }));
			await new Promise((r) => (pi.exitCode !== null ? r(null) : pi.once("exit", r)));
			return pi.pid;
		};

		it(
			"turns its own keep off before exiting",
			async () => {
				const v = startViewer({ pid: await exitedPi(), env: { ...fakeEnv, HC_TERMINAL_ID: "tv1" }, parentTerminal: "tp1" });
				expect(await v.waitForExit(2000)).toBe(0);
				expect(readFileSync(callLog, "utf8").trim()).toBe("keep tv1 --off");
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"skips keep off when its id equals the parent terminal",
			async () => {
				const v = startViewer({ pid: await exitedPi(), env: { ...fakeEnv, HC_TERMINAL_ID: "tp1" }, parentTerminal: "tp1" });
				expect(await v.waitForExit(2000)).toBe(0);
				expect(existsSync(callLog)).toBe(false);
			},
			TEST_TIMEOUT_MS,
		);
	});
});
