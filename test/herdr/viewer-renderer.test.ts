import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMarkdownTheme, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, Text, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_INTERVAL_MS, ViewerRenderer, type ViewerRendererOptions, viewerStatusLabel } from "#src/herdr/viewer-renderer";
import { SwitchableSource, type ViewerTarget } from "#src/herdr/viewer-source";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { AgentSessionEvent, SessionMessage } from "#src/types";
import { type EntryHeading, fileSnapshotSource, liveSource, type NavigableSubagent } from "#src/ui/session-navigation";
import { type PaneKeys, TranscriptPane } from "#src/ui/session-navigator";
import { makeNavigable } from "#test/helpers/make-navigable";
import { mockTui } from "#test/helpers/transcript-fixtures";

beforeAll(() => initTheme(undefined, false));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const heading: EntryHeading = { name: "Explore", modeLabel: undefined, description: "Find auth files" };
const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	getThinkingBorderColor: () => (t: string) => t,
};
const keysWith = (overrides = {}): PaneKeys =>
	new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.top": "home", "tui.altScreen.bottom": "end", ...overrides });

const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
const user = (content: string) => ({ role: "user", content }) as unknown as SessionMessage;
const rowsOf = (n: number) => user(Array.from({ length: n }, (_, i) => `r${String(i).padStart(3, "0")}`).join("\n"));
const assistantEvent = (text: string, type = "message_update") =>
	({ type, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } }) as unknown as AgentSessionEvent;
const toolEvent = (n: number) => ({ type: "tool_execution_start", toolCallId: String(n), toolName: "t", args: {} }) as unknown as AgentSessionEvent;
const settledEvent = () => ({ type: "message_end" }) as unknown as AgentSessionEvent;

interface FakeRecord extends NavigableSubagent {
	messages: SessionMessage[];
	emit(e?: AgentSessionEvent): void;
	setStatus(s: SubagentStatus): void;
}

function fakeRecord(init: { status?: SubagentStatus; messages?: SessionMessage[]; tools?: Record<string, ToolDefinition>; outputFile?: string; ready?: boolean } = {}): FakeRecord {
	const listeners = new Set<(e: AgentSessionEvent) => void>();
	const state = { status: init.status ?? "completed", ready: init.ready ?? true };
	const record = {
		...makeNavigable({
			outputFile: init.outputFile,
			isSessionReady: () => state.ready,
			subscribeToUpdates: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			getToolDefinition: (name) => init.tools?.[name],
		}),
		messages: init.messages ?? [],
		emit: (e?: AgentSessionEvent) => {
			for (const l of [...listeners]) l(e as AgentSessionEvent);
		},
		setStatus: (s: SubagentStatus) => {
			state.status = s;
		},
	};
	Object.defineProperty(record, "status", { get: () => state.status });
	Object.defineProperty(record, "agentMessages", { get: () => record.messages });
	return record as unknown as FakeRecord;
}

function setup(target: ViewerTarget, o: Partial<ViewerRendererOptions> = {}, size = [80, 20]) {
	const frames: string[][] = [];
	const renderer = new ViewerRenderer({
		target,
		send: (l) => frames.push(l),
		theme,
		keys: keysWith(),
		cwd: "/cwd",
		markdownTheme: getMarkdownTheme(),
		...o,
	});
	renderer.resize(size[0], size[1]);
	vi.advanceTimersByTime(FRAME_INTERVAL_MS);
	const text = () => stripAnsi((frames.at(-1) ?? []).join("\n"));
	return { renderer, frames, text, last: () => frames.at(-1) ?? [] };
}
const recordTarget = (record: NavigableSubagent): ViewerTarget => ({ kind: "record", record, heading });
const tick = () => vi.advanceTimersByTime(FRAME_INTERVAL_MS);

