/**
 * herdr-observer.ts — Connects subagent lifecycle to Herdr viewers.
 *
 * `HerdrViewers` is a thin coordinator: every hook checks `disposed`, enqueues
 * one job on the serial `HerdrQueue` and returns. It is the only caller of
 * `enqueue`; jobs call the column, processes, status files and registry
 * directly, never enqueueing from inside a job.
 */

import { debugLog } from "#src/debug";
import type { HerdrQueue } from "#src/herdr/cli";
import type { ColumnViewer, ViewerColumn } from "#src/herdr/column";
import type { OutputFilePoller } from "#src/herdr/output-file-poller";
import type { ViewerStatus, ViewerStatusFiles } from "#src/herdr/status-files";
import type { ViewerProcesses } from "#src/herdr/viewer-process";
import { fileViewerKey, type RegisteredViewer, type ViewerRegistry } from "#src/herdr/viewer-registry";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { RunKind } from "#src/lifecycle/subagent-run";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { CompactionInfo } from "#src/types";
import type { NavigationEntry } from "#src/ui/session-navigation";

export const DISPOSE_CAP_MS = 3000;

export type TitleOf = (x: { type: string; description: string }) => string;

type Sleep = (ms: number) => Promise<void>;

export interface HerdrViewersDeps {
	column: ViewerColumn;
	processes: ViewerProcesses;
	statusFiles: ViewerStatusFiles;
	registry: ViewerRegistry;
	createPoller: (onReady: (record: Subagent, file: string) => void) => OutputFilePoller;
	queue: HerdrQueue;
	cwd: string;
	titleOf: TitleOf;
	fileExists: (path: string) => boolean;
	/** Timer for the dispose cap; injected by tests. */
	sleep?: Sleep;
}

/** What a viewer start needs, from a live record or a snapshot entry. */
interface ViewerSource {
	key: string;
	agentType: string | undefined;
	title: string;
	outputFile: string;
	/** Absent for a snapshot whose run status is not known. */
	status: SubagentStatus | undefined;
}

const unrefSleep: Sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});

function statusFor(status: SubagentStatus | undefined): ViewerStatus {
	if (status === undefined) return { state: "done" };
	if (status === "queued" || status === "running") return { state: "running" };
	return { state: "done", status };
}

export class HerdrViewers implements SubagentManagerObserver {
	private disposed = false;
	private readonly poller: OutputFilePoller;
	private readonly sleep: Sleep;

	constructor(private readonly deps: HerdrViewersDeps) {
		this.poller = deps.createPoller((record, file) => this.onFileReady(record, file));
		this.sleep = deps.sleep ?? unrefSleep;
	}

	onSubagentRunStarted(record: Subagent, _kind: RunKind): void {
		this.schedule(`run started ${record.id}`, () => this.runStarted(record));
	}

	onSubagentRunFinished(record: Subagent, _kind: RunKind): void {
		this.schedule(`run finished ${record.id}`, () => this.runFinished(record));
	}

	onSubagentCompacted(_record: Subagent, _info: CompactionInfo): void {}

	onSubagentCreated(_record: Subagent): void {}

	/** Shows the entry in Herdr; `false` means the caller falls back to the in-TUI pane. */
	async open(entry: NavigationEntry): Promise<boolean> {
		if (this.disposed) return false;
		const outputFile = entry.kind === "live" ? entry.record.outputFile : entry.outputFile;
		if (outputFile === undefined || !this.deps.fileExists(outputFile)) return false;
		let shown = false;
		await this.deps.queue.enqueue("open", async () => {
			shown = await this.openNow(entry, outputFile);
		});
		return shown;
	}

	/** Ends every known viewer (capped at `DISPOSE_CAP_MS`) and removes the status files. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.deps.queue.close();
		this.poller.stop();
		const ends = Promise.allSettled(this.deps.registry.all().map((e) => this.deps.processes.end(e.terminal)));
		await Promise.race([ends, this.sleep(DISPOSE_CAP_MS)]);
		try {
			this.deps.statusFiles.removeAll();
		} catch (err) {
			debugLog("herdr status files removal failed", err);
		}
	}

	private schedule(label: string, job: () => Promise<void>): void {
		if (this.disposed) return;
		void this.deps.queue.enqueue(label, job);
	}

	private onFileReady(record: Subagent, file: string): void {
		this.schedule(`file ready ${record.id}`, () => this.fileReady(record, file));
	}

	/** A resume with a live viewer brings it back; any other run waits for its `outputFile`. */
	private async runStarted(record: Subagent): Promise<void> {
		const known = this.deps.registry.byKey(record.id);
		if (known === undefined) {
			this.poller.watch(record);
			return;
		}
		const live = await this.deps.processes.isLive(known.terminal);
		if (this.disposed) return;
		if (live) {
			this.writeStatus(known.key, { state: "running" });
			await this.deps.column.place(known.viewer);
			return;
		}
		await this.forget(known);
		if (this.disposed) return;
		this.poller.watch(record);
	}

