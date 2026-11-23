/**
 * status-files.ts — Per-viewer status files telling a viewer whether its
 * child runs or finished. Written atomically (temp file + rename).
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";

export type FinishedStatus = Exclude<SubagentStatus, "queued" | "running">;

export type ViewerStatus = { state: "running" } | { state: "done"; status?: FinishedStatus };

export class ViewerStatusFiles {
	private dir: string | undefined;

	constructor(
		private readonly root: string,
		private readonly pid: number,
	) {}

	/** Per-process directory with an unpredictable name, created on first use. */
	private ensureDir(): string {
		if (this.dir === undefined) {
			mkdirSync(this.root, { recursive: true, mode: 0o700 });
			this.dir = mkdtempSync(join(this.root, `${this.pid}-`));
		}
		return this.dir;
	}

	pathFor(key: string): string {
		return join(this.ensureDir(), `${key}.json`);
	}

	write(key: string, s: ViewerStatus): void {
		const target = this.pathFor(key);
		const temp = `${target}.tmp`;
		writeFileSync(temp, JSON.stringify(s));
		renameSync(temp, target);
	}

	removeAll(): void {
		if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}
}
