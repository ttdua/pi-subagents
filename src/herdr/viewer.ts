// Read-only transcript viewer that Herdr runs in its own terminal for one subagent.
// Runs outside Pi's loader (Node type stripping or Bun): node: built-ins and erasable syntax only.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export interface ViewerArgs {
	file: string;
	status: string;
	pid: number;
	parentTerminal: string | undefined;
	title: string;
}

const TOOL_ARGS_MAX_CHARS = 120;
const TOOL_RESULT_MAX_LINES = 8;
const THINKING_MAX_LINES = 3;
const COMPACTION_MAX_CHARS = 120;
const FILE_POLL_MS = 300;
const STATUS_POLL_MS = 500;
const PARENT_CHECK_MS = 1000;
const HC_TIMEOUT_MS = 800;

/** Drops control characters (except tab and newline) so untrusted transcript text cannot drive the terminal. */
export function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;

type Record_ = Record<string, unknown>;
const asRecord = (v: unknown): Record_ | undefined =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record_) : undefined;
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

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
		file: required(values, "file"),
		status: required(values, "status"),
		pid,
		parentTerminal: values.get("parent-terminal") || undefined,
		title: values.get("title") ?? "",
	};
}

export function splitLines(buffered: string): { lines: string[]; rest: string } {
	const parts = buffered.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim() !== "");
	return { lines, rest };
}

const textLines = (text: string): string[] => text.split("\n");

function truncateLines(lines: string[], max: number): string[] {
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `(+${lines.length - max} lines)`];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return sanitize(content);
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = asRecord(block);
			return b?.type === "text" ? sanitize(asString(b.text) ?? "") : "";
		})
		.filter((t) => t !== "")
		.join("\n");
}

function renderUser(content: unknown): string[] {
	const text = contentText(content);
	if (text === "") return [];
	const [first, ...more] = textLines(text);
	return [`> ${first}`, ...more];
}

function renderToolCall(block: Record_): string[] {
	const name = sanitize(asString(block.name) ?? "?");
	const args = sanitize(JSON.stringify(block.arguments ?? {}) ?? "");
	const shown = args.length > TOOL_ARGS_MAX_CHARS ? `${args.slice(0, TOOL_ARGS_MAX_CHARS)}…` : args;
	return [`-> ${name} ${shown}`];
}

function renderAssistantBlock(block: unknown): string[] {
	const b = asRecord(block);
	if (b?.type === "text") return textLines(sanitize(asString(b.text) ?? ""));
	if (b?.type === "thinking") {
		const lines = textLines(sanitize(asString(b.thinking) ?? "")).slice(0, THINKING_MAX_LINES);
		return lines.map(dim);
	}
	if (b?.type === "toolCall") return renderToolCall(b);
	return [];
}

function renderAssistant(content: unknown): string[] {
	if (typeof content === "string") return textLines(sanitize(content));
	if (!Array.isArray(content)) return [];
	return content.flatMap(renderAssistantBlock);
}

function renderToolResult(content: unknown): string[] {
	const text = contentText(content);
	if (text === "") return [];
	return truncateLines(textLines(text), TOOL_RESULT_MAX_LINES).map(dim);
}

function renderMessage(message: Record_ | undefined): string[] {
	switch (message?.role) {
		case "user":
			return renderUser(message.content);
		case "assistant":
			return renderAssistant(message.content);
		case "toolResult":
			return renderToolResult(message.content);
		default:
			return [];
	}
}

function renderCompaction(entry: Record_): string[] {
	const summary = sanitize(asString(entry.summary) ?? "").replace(/\s+/g, " ").trim();
	const shown = summary.length > COMPACTION_MAX_CHARS ? `${summary.slice(0, COMPACTION_MAX_CHARS)}…` : summary;
	return [dim(`(compacted) ${shown}`.trimEnd())];
}

export function renderEntry(entry: unknown): string[] {
	const e = asRecord(entry);
	if (e?.type === "message") return renderMessage(asRecord(e.message));
	if (e?.type === "compaction") return renderCompaction(e);
	return [];
}

// ---- main routine ----

function printLines(lines: string[]): void {
	if (lines.length === 0) return;
	try {
		process.stdout.write(`${lines.join("\n")}\n`);
	} catch {
		// The terminal is gone; nothing left to show.
	}
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function fileSize(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}

function readRange(file: string, start: number, end: number): Buffer {
	const buffer = Buffer.alloc(end - start);
	const fd = openSync(file, "r");
	try {
		const read = readSync(fd, buffer, 0, buffer.length, start);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** Follows a JSONL transcript by byte offset, printing each complete entry once. */
function followTranscript(file: string): () => void {
	let offset = 0;
	let rest = "";
	let decoder = new StringDecoder("utf8");
	return () => {
		const size = fileSize(file);
		if (size === undefined) return;
		if (size < offset) {
			offset = 0;
			rest = "";
			decoder = new StringDecoder("utf8");
			printLines([dim("(transcript rewritten)")]);
		}
		if (size === offset) return;
		let chunk: Buffer;
		try {
			chunk = readRange(file, offset, size);
		} catch {
			return;
		}
		offset += chunk.length;
		const split = splitLines(rest + decoder.write(chunk));
		rest = split.rest;
		printLines(split.lines.flatMap((line) => renderEntry(parseLine(line))));
	};
}

function readStatusLabel(file: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const status = asRecord(parseLine(text));
	if (status?.state === "running") return "running";
	if (status?.state === "done") {
		const finished = asString(status.status);
		return finished === undefined ? "done" : `done (${sanitize(finished)})`;
	}
	return undefined;
}

/** Prints one line per status change; the initial "running" state is silent. */
function watchStatus(file: string): () => void {
	let last: string | undefined;
	return () => {
		const label = readStatusLabel(file);
		if (label === undefined || label === last) return;
		const first = last === undefined;
		last = label;
		if (label === "running") {
			if (!first) printLines([dim("running again")]);
		} else {
			printLines([dim(label)]);
		}
	};
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

function watchParent(pid: number, parentTerminal: string | undefined): () => void {
	return () => {
		if (isProcessAlive(pid)) return;
		keepOwnTerminalOff(parentTerminal);
		process.exit(0);
	};
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

/** Read-only: every key typed into the viewer is swallowed. */
function discardInput(): void {
	const stdin = process.stdin;
	enableRawMode(stdin);
	stdin.on("data", () => {});
	stdin.on("error", () => {});
	stdin.resume();
}

function every(ms: number, tick: () => void): void {
	tick();
	setInterval(tick, ms);
}

function main(argv: string[]): void {
	const args = parseArgs(argv);
	printLines([`\x1b[1m${sanitize(args.title)}\x1b[22m`]);
	discardInput();
	every(FILE_POLL_MS, followTranscript(args.file));
	every(STATUS_POLL_MS, watchStatus(args.status));
	setInterval(watchParent(args.pid, args.parentTerminal), PARENT_CHECK_MS);
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
