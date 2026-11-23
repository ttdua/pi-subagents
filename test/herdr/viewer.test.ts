import { describe, expect, it } from "vitest";
import { parseArgs, renderEntry, splitLines } from "#src/herdr/viewer";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, ""));

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message",
	id: "m1",
	message: { role, content, ...extra },
});

describe("parseArgs", () => {
	it("parses the full viewer CLI", () => {
		const argv = ["--file", "/s.jsonl", "--status", "/st.json", "--pid", "42", "--parent-terminal", "t1", "--title", "Explore · find x"];
		expect(parseArgs(argv)).toEqual({ file: "/s.jsonl", status: "/st.json", pid: 42, parentTerminal: "t1", title: "Explore · find x" });
	});

	it("leaves parentTerminal undefined when absent", () => {
		expect(parseArgs(["--file", "/s", "--status", "/st", "--pid", "1", "--title", "x"]).parentTerminal).toBeUndefined();
	});

	it("throws when --file is missing", () => {
		expect(() => parseArgs(["--status", "/st", "--pid", "1", "--title", "x"])).toThrow(/--file/);
	});

	it("throws when --pid is not a positive integer", () => {
		expect(() => parseArgs(["--file", "/s", "--status", "/st", "--pid", "abc", "--title", "x"])).toThrow(/--pid/);
	});
});

describe("splitLines", () => {
	it("keeps an incomplete trailing line", () => {
		expect(splitLines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
	});

	it("returns every line when the buffer ends with a newline and drops blank lines", () => {
		expect(splitLines("a\n\nb\r\n")).toEqual({ lines: ["a", "b"], rest: "" });
	});
});

describe("renderEntry", () => {
	it("renders user text as a prompt line", () => {
		expect(plain(renderEntry(message("user", [{ type: "text", text: "hi" }])))).toEqual(["> hi"]);
	});

	it("renders user string content", () => {
		expect(plain(renderEntry(message("user", "hi")))).toEqual(["> hi"]);
	});

	it("renders assistant text as is", () => {
		expect(plain(renderEntry(message("assistant", [{ type: "text", text: "one\ntwo" }])))).toEqual(["one", "two"]);
	});

	it("renders a tool call with its JSON args", () => {
		const entry = message("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }]);
		expect(plain(renderEntry(entry))).toEqual(['-> read {"path":"x"}']);
	});

	it("truncates tool call args to 120 chars", () => {
		const entry = message("assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "y".repeat(300) } }]);
		const [line] = plain(renderEntry(entry));
		expect(line.startsWith("-> bash ")).toBe(true);
		expect(line.slice("-> bash ".length).length).toBeLessThanOrEqual(121);
		expect(line.slice("-> bash ".length, "-> bash ".length + 120)).toBe(JSON.stringify({ command: "y".repeat(300) }).slice(0, 120));
	});

	it("truncates tool results to 8 lines with a remainder count", () => {
		const text = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
		const entry = message("toolResult", [{ type: "text", text }], { toolCallId: "c1", toolName: "read", isError: false });
		expect(plain(renderEntry(entry))).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "(+4 lines)"]);
	});

	it("truncates thinking to 3 lines", () => {
		const entry = message("assistant", [{ type: "thinking", thinking: "a\nb\nc\nd\ne" }]);
		expect(plain(renderEntry(entry))).toHaveLength(3);
		expect(plain(renderEntry(entry))[0]).toContain("a");
	});

	it("renders compaction as one line", () => {
		expect(renderEntry({ type: "compaction", summary: "long\nsummary" })).toHaveLength(1);
	});

	it.each([
		{ type: "session", version: 3, id: "s", cwd: "/" },
		{ type: "model_change", provider: "x" },
		{ type: "something_new" },
		null,
		"text",
	])("renders nothing for %j", (entry) => {
		expect(renderEntry(entry)).toEqual([]);
	});
});
