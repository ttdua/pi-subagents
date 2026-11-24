/**
 * viewer-process.ts — Start, liveness and end of viewer terminals through `hc`.
 */

import { debugLog } from "#src/debug";
import type { HerdrCli } from "#src/herdr/cli";
import { asRecord, asString, parseJson } from "#src/herdr/json";

export interface ViewerLaunch {
	key: string;
	agentType: string | undefined;
	cwd: string;
	socket: string;
}

export interface ViewerProcessOptions {
	runtime: string[];
	viewerPath: string;
	pid: number;
	parentTerminal: string;
}

const MAX_NAME = 32;

/** `<agent type or "agent">-<first 6 of key>`, reduced to `[a-z0-9_-]`. */
export function viewerName(agentType: string | undefined, key: string): string {
	const raw = `${agentType ?? "agent"}-${key.slice(0, 6)}`.toLowerCase();
	return raw
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, MAX_NAME);
}

export class ViewerProcesses {
	constructor(
		private readonly cli: HerdrCli,
		private readonly opts: ViewerProcessOptions,
	) {}

	/** The new terminal's address, or `undefined` when `hc run` fails twice (once with, once without a name). */
	async start(l: ViewerLaunch): Promise<string | undefined> {
		const program = this.program(l);
		const named = await this.run(["--name", viewerName(l.agentType, l.key), "--cwd", l.cwd], program);
		if (named !== undefined) return named;
		return this.run(["--cwd", l.cwd], program);
	}

	async isLive(terminal: string): Promise<boolean> {
		const result = await this.cli.run("hc", ["get", terminal, "--json"]);
		if (result.code !== 0) return false;
		return asRecord(parseJson(result.stdout))?.state === "live";
	}

	/** Keep off first so no shell replaces the viewer, then kill and remove; failures are ignored. */
	async end(terminal: string): Promise<void> {
		for (const args of [["keep", terminal, "--off"], ["kill", terminal], ["rm", terminal]]) {
			const result = await this.cli.run("hc", args);
			if (result.code !== 0) debugLog(`hc ${args.join(" ")} failed`, result.code);
		}
	}

	private program(l: ViewerLaunch): string[] {
		const { runtime, viewerPath, pid, parentTerminal } = this.opts;
		return [
			...runtime,
			viewerPath,
			"--socket",
			l.socket,
			"--key",
			l.key,
			"--pid",
			String(pid),
			"--parent-terminal",
			parentTerminal,
		];
	}

	private async run(options: string[], program: string[]): Promise<string | undefined> {
		const result = await this.cli.run("hc", ["run", "--bg", "--json", ...options, "--", ...program]);
		if (result.code !== 0) {
			debugLog("hc run failed for a viewer", result.code);
			return undefined;
		}
		return asString(asRecord(parseJson(result.stdout))?.address);
	}
}