/** A docked pane on the same record, with a viewport as tall as the renderer's. */
function dockedPane(source: ConstructorParameters<typeof TranscriptPane>[0]["source"], fillRows: number) {
	const rows = Math.ceil(fillRows / 0.7);
	const tui = mockTui(rows, 80);
	const pane = new TranscriptPane({ tui, theme, keys: keysWith(), source, heading, done: vi.fn(), cwd: "/cwd", markdownTheme: getMarkdownTheme() });
	return pane;
}

const callTool = (renderCall: ToolDefinition["renderCall"], renderResult?: ToolDefinition["renderResult"]) =>
	({ name: "mytool", label: "mytool", description: "d", parameters: {}, execute: async () => ({}), renderCall, renderResult }) as unknown as ToolDefinition;
const toolCallMessages = (): SessionMessage[] =>
	[
		{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "mytool", arguments: {} }], stopReason: "toolUse", timestamp: 1 },
		{ role: "toolResult", toolCallId: "tc1", toolName: "mytool", content: [{ type: "text", text: "x" }], isError: false },
	] as unknown as SessionMessage[];

describe("viewerStatusLabel", () => {
	it("labels each state", () => {
		expect(viewerStatusLabel("running", false)).toBe("running");
		expect(viewerStatusLabel("queued", false)).toBe("running");
		expect(viewerStatusLabel("running", true)).toBe("running again");
		expect(viewerStatusLabel("completed", true)).toBe("done (completed)");
		expect(viewerStatusLabel(undefined, false)).toBe("done");
	});
});

