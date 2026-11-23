/**
 * output-file-poller.ts — Reports when a watched record first has an
 * `outputFile`. The timer runs only while records are watched and is unref'd.
 */

import type { Subagent } from "#src/lifecycle/subagent";

export const OUTPUT_FILE_POLL_MS = 250;

export interface PollerTimers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const realTimers: PollerTimers = {
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class OutputFilePoller {
	private readonly watched = new Map<string, Subagent>();
	private handle: unknown;

	constructor(
		private readonly onReady: (record: Subagent, file: string) => void,
		private readonly timers: PollerTimers = realTimers,
	) {}

	watch(record: Subagent): void {
		this.watched.set(record.id, record);
		if (this.handle === undefined) this.handle = this.timers.setInterval(() => this.tick(), OUTPUT_FILE_POLL_MS);
	}

	unwatch(id: string): void {
		this.watched.delete(id);
		if (this.watched.size === 0) this.clearTimer();
	}

	stop(): void {
		this.watched.clear();
		this.clearTimer();
	}

	private tick(): void {
		for (const [id, record] of this.watched) {
			const file = record.outputFile;
			if (file === undefined) continue;
			this.unwatch(id);
			this.onReady(record, file);
		}
	}

	private clearTimer(): void {
		if (this.handle === undefined) return;
		this.timers.clearInterval(this.handle);
		this.handle = undefined;
	}
}
