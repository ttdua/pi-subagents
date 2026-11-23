/**
 * runtime.ts — Which program runs the TypeScript viewer (`viewer.ts`) directly.
 */

import { basename } from "node:path";

export interface RuntimeProcess {
	execPath: string;
	versions: Record<string, string | undefined>;
}

/** Node strips types by default from this version on. */
const NODE_TYPE_STRIPPING: readonly [number, number] = [22, 18];

function stripsTypes(nodeVersion: string | undefined): boolean {
	if (nodeVersion === undefined) return false;
	const [major, minor] = nodeVersion.split(".").map(Number);
	if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return false;
	const [needMajor, needMinor] = NODE_TYPE_STRIPPING;
	return major > needMajor || (major === needMajor && minor >= needMinor);
}

/**
 * The current runtime when it runs TypeScript itself (Bun, or Node ≥ 22.18);
 * otherwise `node` from `PATH` (compiled single binaries, older Node).
 */
export function viewerRuntime(proc: RuntimeProcess = process): string[] {
	const name = basename(proc.execPath);
	if (proc.versions.bun !== undefined) return name.startsWith("bun") ? [proc.execPath] : ["node"];
	if (name.startsWith("node") && stripsTypes(proc.versions.node)) return [proc.execPath];
	return ["node"];
}