describe("ViewerRenderer", () => {
	it("matches the pane's header and transcript rows", () => {
		const record = fakeRecord({ messages: [rowsOf(100)] });
		const { renderer, last } = setup(recordTarget(record), {}, [80, 14]);
		
		const pane = dockedPane(liveSource(record), 14);
		const expected = pane.render(80);
		expect(last()).toHaveLength(14);
		expect(last().slice(0, -1)).toEqual(expected.slice(0, -1));
		for (let i = 0; i < 5; i++) renderer.input("\x1b[A");
		for (let i = 0; i < 5; i++) pane.handleInput("\x1b[A");
		tick();
		expect(last().slice(0, -1)).toEqual(pane.render(80).slice(0, -1));
	});

	it("renders markdown", () => {
		const record = fakeRecord({ messages: [{ role: "assistant", content: [{ type: "text", text: "# Title\n\n- item\n\n```ts\nconst answer = 42;\n```" }], stopReason: "stop", timestamp: 1 } as unknown as SessionMessage] });
		const { text, last } = setup(recordTarget(record));
		expect(text()).toContain("Title");
		expect(text()).toContain("item");
		expect(text()).toContain("answer");
		for (const row of last().map(stripAnsi)) {
			expect(row).not.toContain("# Title");
		}
	});

	it("shows the streaming tail within one second", () => {
		const record = fakeRecord({ status: "running" });
		const { text } = setup(recordTarget(record));
		record.emit(assistantEvent("partial words"));
		tick();
		expect(text()).toContain("partial words");
		expect(text().split("\n").some((r) => /\S/.test(r) && !r.includes("partial words") && /…|\.\.\.|writing|generating|thinking|working|Running|running/i.test(r))).toBe(true);
	});

	it("uses live call and result renderers", () => {
		const record = fakeRecord({
			messages: toolCallMessages(),
			tools: { mytool: callTool(() => new Text("CALL", 0, 0), () => new Text("RESULT", 0, 0)) },
		});
		const { text } = setup(recordTarget(record));
		expect(text()).toContain("CALL");
		expect(text()).toContain("RESULT");
	});

	it("does not run tool renderers inside a source callback", () => {
		const renderCall = vi.fn(() => new Text("CALL", 0, 0));
		const renderResult = vi.fn(() => new Text("RESULT", 0, 0));
		const record = fakeRecord({ status: "running", tools: { mytool: callTool(renderCall, renderResult) } });
		const { text } = setup(recordTarget(record));
		const [call, result] = toolCallMessages();
		record.messages = [call as SessionMessage];
		record.emit({ type: "message_end" } as unknown as AgentSessionEvent);
		record.messages = [call, result] as SessionMessage[];
		record.emit({ type: "message_end" } as unknown as AgentSessionEvent);
		expect(renderCall).not.toHaveBeenCalled();
		expect(renderResult).not.toHaveBeenCalled();
		tick();
		expect(renderCall).toHaveBeenCalled();
		expect(text()).toContain("CALL");
	});

	it("renders a file-backed tool call like a file-backed pane", () => {
		const dir = mkdtempSync(join(tmpdir(), "vr-"));
		const file = join(dir, "s.jsonl");
		const header = { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/" };
		const entries = [
			{ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "go", timestamp: 1 } },
			{ type: "message", id: "2", parentId: "1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/x.ts" } }], stopReason: "toolUse", timestamp: 2 } },
			{ type: "message", id: "3", parentId: "2", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3 } },
		];
		writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n"));
		const { renderer, last } = setup({ kind: "file", outputFile: file, heading }, {}, [80, 14]);
		
		const pane = dockedPane(fileSnapshotSource(file, (p: string) => readFileSync(p, "utf8")), 14);
		expect(last().slice(0, -1)).toEqual(pane.render(80).slice(0, -1));
		expect(last().map(stripAnsi).join("\n")).toContain("file body");
		renderer.dispose();
	});

	it("follows, stops when scrolled up, resumes at bottom", () => {
		const record = fakeRecord({ status: "running", messages: [rowsOf(100)] });
		const { renderer, text } = setup(recordTarget(record));
		expect(text()).toContain("r099");
		renderer.input("\x1b[A");
		tick();
		record.messages = [rowsOf(120)];
		record.emit(settledEvent());
		tick();
		expect(text()).not.toContain("r119");
		renderer.input("\x1b[F");
		tick();
		expect(text()).toContain("r119");
		record.messages = [rowsOf(130)];
		record.emit(settledEvent());
		tick();
		expect(text()).toContain("r129");
	});

	it("keys and wheel repaint a static source", () => {
		const record = fakeRecord({ messages: [rowsOf(100)] });
		const { renderer, frames } = setup(recordTarget(record));
		const row = () => stripAnsi(frames.at(-1)?.[1] ?? "");
		const before = row();
		renderer.input("\x1b[A");
		tick();
		const afterKey = row();
		expect(afterKey).not.toBe(before);
		renderer.wheel(-3);
		tick();
		expect(row()).not.toBe(afterKey);
	});

	it("remapped page up scrolls", () => {
		const record = fakeRecord({ messages: [rowsOf(100)] });
		const { renderer, frames } = setup(recordTarget(record), { keys: keysWith({ "tui.altScreen.pageUp": "ctrl+u" }) });
		const before = frames.at(-1)?.[1];
		renderer.input("\x15");
		tick();
		expect(frames.at(-1)?.[1]).not.toBe(before);
	});

	it("ignores close keys and text", () => {
		const record = fakeRecord({ messages: [rowsOf(100)] });
		const { renderer, frames } = setup(recordTarget(record));
		const sent = frames.length;
		const before = frames.at(-1);
		renderer.input("\x1b");
		vi.advanceTimersByTime(200);
		renderer.input("q");
		renderer.input("hello\r");
		vi.advanceTimersByTime(200);
		expect(frames.at(-1)).toEqual(before);
		expect(frames.length).toBe(sent);
	});

	it("status labels", () => {
		const record = fakeRecord({ status: "running", messages: [rowsOf(3)] });
		const { renderer, text } = setup(recordTarget(record));
		const footer = () => text().split("\n").at(-1) ?? "";
		expect(footer()).toContain("running");
		expect(footer()).not.toContain("again");
		record.setStatus("completed");
		renderer.refresh();
		tick();
		expect(footer()).toContain("done (completed)");
		record.setStatus("running");
		renderer.refresh();
		tick();
		expect(footer()).toContain("running again");
	});

	it("labels a file target done", () => {
		const { text } = setup({ kind: "file", outputFile: "/nonexistent/x.jsonl", heading });
		expect((text().split("\n").at(-1) ?? "")).toContain("done");
	});

	it("switches live to file and back on one renderer", () => {
		const dir = mkdtempSync(join(tmpdir(), "vr-"));
		const file = join(dir, "s.jsonl");
		const header = { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/" };
		const lines = Array.from({ length: 60 }, (_, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: `file-row-${i}`, timestamp: 1 } }));
		writeFileSync(file, [header, ...lines].map((e) => JSON.stringify(e)).join("\n"));
		const renderCall = vi.fn(() => new Text("CALL", 0, 0));
		const record = fakeRecord({ messages: [rowsOf(100)], outputFile: file, tools: { mytool: callTool(renderCall) } });
		const { renderer, text } = setup(recordTarget(record));
		for (let i = 0; i < 5; i++) renderer.input("\x1b[A");
		tick();
		expect(text()).toContain("r0");
		(record as { isSessionReady: () => boolean }).isSessionReady = () => false;
		renderer.refresh();
		tick();
		expect(text()).toContain("file-row-");
		expect(text()).not.toContain("r099");
		expect(renderCall).not.toHaveBeenCalled();
		(record as { isSessionReady: () => boolean }).isSessionReady = () => true;
		renderer.refresh();
		tick();
		expect(text()).toContain("r0");
	});

	it("re-flows on resize", () => {
		const long = user("word ".repeat(40));
		const record = fakeRecord({ messages: [long] });
		const { renderer, last } = setup(recordTarget(record), {}, [80, 30]);
		const wide = last().filter((r) => stripAnsi(r).includes("word")).length;
		renderer.resize(40, 20);
		tick();
		expect(last()).toHaveLength(20);
		expect(last().filter((r) => stripAnsi(r).includes("word")).length).toBeGreaterThan(wide);
	});

	it("coalesces frames to one per 50 ms", () => {
		const record = fakeRecord({ status: "running" });
		const { frames, renderer } = setup(recordTarget(record));
		const sent = frames.length;
		for (let i = 0; i < 10; i++) {
			record.emit(assistantEvent(`p${i}`));
			renderer.wheel(1);
		}
		vi.advanceTimersByTime(FRAME_INTERVAL_MS - 1);
		expect(frames.length).toBe(sent);
		vi.advanceTimersByTime(1);
		expect(frames.length).toBe(sent + 1);
	});

	it("refresh does no source work before the frame turn", () => {
		const record = fakeRecord({ messages: [rowsOf(3)] });
		const target = recordTarget(record);
		const source = new SwitchableSource(target);
		const refresh = vi.spyOn(source, "refresh");
		const { renderer } = setup(target, { source });
		refresh.mockClear();
		renderer.refresh();
		expect(refresh).not.toHaveBeenCalled();
		tick();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("keeps a still-streaming message after an overflow", () => {
		const record = fakeRecord({ status: "running" });
		const { text } = setup(recordTarget(record));
		record.emit(assistantEvent("PARTIAL-TEXT"));
		for (let i = 0; i < 300; i++) record.emit(toolEvent(i));
		tick();
		expect(text()).toContain("PARTIAL-TEXT");
	});

	it("recovers rows after a queue overflow", () => {
		const record = fakeRecord({ status: "running" });
		const { renderer, last } = setup(recordTarget(record), {}, [80, 14]);
		record.emit(assistantEvent("STREAMED"));
		for (let i = 0; i < 300; i++) record.emit(toolEvent(i));
		record.messages = [{ role: "assistant", content: [{ type: "text", text: "STREAMED" }], stopReason: "stop", timestamp: 1 } as unknown as SessionMessage, user(Array.from({ length: 3 }, (_, i) => `next-${i}`).join("\n"))];
		record.setStatus("completed");
		record.emit(settledEvent());
		renderer.refresh();
		tick();
		
		const pane = dockedPane(liveSource(record), 14);
		const nonEmpty = (rows: string[]) => rows.slice(0, -1).filter((r) => r !== "");
		expect(nonEmpty(last())).toEqual(nonEmpty(pane.render(80)));
		expect(last().map(stripAnsi).filter((r) => r.includes("STREAMED"))).toHaveLength(1);
	});

	it("shows live messages without a session file", () => {
		const record = fakeRecord({ messages: [user("live message text")], outputFile: "/nonexistent/s.jsonl" });
		expect(setup(recordTarget(record)).text()).toContain("live message text");
	});

	it("shows a file that appears later within one second", () => {
		const dir = mkdtempSync(join(tmpdir(), "vr-"));
		const file = join(dir, "later.jsonl");
		const { text } = setup({ kind: "file", outputFile: file, heading });
		const header = { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/" };
		const entry = { type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "late entry", timestamp: 1 } };
		writeFileSync(file, [header, entry].map((e) => JSON.stringify(e)).join("\n"));
		vi.advanceTimersByTime(400);
		expect(text()).toContain("late entry");
	});

	it("keeps the last frame when render throws", () => {
		const failing = callTool(() => ({ render: () => { throw new Error("boom"); }, invalidate: () => {} }) as never);
		const record = fakeRecord({ status: "running", tools: { mytool: failing } });
		const { frames } = setup(recordTarget(record));
		const sent = frames.length;
		const [call] = toolCallMessages();
		record.messages = [call as SessionMessage];
		record.emit(settledEvent());
		tick();
		expect(frames.length).toBe(sent);
	});

	it("renders a tiny terminal", () => {
		const record = fakeRecord({ messages: [rowsOf(10)] });
		const { renderer, frames } = setup(recordTarget(record));
		const sent = frames.length;
		expect(() => {
			renderer.resize(4, 2);
			tick();
		}).not.toThrow();
		expect(frames.length).toBe(sent + 1);
	});

	it("contains component errors during input and resize", () => {
		const failing = callTool(() => ({ render: () => { throw new Error("boom"); }, invalidate: () => {} }) as never);
		const record = fakeRecord({ messages: toolCallMessages(), tools: { mytool: failing } });
		const frames: string[][] = [];
		const renderer = new ViewerRenderer({ target: recordTarget(record), send: (l) => frames.push(l), theme, keys: keysWith(), cwd: "/cwd", markdownTheme: getMarkdownTheme() });
		expect(() => {
			renderer.input("\x1b[A");
			renderer.resize(60, 20);
			vi.advanceTimersByTime(500);
		}).not.toThrow();
		expect(frames).toHaveLength(0);
	});

	it("dispose destroys a pending escape", () => {
		const record = fakeRecord({ messages: [rowsOf(3)] });
		const { renderer } = setup(recordTarget(record));
		renderer.input("\x1b");
		renderer.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles a timed-out escape only at a frame turn", () => {
		const failing = callTool(() => ({ render: () => { throw new Error("boom"); }, invalidate: () => {} }) as never);
		const record = fakeRecord({ messages: toolCallMessages(), tools: { mytool: failing } });
		const spy = vi.spyOn(TranscriptPane.prototype, "handleInput");
		const frames: string[][] = [];
		const renderer = new ViewerRenderer({ target: recordTarget(record), send: (l) => frames.push(l), theme, keys: keysWith(), cwd: "/cwd", markdownTheme: getMarkdownTheme() });
		renderer.input("\x1b");
		expect(spy).not.toHaveBeenCalled();
		expect(() => vi.advanceTimersByTime(500)).not.toThrow();
		expect(spy).toHaveBeenCalled();
		expect(frames).toHaveLength(0);
		spy.mockRestore();
	});
});
