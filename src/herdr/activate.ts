/**
 * activate.ts — Builds the Herdr viewer observer when the session runs inside
 * Herdr, and owns its per-session lifetime (`HerdrActivation`).
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog } from "#src/debug";
import { type HerdrCli, HerdrQueue } from "#src/herdr/cli";
import { ViewerColumn } from "#src/herdr/column";
import { detectHerdr } from "#src/herdr/detect";
import { HerdrViewers, type HerdrViewersSlot, type TitleOf } from "#src/herdr/herdr-observer";
import { OutputFilePoller } from "#src/herdr/output-file-poller";
import { viewerRuntime } from "#src/herdr/runtime";
import { ViewerStatusFiles } from "#src/herdr/status-files";
import { ViewerProcesses } from "#src/herdr/viewer-process";
import { ViewerRegistry } from "#src/herdr/viewer-registry";

export interface ActivateInput {
	mode: string | undefined;
	env: Readonly<Record<string, string | undefined>>;
	cli: HerdrCli;
	cwd: string;
	pid: number;
	titleOf: TitleOf;
}

/** Absolute path of the standalone viewer program, resolved next to this module. */
export function viewerProgramPath(): string {
	return fileURLToPath(new URL("./viewer.ts", import.meta.url));
}

/** The observer for a session inside Herdr, or `undefined` when Herdr is not active. */
export async function activateHerdrViewers(input: ActivateInput): Promise<HerdrViewers | undefined> {
	const ctx = await detectHerdr({ mode: input.mode, env: input.env, cli: input.cli });
	if (ctx === undefined) return undefined;
	return new HerdrViewers({
		column: new ViewerColumn(ctx, input.cli),
		processes: new ViewerProcesses(input.cli, {
			runtime: viewerRuntime(),
			viewerPath: viewerProgramPath(),
			pid: input.pid,
			parentTerminal: ctx.terminalId,
		}),
		statusFiles: new ViewerStatusFiles(join(tmpdir(), "pi-subagents-herdr"), input.pid),
		registry: new ViewerRegistry(),
		createPoller: (onReady) => new OutputFilePoller(onReady),
		queue: new HerdrQueue(),
		cwd: input.cwd,
		titleOf: input.titleOf,
		fileExists: existsSync,
	});
}

type Activate = (cwd: string, mode: string | undefined) => Promise<HerdrViewers | undefined>;

/**
 * Per-session lifetime of the viewers: activation runs without blocking
 * `session_start`; a result that arrives after a newer start or a stop is
 * disposed instead of installed.
 */
export class HerdrActivation {
	private generation = 0;

	constructor(
		private readonly slot: HerdrViewersSlot,
		private readonly activate: Activate,
	) {}

	start(ctx: { cwd: string; mode?: string }): void {
		const generation = ++this.generation;
		this.activate(ctx.cwd, ctx.mode).then(
			(viewers) => this.install(generation, viewers),
			(err) => debugLog("herdr activation failed", err),
		);
	}

	async stop(): Promise<void> {
		this.generation++;
		await this.release();
	}

	private async install(generation: number, viewers: HerdrViewers | undefined): Promise<void> {
		if (viewers === undefined) return;
		if (generation !== this.generation) {
			await viewers.dispose();
			return;
		}
		const previous = this.slot.get();
		this.slot.set(viewers);
		await previous?.dispose();
	}

	private async release(): Promise<void> {
		const current = this.slot.get();
		this.slot.set(undefined);
		await current?.dispose();
	}
}
