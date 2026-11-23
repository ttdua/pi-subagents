/**
 * viewer-registry.ts — Known viewers by key (record id, or `f-<sha1>` for a
 * file-only entry), also looked up by transcript path.
 */

import { createHash } from "node:crypto";
import type { ColumnViewer } from "#src/herdr/column";

export interface RegisteredViewer {
	key: string;
	terminal: string;
	outputFile: string;
	viewer: ColumnViewer;
}

/** Key for an entry with no record id: `f-` + first 10 hex of sha1(outputFile). */
export function fileViewerKey(outputFile: string): string {
	return `f-${createHash("sha1").update(outputFile).digest("hex").slice(0, 10)}`;
}

export class ViewerRegistry {
	private readonly entries = new Map<string, RegisteredViewer>();

	add(key: string, e: Omit<RegisteredViewer, "key">): void {
		this.entries.set(key, { key, ...e });
	}

	byKey(key: string): RegisteredViewer | undefined {
		return this.entries.get(key);
	}

	byOutputFile(file: string): RegisteredViewer | undefined {
		for (const entry of this.entries.values()) if (entry.outputFile === file) return entry;
		return undefined;
	}

	remove(key: string): void {
		this.entries.delete(key);
	}

	all(): RegisteredViewer[] {
		return [...this.entries.values()];
	}
}
