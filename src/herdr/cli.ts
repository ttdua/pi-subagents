/**
 * cli.ts — The only seam to the external `hc` and `herdr-app` CLIs, plus the
 * serial job queue that orders their side effects.
 */

import { debugLog } from "#src/debug";
import { asRecord } from "#src/herdr/json";

export const HERDR_COMMAND_TIMEOUT_MS = 2000;

export type HerdrCommand = "hc" | "herdr-app";

export interface HerdrResult {
	code: number;
	stdout: string;
}

/** Never rejects: failures are reported as a non-zero `code`. */
export interface HerdrCli {
	run(command: HerdrCommand, args: readonly string[]): Promise<HerdrResult>;
}

export type HerdrExec = (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>;

const failed = (): HerdrResult => ({ code: 1, stdout: "" });

/** Accepts only a completed run: an object with numeric `code` and string `stdout`, not killed by timeout. */
function toResult(value: unknown): HerdrResult {
	const record = asRecord(value);
	if (record === undefined || record.killed === true) return failed();
	if (typeof record.code !== "number" || typeof record.stdout !== "string") return failed();
	return { code: record.code, stdout: record.stdout };
}

export function createExecHerdrCli(exec: HerdrExec): HerdrCli {
	return {
		async run(command, args) {
			try {
				const value = await exec(command, [...args], { timeout: HERDR_COMMAND_TIMEOUT_MS });
				return toResult(value);
			} catch (err) {
				debugLog(`herdr command ${command} ${args.join(" ")} failed`, err);
				return failed();
			}
		},
	};
}

/**
 * Runs jobs one at a time in enqueue order. Jobs never reject into the chain,
 * so one failing job does not stop the ones after it.
 */
export class HerdrQueue {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	enqueue(label: string, job: () => Promise<void>): Promise<void> {
		const run = this.tail.then(() => this.runJob(label, job));
		this.tail = run;
		return run;
	}

	/** Pending and future jobs are skipped; a job already running finishes. */
	close(): void {
		this.closed = true;
	}

	private async runJob(label: string, job: () => Promise<void>): Promise<void> {
		if (this.closed) return;
		try {
			await job();
		} catch (err) {
			debugLog(`herdr queue job "${label}" failed`, err);
		}
	}
}
