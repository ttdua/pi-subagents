/**
 * viewer-renderer.ts — Renders the `/subagents:sessions` transcript pane into
 * frames for one Herdr viewer terminal.
 *
 * Callers (resize, input, wheel, refresh, source events) only record pending
 * work and arm a frame timer. Every pane call and `source.refresh()` runs at
 * the frame turn, so nothing renders inside a lifecycle hook or a source
 * callback and at most one frame is produced per `FRAME_INTERVAL_MS`.
 */

import { type MarkdownTheme, StdinBuffer } from "@earendil-works/pi-tui";
import { debugLog } from "#src/debug";
import { DeferredSource } from "#src/herdr/deferred-source";
import { HeadlessTui } from "#src/herdr/headless-tui";
import { SwitchableSource, type ViewerTarget } from "#src/herdr/viewer-source";
import { isRunningStatus, type SubagentStatus } from "#src/lifecycle/subagent-state";
import { type PaneKeys, TranscriptPane, type TranscriptTheme } from "#src/ui/session-navigator";

export const FRAME_INTERVAL_MS = 50;
const MAX_KEYS_PER_FRAME = 64;

export interface FrameTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realTimers: FrameTimers = {
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The footer state label: what the run is doing, or how it ended. */
export function viewerStatusLabel(status: SubagentStatus | undefined, resumed: boolean): string {
	if (status === undefined) return "done";
	if (status === "queued" || status === "running") return resumed ? "running again" : "running";
	return `done (${status})`;
}

export interface ViewerRendererOptions {
	target: ViewerTarget;
	send: (lines: string[]) => void;
	theme: TranscriptTheme;
	keys: PaneKeys;
	cwd: string;
	markdownTheme: MarkdownTheme;
	timers?: FrameTimers;
	source?: SwitchableSource;
}

/** Tracks a record's status and whether it ran again after leaving running/queued. */
class StatusTracker {
	private resumed = false;
	private left: boolean;

	constructor(private readonly status: () => SubagentStatus | undefined) {
		this.left = !this.active(status());
	}

	label(): string {
		const status = this.status();
		if (this.active(status)) {
			if (this.left) this.resumed = true;
			this.left = false;
		} else {
			this.left = true;
		}
		return viewerStatusLabel(status, this.resumed);
	}

	private active(status: SubagentStatus | undefined): boolean {
		return status !== undefined && (status === "queued" || isRunningStatus(status));
	}
}

/** Decoded keys waiting for a frame turn; the `StdinBuffer`'s emissions only enqueue and schedule. */
class KeyQueue {
	private readonly buffer = new StdinBuffer();
	private keys: string[] = [];

	constructor(onKey: () => void) {
		this.buffer.on("data", (key) => {
			this.keys.push(key);
			onKey();
		});
	}

	push(data: string): void {
		this.buffer.process(data);
	}

	next(): string | undefined {
		return this.keys.shift();
	}

	get pending(): boolean {
		return this.keys.length > 0;
	}

	destroy(): void {
		this.buffer.destroy();
		this.keys = [];
	}
}

export class ViewerRenderer {
	private readonly tui: HeadlessTui;
	private readonly source: SwitchableSource;
	private readonly deferred: DeferredSource;
	private readonly pane: TranscriptPane;
	private readonly keyQueue: KeyQueue;
	private readonly timers: FrameTimers;
	private readonly tracker: StatusTracker;
	private statusLabel: string;
	private timer: unknown;
	private inTurn = false;
	private disposed = false;
	private lastSent: string[] | undefined;
	private pendingSize: { cols: number; rows: number } | undefined;
	private pendingWheel = 0;
	private pendingRefresh = false;

	constructor(private readonly o: ViewerRendererOptions) {
		this.timers = o.timers ?? realTimers;
		this.tui = new HeadlessTui(() => {
			if (!this.inTurn) this.schedule();
		});
		this.source = o.source ?? new SwitchableSource(o.target);
		this.deferred = new DeferredSource(this.source, () => this.schedule());
		this.keyQueue = new KeyQueue(() => this.schedule());
		this.tracker = new StatusTracker(() => (o.target.kind === "record" ? o.target.record.status : undefined));
		this.statusLabel = this.tracker.label();
		this.pane = new TranscriptPane({
			tui: this.tui.asTui(),
			theme: o.theme,
			keys: o.keys,
			source: this.deferred,
			heading: o.target.heading,
			done: () => {},
			cwd: o.cwd,
			markdownTheme: o.markdownTheme,
			layout: "fill",
			status: () => this.statusLabel,
		});
	}

	resize(cols: number, rows: number): void {
		this.pendingSize = { cols, rows };
		this.schedule();
	}

	input(data: string): void {
		this.keyQueue.push(data);
	}

	wheel(delta: number): void {
		this.pendingWheel += delta;
		this.schedule();
	}

	refresh(): void {
		this.pendingRefresh = true;
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.pane.dispose();
		this.deferred.dispose();
		this.keyQueue.destroy();
		this.clearTimer();
	}

	private schedule(): void {
		if (this.disposed || this.timer !== undefined) return;
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			this.frameTurn();
		}, FRAME_INTERVAL_MS);
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		this.timers.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private frameTurn(): void {
		this.inTurn = true;
		try {
			this.applyRefresh();
			this.applySize();
			this.applyKeys();
			this.applyWheel();
			this.applySourceEvents();
			this.paint();
		} catch (err) {
			debugLog("viewer frame", err);
		} finally {
			this.inTurn = false;
			if (this.keyQueue.pending) this.schedule();
		}
	}

	private applyRefresh(): void {
		if (this.pendingRefresh) {
			this.pendingRefresh = false;
			this.source.refresh();
		}
		this.statusLabel = this.tracker.label();
	}

	private applySize(): void {
		const size = this.pendingSize;
		if (!size) return;
		this.pendingSize = undefined;
		this.tui.resize(size.cols, size.rows);
		this.pane.invalidate();
	}

	private applyKeys(): void {
		for (let applied = 0; applied < MAX_KEYS_PER_FRAME; applied++) {
			const key = this.keyQueue.next();
			if (key === undefined) return;
			this.pane.handleInput(key);
		}
	}

	private applyWheel(): void {
		const wheelDelta = this.pendingWheel;
		if (wheelDelta === 0) return;
		this.pendingWheel = 0;
		const { columns: width, rows: height } = this.tui.terminal;
		this.pane.handleMouse({
			type: "wheel",
			wheelDelta,
			button: "none",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width,
			height,
			shift: false,
			alt: false,
			ctrl: false,
		});
	}

	private applySourceEvents(): void {
		if (this.deferred.flush().resync) {
			this.pane.resync();
			this.deferred.redeliverInFlight();
		}
	}

	/** Render and send the frame unless it equals the last one sent. */
	private paint(): void {
		const lines = this.pane.render(this.tui.terminal.columns);
		const last = this.lastSent;
		if (last && last.length === lines.length && last.every((line, i) => line === lines[i])) return;
		this.lastSent = lines;
		this.o.send(lines);
	}
}
