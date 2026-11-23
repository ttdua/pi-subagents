/**
 * column.ts — Where each subagent viewer terminal sits in the Herdr window:
 * a column right of Pi's pane, stacked down, with a waiting FIFO beyond the cap.
 *
 * Plain async methods with no queueing: the caller serializes calls.
 */

import { debugLog } from "#src/debug";
import type { HerdrCli } from "#src/herdr/cli";
import { type HerdrContext, readTabTerminals } from "#src/herdr/detect";
import { asRecord, asString, parseJson } from "#src/herdr/json";

export const MAX_COLUMN = 4;
export const PEEK_ATTEMPTS = 5;
export const PEEK_RETRY_MS = 200;
export const KEEP_SETTLE_POLL_MS = 100;

export interface ColumnViewer {
	readonly terminal: string;
	pane?: string;
}

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ViewerColumn {
	private placed: ColumnViewer[] = [];
	private waiting: ColumnViewer[] = [];

	constructor(
		private readonly ctx: HerdrContext,
		private readonly cli: HerdrCli,
		private readonly sleep: Sleep = realSleep,
	) {}

	isPlaced(v: ColumnViewer): boolean {
		return this.placed.includes(v);
	}

	isWaiting(v: ColumnViewer): boolean {
		return this.waiting.includes(v);
	}

	/** Places `v` in the column, or queues it when the column is full. */
	async place(v: ColumnViewer): Promise<void> {
		if (this.isPlaced(v) || this.isWaiting(v)) return;
		await this.prune();
		if (this.placed.length >= MAX_COLUMN) {
			this.waiting.push(v);
			return;
		}
		await this.placeNow(v);
	}

	/** Parks a placed viewer or drops a waiting one, then moves waiting viewers into free slots. */
	async hide(v: ColumnViewer): Promise<void> {
		if (this.isWaiting(v)) {
			this.waiting = this.waiting.filter((w) => w !== v);
			return;
		}
		if (!this.isPlaced(v)) return;
		this.placed = this.placed.filter((p) => p !== v);
		v.pane = undefined;
		await this.park(v);
		await this.refill();
	}

	async focus(v: ColumnViewer): Promise<boolean> {
		if (!this.isPlaced(v) || v.pane === undefined) return false;
		return this.focusPane(v.pane);
	}

	/** True once the terminal answers `terminal.peek` without error; retried while Herdr catches up. */
	async peek(v: ColumnViewer): Promise<boolean> {
		for (let attempt = 1; attempt <= PEEK_ATTEMPTS; attempt++) {
			const result = await this.cli.run("herdr-app", ["do", "terminal.peek", "--terminal", v.terminal]);
			if (result.code === 0 && asRecord(parseJson(result.stdout))?.error === undefined) return true;
			if (attempt < PEEK_ATTEMPTS) await this.sleep(PEEK_RETRY_MS);
		}
		return false;
	}

	private async readFocus(): Promise<string | undefined> {
		const result = await this.cli.run("herdr-app", ["status"]);
		if (result.code !== 0) return undefined;
		return asString(asRecord(parseJson(result.stdout))?.focused_pane);
	}

	/** Panes currently in the tab, or `undefined` when Herdr cannot say. */
	private async livePanes(): Promise<Set<string> | undefined> {
		const terminals = await readTabTerminals(this.cli, this.ctx);
		if (terminals === undefined) return undefined;
		const panes = new Set<string>();
		for (const terminal of terminals) {
			const pane = asString(asRecord(terminal)?.pane);
			if (pane !== undefined) panes.add(pane);
		}
		return panes;
	}

	/** Forgets placed viewers whose pane the user closed. */
	private async prune(): Promise<void> {
		const live = await this.livePanes();
		if (live === undefined) return;
		this.placed = this.placed.filter((v) => v.pane !== undefined && live.has(v.pane));
	}

	private async focusPane(pane: string): Promise<boolean> {
		const result = await this.cli.run("herdr-app", ["do", "pane.focus", "--pane", pane]);
		return result.code === 0;
	}

	/** Keeps `v` next to the column anchor, then puts focus back where the user had it. */
	private async placeNow(v: ColumnViewer): Promise<void> {
		const remembered = (await this.readFocus()) ?? this.ctx.parentPaneId;
		const last = this.placed[this.placed.length - 1];
		const anchor = last?.pane ?? this.ctx.parentPaneId;
		const place = last === undefined ? "right" : "down";
		try {
			if (!(await this.focusAnchor(anchor))) return;
			const pane = await this.keep(v, place, anchor);
			if (pane === undefined) return;
			await this.awaitPane(pane);
			v.pane = pane;
			this.placed.push(v);
		} finally {
			if (remembered !== undefined) await this.focusPane(remembered);
		}
	}

	/** Waits until Herdr lists `pane` in the tab: keep applies asynchronously and moves focus when it does. Gives up after PEEK_ATTEMPTS * PEEK_RETRY_MS. */
	private async awaitPane(pane: string): Promise<void> {
		const polls = (PEEK_ATTEMPTS * PEEK_RETRY_MS) / KEEP_SETTLE_POLL_MS;
		for (let i = 0; i < polls; i++) {
			if ((await this.livePanes())?.has(pane)) return;
			await this.sleep(KEEP_SETTLE_POLL_MS);
		}
	}

	private async focusAnchor(anchor: string): Promise<boolean> {
		const focused = await this.focusPane(anchor);
		if (!focused) debugLog("herdr pane.focus failed for anchor", anchor);
		return focused;
	}

	/** Retries while Herdr has not seen the terminal yet; any other failure is final. */
	private async keep(v: ColumnViewer, place: "right" | "down", anchor: string): Promise<string | undefined> {
		for (let attempt = 1; attempt <= PEEK_ATTEMPTS; attempt++) {
			const result = await this.cli.run("herdr-app", ["do", "terminal.keep", "--terminal", v.terminal, "--place", place]);
			if (result.code === 0) return asString(asRecord(parseJson(result.stdout))?.pane);
			const error = asString(asRecord(parseJson(result.stdout))?.error);
			if (error === undefined || !error.includes("no running terminal") || attempt === PEEK_ATTEMPTS) {
				debugLog(`herdr terminal.keep failed for ${v.terminal}`, `code ${result.code}: ${error ?? "no error reply"}`);
				return undefined;
			}
			await this.sleep(PEEK_RETRY_MS);
			await this.focusAnchor(anchor);
		}
		return undefined;
	}

	private async refill(): Promise<void> {
		await this.prune();
		while (this.placed.length < MAX_COLUMN) {
			const next = this.waiting.shift();
			if (next === undefined) return;
			await this.placeNow(next);
		}
	}

	/** A viewer that is already gone is fine: failures are ignored. */
	private async park(v: ColumnViewer): Promise<void> {
		await this.cli.run("herdr-app", ["do", "terminal.park", "--terminal", v.terminal]);
	}
}
