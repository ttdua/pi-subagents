import { describe, expect, it, vi } from "vitest";
import { DeferredSource, MAX_QUEUED_EVENTS } from "#src/herdr/deferred-source";
import type { AgentSessionEvent } from "#src/types";
import type { TranscriptSource } from "#src/ui/session-navigation";

const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const update = (text: string) => ({ type: "message_update", message: asst(text) }) as unknown as AgentSessionEvent;
const start = (text: string) => ({ type: "message_start", message: asst(text) }) as unknown as AgentSessionEvent;
const end = () => ({ type: "message_end", message: asst("x") }) as unknown as AgentSessionEvent;
const tool = (n: number) => ({ type: "tool_execution_start", toolCallId: String(n), toolName: "t", args: {} }) as unknown as AgentSessionEvent;

function setup() {
	let push: (e?: AgentSessionEvent) => void = () => {};
	const unsubscribe = vi.fn();
	const inner: TranscriptSource = {
		getMessages: () => [],
		subscribe: (fn) => {
			push = fn;
			return unsubscribe;
		},
		streaming: () => undefined,
		getToolDefinition: () => undefined,
		sessionModel: () => ({ model: undefined, thinkingLevel: undefined }),
	};
	const onQueued = vi.fn();
	const source = new DeferredSource(inner, onQueued);
	const got: Array<AgentSessionEvent | undefined> = [];
	source.subscribe((e) => got.push(e));
	return { source, emit: (e?: AgentSessionEvent) => push(e), got, onQueued, unsubscribe };
}

describe("DeferredSource", () => {
	it("delivers nothing before flush", () => {
		const { emit, got } = setup();
		emit(tool(1));
		expect(got).toEqual([]);
	});

	it("delivers queued events in order on flush", () => {
		const { source, emit, got } = setup();
		const [a, b] = [tool(1), tool(2)];
		emit(a);
		emit(b);
		expect(source.flush()).toEqual({ resync: false });
		expect(got).toEqual([a, b]);
	});

	it("collapses consecutive message_update events", () => {
		const { source, emit, got } = setup();
		const last = update("c");
		emit(update("a"));
		emit(update("b"));
		emit(last);
		source.flush();
		expect(got).toEqual([last]);
	});

	it("collapses message_update only for consecutive events", () => {
		const { source, emit, got } = setup();
		const [first, tl, last] = [update("a"), tool(1), update("b")];
		emit(first);
		emit(tl);
		emit(last);
		source.flush();
		expect(got).toEqual([first, tl, last]);
	});

	it("drops an overflowing queue and asks for a resync", () => {
		const { source, emit, got } = setup();
		for (let i = 0; i <= MAX_QUEUED_EVENTS; i++) emit(tool(i));
		expect(MAX_QUEUED_EVENTS + 1).toBe(257);
		expect(source.flush()).toEqual({ resync: true });
		expect(got).toEqual([]);
		expect(source.flush()).toEqual({ resync: false });
	});

	it("keeps the latest in-flight event across an overflow", () => {
		const { source, emit, got } = setup();
		emit(start("p"));
		const latest = update("pp");
		emit(latest);
		for (let i = 0; i < 300; i++) emit(tool(i));
		expect(source.flush()).toEqual({ resync: true });
		source.redeliverInFlight();
		expect(got).toEqual([latest]);
		emit(end());
		source.flush();
		got.length = 0;
		source.redeliverInFlight();
		expect(got).toEqual([]);
	});

	it("clears the in-flight event on an inner switch", () => {
		const { source, emit, got } = setup();
		emit(update("p"));
		emit(undefined);
		source.flush();
		got.length = 0;
		source.redeliverInFlight();
		expect(got).toEqual([]);
	});

	it("calls onQueued once per batch", () => {
		const { source, emit, onQueued } = setup();
		emit(tool(1));
		emit(tool(2));
		expect(onQueued).toHaveBeenCalledTimes(1);
		source.flush();
		emit(tool(3));
		expect(onQueued).toHaveBeenCalledTimes(2);
	});

	it("unsubscribes from the inner source on dispose", () => {
		const { source, unsubscribe } = setup();
		source.dispose();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