	private async runFinished(record: Subagent): Promise<void> {
		this.poller.unwatch(record.id);
		const known = this.deps.registry.byKey(record.id);
		if (known === undefined) return;
		this.writeStatus(known.key, statusFor(record.status));
		await this.deps.column.hide(known.viewer);
	}

	private async fileReady(record: Subagent, outputFile: string): Promise<void> {
		const { registry } = this.deps;
		if (registry.byKey(record.id) !== undefined || registry.byOutputFile(outputFile) !== undefined) return;
		await this.startPlaceRegister(this.recordSource(record, outputFile));
	}

	/**
	 * Starts a viewer, places it when its child runs, then registers it. A viewer
	 * whose start or placement lands after dispose is ended and not registered.
	 */
	private async startPlaceRegister(source: ViewerSource): Promise<ColumnViewer | undefined> {
		const viewer = await this.startViewer(source);
		if (viewer === undefined) return undefined;
		if (statusFor(source.status).state === "running") {
			await this.deps.column.place(viewer);
			if (this.endIfDisposed(viewer.terminal)) return undefined;
		}
		this.deps.registry.add(source.key, { terminal: viewer.terminal, outputFile: source.outputFile, viewer });
		return viewer;
	}

	/** A failed write only loses the viewer's status line; the column work goes on. Never recreates the dir after dispose. */
	private writeStatus(key: string, s: ViewerStatus): void {
		if (this.disposed) return;
		try {
			this.deps.statusFiles.write(key, s);
		} catch (err) {
			debugLog(`herdr status write failed for ${key}`, err);
		}
	}

	private async openNow(entry: NavigationEntry, outputFile: string): Promise<boolean> {
		const id = entry.kind === "live" ? entry.record.id : undefined;
		const known =
			(id === undefined ? undefined : this.deps.registry.byKey(id)) ?? this.deps.registry.byOutputFile(outputFile);
		const running = entry.kind === "live" && entry.record.status === "running";
		if (known !== undefined && running && this.deps.column.isPlaced(known.viewer)) {
			return this.deps.column.focus(known.viewer);
		}
		const viewer = await this.liveViewer(known, this.entrySource(entry, outputFile));
		if (viewer === undefined || this.disposed) return false;
		return this.deps.column.peek(viewer);
	}

	/** The known viewer while its terminal is live; otherwise a newly started (and, if running, placed) one. */
	private async liveViewer(known: RegisteredViewer | undefined, source: ViewerSource): Promise<ColumnViewer | undefined> {
		if (known !== undefined) {
			const live = await this.deps.processes.isLive(known.terminal);
			if (this.disposed) return undefined;
			if (live) return known.viewer;
			await this.forget(known);
			if (this.disposed) return undefined;
		}
		return this.startPlaceRegister(source);
	}

	/** Writes the initial status and starts the terminal; a start that lands after dispose is ended. */
	private async startViewer(source: ViewerSource): Promise<ColumnViewer | undefined> {
		const { statusFiles, processes, cwd } = this.deps;
		this.writeStatus(source.key, statusFor(source.status));
		const terminal = await processes.start({
			key: source.key,
			agentType: source.agentType,
			title: source.title,
			outputFile: source.outputFile,
			cwd,
			statusFile: statusFiles.pathFor(source.key),
		});
		if (terminal === undefined || this.endIfDisposed(terminal)) return undefined;
		return { terminal };
	}

	private endIfDisposed(terminal: string): boolean {
		if (!this.disposed) return false;
		void this.deps.processes.end(terminal);
		return true;
	}

	/** Drops a viewer whose terminal is gone, from the column and the registry. */
	private async forget(known: RegisteredViewer): Promise<void> {
		this.deps.registry.remove(known.key);
		await this.deps.column.hide(known.viewer);
	}

	private recordSource(record: Pick<Subagent, "id" | "type" | "description" | "status">, outputFile: string): ViewerSource {
		return {
			key: record.id,
			agentType: record.type,
			title: this.deps.titleOf(record),
			outputFile,
			status: record.status,
		};
	}

	private entrySource(entry: NavigationEntry, outputFile: string): ViewerSource {
		if (entry.kind === "live") return this.recordSource(entry.record, outputFile);
		return {
			key: fileViewerKey(outputFile),
			agentType: entry.heading.name,
			title: `${entry.heading.name} · ${entry.heading.description}`,
			outputFile,
			status: undefined,
		};
	}
}

/** Forwards lifecycle hooks to the current session's `HerdrViewers`, when there is one. */
export class HerdrViewersSlot implements SubagentManagerObserver {
	private current: HerdrViewers | undefined;

	set(v: HerdrViewers | undefined): void {
		this.current = v;
	}

	get(): HerdrViewers | undefined {
		return this.current;
	}

	onSubagentRunStarted(record: Subagent, kind: RunKind): void {
		this.current?.onSubagentRunStarted(record, kind);
	}

	onSubagentRunFinished(record: Subagent, kind: RunKind): void {
		this.current?.onSubagentRunFinished(record, kind);
	}

	onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
		this.current?.onSubagentCompacted(record, info);
	}

	onSubagentCreated(record: Subagent): void {
		this.current?.onSubagentCreated(record);
	}
}
