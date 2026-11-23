/**
 * viewer-source.ts — Transcript sources a Herdr viewer renders from: a followed
 * session file and a source that switches between the live session and that file.
 * All timers are unref'd and run only while a source has subscribers.
 */

import { readFileSync, statSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "#src/types";
import {
	type EntryHeading,
	fileSnapshotSource,
	liveSource,
	type NavigableSubagent,
	type SessionModel,
	type StreamingState,
	type TranscriptSource,
} from "#src/ui/session-navigation";

export const FILE_POLL_MS = 300;
export const READINESS_PROBE_MS = 1000;

export interface PollTimers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const realTimers: PollTimers = {
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

type Listener = (event?: AgentSessionEvent) => void;
type FileStat = { size: number; mtimeMs: number };

const NO_MODEL: SessionModel = { model: undefined, thinkingLevel: undefined };

/** A static, empty file-kind source. */
const emptySource: TranscriptSource = {
	getMessages: () => [],
	subscribe: () => undefined,
	streaming: () => undefined,
	getToolDefinition: () => undefined,
	sessionModel: () => NO_MODEL,
};

function statOrUndefined(path: string): FileStat | undefined {
	try {
		const { size, mtimeMs } = statSync(path);
		return { size, mtimeMs };
	} catch {
		return undefined;
	}
}

/** A subscriber set whose timer runs only while it is non-empty. */
class ListenerSet {
	private readonly listeners = new Set<Listener>();
	private handle: unknown;

	constructor(
		private readonly timers: PollTimers,
		private readonly ms: number,
		private readonly onTick: () => void,
		private readonly onFirst: () => void = () => {},
		private readonly onEmpty: () => void = () => {},
	) {}

	add(listener: Listener): () => void {
		const first = this.listeners.size === 0;
		this.listeners.add(listener);
		if (first) {
			this.onFirst();
			this.handle = this.timers.setInterval(this.onTick, this.ms);
		}
		return () => this.remove(listener);
	}

	emit(event?: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	get active(): boolean {
		return this.listeners.size > 0;
	}

	private remove(listener: Listener): void {
		if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
		this.timers.clearInterval(this.handle);
		this.handle = undefined;
		this.onEmpty();
	}
}

/** Follow a session file: rebuild the snapshot whenever its size or mtime changes. */
export function followedFileSource(
	outputFile: string,
	deps: {
		readFile?: (p: string) => string;
		stat?: (p: string) => FileStat | undefined;
		timers?: PollTimers;
	} = {},
): TranscriptSource {
	const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const stat = deps.stat ?? statOrUndefined;
	let snapshot: TranscriptSource = emptySource;
	let seen: FileStat | undefined;

	/** Rebuild when the file changed; true when the snapshot was replaced. */
	const refresh = (): boolean => {
		const current = stat(outputFile);
		if (current === undefined) {
			const had = snapshot !== emptySource;
			snapshot = emptySource;
			seen = undefined;
			return had;
		}
		if (seen && current.size === seen.size && current.mtimeMs === seen.mtimeMs) return false;
		try {
			snapshot = fileSnapshotSource(outputFile, readFile);
		} catch {
			return false; // not recorded as seen: the next poll reads again
		}
		seen = current;
		return true;
	};

	const listeners = new ListenerSet(deps.timers ?? realTimers, FILE_POLL_MS, () => {
		if (refresh()) listeners.emit(undefined);
	});
	refresh();

	return {
		getMessages: () => snapshot.getMessages(),
		subscribe: (onChange) => listeners.add(onChange),
		streaming: () => undefined,
		getToolDefinition: () => undefined,
		sessionModel: () => snapshot.sessionModel(),
	};
}

export type ViewerTarget =
	| { kind: "record"; record: NavigableSubagent; heading: EntryHeading }
	| { kind: "file"; outputFile: string; heading: EntryHeading };

/** The inner source in use, identified by kind and file so a change can be detected. */
interface Chosen {
	readonly kind: "live" | "file";
	readonly file: string | undefined;
}

/** Live while the record's session is ready, otherwise the followed file; swaps on `refresh()` or a probe. */
export class SwitchableSource implements TranscriptSource {
	private chosen: Chosen;
	private inner: TranscriptSource;
	private unsubscribeInner: (() => void) | undefined;
	private readonly listeners: ListenerSet;
	private readonly fileSource: (file: string) => TranscriptSource;

	constructor(
		private readonly target: ViewerTarget,
		deps: { timers?: PollTimers; fileSource?: (f: string) => TranscriptSource } = {},
	) {
		const timers = deps.timers ?? realTimers;
		this.fileSource = deps.fileSource ?? ((file) => followedFileSource(file, { timers }));
		this.chosen = this.choose();
		this.inner = this.build(this.chosen);
		this.listeners = new ListenerSet(
			timers,
			READINESS_PROBE_MS,
			() => this.refresh(),
			() => this.attach(),
			() => this.detach(),
		);
	}

	kind(): "live" | "file" {
		return this.chosen.kind;
	}

	/** Probe readiness and swap the inner source when the choice changed. */
	refresh(): void {
		const next = this.choose();
		if (next.kind === this.chosen.kind && next.file === this.chosen.file) return;
		this.detach();
		this.chosen = next;
		this.inner = this.build(next);
		if (this.listeners.active) this.attach();
		this.listeners.emit(undefined);
	}

	getMessages() {
		return this.inner.getMessages();
	}
	streaming(): StreamingState | undefined {
		return this.inner.streaming();
	}
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.inner.getToolDefinition(name);
	}
	sessionModel(): SessionModel {
		return this.inner.sessionModel();
	}
	subscribe(onChange: Listener): () => void {
		return this.listeners.add(onChange);
	}

	private choose(): Chosen {
		if (this.target.kind === "file") return { kind: "file", file: this.target.outputFile };
		if (this.target.record.isSessionReady()) return { kind: "live", file: undefined };
		return { kind: "file", file: this.target.record.outputFile };
	}

	private build(chosen: Chosen): TranscriptSource {
		if (chosen.kind === "live" && this.target.kind === "record") return liveSource(this.target.record);
		return chosen.file === undefined ? emptySource : this.fileSource(chosen.file);
	}

	private attach(): void {
		this.unsubscribeInner ??= this.inner.subscribe((event) => this.listeners.emit(event));
	}

	private detach(): void {
		this.unsubscribeInner?.();
		this.unsubscribeInner = undefined;
	}
}
