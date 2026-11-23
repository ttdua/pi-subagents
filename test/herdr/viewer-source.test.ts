import { describe, expect, it, vi } from "vitest";
import { FILE_POLL_MS, followedFileSource, type PollTimers, READINESS_PROBE_MS, SwitchableSource, type ViewerTarget } from "#src/herdr/viewer-source";
import type { NavigableSubagent, TranscriptSource } from "#src/ui/session-navigation";

class FakeTimers implements PollTimers {
	readonly active = new Map<number, { fn: () => void; ms: number }>();
	private next = 1;
	setInterval(fn: () => void, ms: number): unknown {
		const id = this.next++;
		this.active.set(id, { fn, ms });
		return id;
	}
	clearInterval(handle: unknown): void {
		this.active.delete(handle as number);
	}
	tick(ms: number): void {
		for (const t of [...this.active.values()]) if (t.ms === ms) t.fn();
	}
}

const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/" });
const userLine = (id: string, text: string) =>
	JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text, timestamp: 1 } });

function fileEnv(initial?: string) {
	const state = { text: initial as string | undefined, mtimeMs: 1, failRead: 0 };
	return {
		state,
		deps: {
			readFile: () => {
				if (state.failRead-- > 0) throw new Error("EBUSY");
				return state.text ?? "";
			},
			stat: () => (state.text === undefined ? undefined : { size: state.text.length, mtimeMs: state.mtimeMs }),
		},
	};
}

describe("followedFileSource", () => {
	it("empty until the file appears", () => {
		const timers = new FakeTimers();
		const env = fileEnv();
		const source = followedFileSource("/f", { ...env.deps, timers });
		const onChange = vi.fn();
		source.subscribe(onChange);
		expect(source.getMessages()).toEqual([]);
		env.state.text = `${header}\n${userLine("1", "hi")}\n`;
		timers.tick(FILE_POLL_MS);
		expect(source.getMessages()).toHaveLength(1);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("skips unparsable lines", () => {
		const env = fileEnv(`${header}\nnot json\n${userLine("1", "hi")}\n`);
		const source = followedFileSource("/f", { ...env.deps, timers: new FakeTimers() });
		expect(source.getMessages()).toHaveLength(1);
	});

	it("retries an unreadable file with unchanged size and mtime", () => {
		const timers = new FakeTimers();
		const env = fileEnv(`${header}\n${userLine("1", "hi")}\n`);
		env.state.failRead = 1;
		const source = followedFileSource("/f", { ...env.deps, timers });
		source.subscribe(() => {});
		expect(source.getMessages()).toEqual([]);
		timers.tick(FILE_POLL_MS);
		expect(source.getMessages()).toHaveLength(1);
	});

	it("has no tool definitions and no streaming", () => {
		const source = followedFileSource("/f", { ...fileEnv().deps, timers: new FakeTimers() });
		expect(source.getToolDefinition("bash")).toBeUndefined();
		expect(source.streaming()).toBeUndefined();
	});

	it("stops polling when the last subscriber leaves", () => {
		const timers = new FakeTimers();
		const source = followedFileSource("/f", { ...fileEnv().deps, timers });
		const a = source.subscribe(() => {});
		const b = source.subscribe(() => {});
		expect(timers.active.size).toBe(1);
		a?.();
		expect(timers.active.size).toBe(1);
		b?.();
		expect(timers.active.size).toBe(0);
	});
});

const heading = { name: "Agent", modeLabel: undefined, description: "d" };

function fakeRecord(over: Partial<{ ready: boolean; outputFile: string | undefined }> = {}) {
	const state = { ready: over.ready ?? true, outputFile: "outputFile" in over ? over.outputFile : undefined };
	let listener: ((e: never) => void) | undefined;
	const record = {
		status: "running",
		agentMessages: [{ role: "user", content: "live", timestamp: 1 }],
		activeTools: new Map(),
		responseText: "",
		get outputFile() {
			return state.outputFile;
		},
		isSessionReady: () => state.ready,
		subscribeToUpdates: (fn: (e: never) => void) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		getToolDefinition: () => undefined,
	} as unknown as NavigableSubagent;
	return { record, state, hasListener: () => listener !== undefined };
}

describe("SwitchableSource", () => {
	const fileSource = (): TranscriptSource => ({
		getMessages: () => [{ role: "user", content: "file", timestamp: 2 }] as unknown as ReturnType<TranscriptSource["getMessages"]>,
		subscribe: () => () => {},
		streaming: () => undefined,
		getToolDefinition: () => undefined,
		sessionModel: () => ({ model: undefined, thinkingLevel: undefined }),
	});

	it("is live for a ready record even without a file", () => {
		const { record } = fakeRecord({ ready: true });
		const source = new SwitchableSource({ kind: "record", record, heading }, { timers: new FakeTimers() });
		expect(source.kind()).toBe("live");
		expect(source.getMessages()).toBe(record.agentMessages);
	});

	it("is file for a released record and for a snapshot target", () => {
		const { record } = fakeRecord({ ready: false, outputFile: "/f" });
		const target: ViewerTarget = { kind: "record", record, heading };
		expect(new SwitchableSource(target, { fileSource, timers: new FakeTimers() }).kind()).toBe("file");
		const snap: ViewerTarget = { kind: "file", outputFile: "/f", heading };
		expect(new SwitchableSource(snap, { fileSource, timers: new FakeTimers() }).kind()).toBe("file");
	});

	it("yields an empty file source for a record with neither session nor file", () => {
		const { record } = fakeRecord({ ready: false, outputFile: undefined });
		const source = new SwitchableSource({ kind: "record", record, heading }, { timers: new FakeTimers() });
		expect(source.kind()).toBe("file");
		expect(source.getMessages()).toEqual([]);
	});

	it("switches live to file on release and back on resume", () => {
		const timers = new FakeTimers();
		const { record, state, hasListener } = fakeRecord({ ready: true, outputFile: "/f" });
		const source = new SwitchableSource({ kind: "record", record, heading }, { fileSource, timers });
		const events: unknown[] = [];
		const unsubscribe = source.subscribe((e) => events.push(e));
		expect(hasListener()).toBe(true);
		state.ready = false;
		timers.tick(READINESS_PROBE_MS);
		expect(source.kind()).toBe("file");
		expect(events).toEqual([undefined]);
		expect(hasListener()).toBe(false);
		state.ready = true;
		source.refresh();
		expect(source.kind()).toBe("live");
		expect(events).toEqual([undefined, undefined]);
		expect(hasListener()).toBe(true);
		unsubscribe();
		expect(hasListener()).toBe(false);
		expect(timers.active.size).toBe(0);
	});
});
