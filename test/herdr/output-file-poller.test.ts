import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_FILE_POLL_MS, OutputFilePoller } from "#src/herdr/output-file-poller";
import type { Subagent } from "#src/lifecycle/subagent";

interface StubRecord {
	id: string;
	outputFile: string | undefined;
}
const record = (id: string): StubRecord => ({ id, outputFile: undefined });
const asSubagent = (r: StubRecord) => r as unknown as Subagent;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("OutputFilePoller", () => {
	it("reports nothing while the record has no file", () => {
		const onReady = vi.fn();
		const poller = new OutputFilePoller(onReady);
		poller.watch(asSubagent(record("a")));
		vi.advanceTimersByTime(OUTPUT_FILE_POLL_MS * 4);
		expect(onReady).not.toHaveBeenCalled();
		poller.stop();
	});

	it("reports once within one poll after the file appears, then stops watching", () => {
		const onReady = vi.fn();
		const poller = new OutputFilePoller(onReady);
		const r = record("a");
		poller.watch(asSubagent(r));
		r.outputFile = "/s/a.jsonl";
		vi.advanceTimersByTime(OUTPUT_FILE_POLL_MS);
		expect(onReady).toHaveBeenCalledTimes(1);
		expect(onReady).toHaveBeenCalledWith(r, "/s/a.jsonl");
		vi.advanceTimersByTime(OUTPUT_FILE_POLL_MS * 4);
		expect(onReady).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unwatch stops reporting", () => {
		const onReady = vi.fn();
		const poller = new OutputFilePoller(onReady);
		const r = record("a");
		poller.watch(asSubagent(r));
		poller.unwatch("a");
		r.outputFile = "/s/a.jsonl";
		vi.advanceTimersByTime(OUTPUT_FILE_POLL_MS * 2);
		expect(onReady).not.toHaveBeenCalled();
	});

	it("runs its timer only while records are watched", () => {
		const poller = new OutputFilePoller(vi.fn());
		expect(vi.getTimerCount()).toBe(0);
		poller.watch(asSubagent(record("a")));
		poller.watch(asSubagent(record("b")));
		expect(vi.getTimerCount()).toBe(1);
		poller.unwatch("a");
		expect(vi.getTimerCount()).toBe(1);
		poller.unwatch("b");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stop clears every watch and the timer", () => {
		const onReady = vi.fn();
		const poller = new OutputFilePoller(onReady);
		const r = record("a");
		poller.watch(asSubagent(r));
		poller.stop();
		r.outputFile = "/s/a.jsonl";
		vi.advanceTimersByTime(OUTPUT_FILE_POLL_MS * 2);
		expect(onReady).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses injected timers", () => {
		const timers = { setInterval: vi.fn(() => 7), clearInterval: vi.fn() };
		const poller = new OutputFilePoller(vi.fn(), timers);
		poller.watch(asSubagent(record("a")));
		expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), OUTPUT_FILE_POLL_MS);
		poller.unwatch("a");
		expect(timers.clearInterval).toHaveBeenCalledWith(7);
	});
});
