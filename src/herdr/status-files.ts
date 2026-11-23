/**
 * status-files.ts — Per-viewer status files telling a viewer whether its
 * child runs or finished. Written atomically (temp file + rename).
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";

export type FinishedStatus = Exclude<SubagentStatus, "queued" | "running">;

export type ViewerStatus = { state: "running" } | { state: "done"; status: FinishedStatus };

export class ViewerStatusFiles {
	private readonly dir: string;

	constructor(root: string, pid: number) {
		this.dir = join(root, String(pid));
	}

	pathFor(key: string): string {
		return join(this.dir, `${key}.json`);
	}

	write(key: string, s: ViewerStatus): void {
		mkdirSync(this.dir, { recursive: true });
		const target = this.pathFor(key);
		const temp = `${target}.tmp`;
		writeFileSync(temp, JSON.stringify(s));
		renameSync(temp, target);
	}

	removeAll(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}
