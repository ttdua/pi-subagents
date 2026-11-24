import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HerdrCli, type HerdrCommand, HerdrQueue, type HerdrResult } from "#src/herdr/cli";
import { ViewerColumn } from "#src/herdr/column";
import { DISPOSE_CAP_MS, HerdrViewers, HerdrViewersSlot } from "#src/herdr/herdr-observer";
import { OutputFilePoller } from "#src/herdr/output-file-poller";
import { ViewerProcesses } from "#src/herdr/viewer-process";
import { ViewerRegistry } from "#src/herdr/viewer-registry";
import type { ViewerTarget } from "#src/herdr/viewer-source";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { NavigableSubagent, NavigationEntry } from "#src/ui/session-navigation";
import { FakeHerdrApp } from "./fake-herdr-app";

const CTX = { terminalId: "t3s", spaceId: "sp1", tabId: "tb1", parentPaneId: "p1" };

interface StubRecord {
	id: string;
	type: string;
	description: string;
	status: SubagentStatus;
	outputFile: string | undefined;
}

const ok = (value: unknown): HerdrResult => ({ code: 0, stdout: JSON.stringify(value) });
const sub = (r: StubRecord) => r as unknown as Subagent;
const rec = (id: string, over: Partial<StubRecord> = {}): StubRecord => ({
	id,
	type: "explore",
	description: `task ${id}`,
	status: "running",
	outputFile: undefined,
	...over,
});
const liveEntry = (r: StubRecord): NavigationEntry => ({
	kind: "live",
	label: r.id,
	heading: { name: "Explore", modeLabel: undefined, description: r.description },
	record: r as unknown as NavigableSubagent,
});
const snapshotEntry = (outputFile: string, description = "old task"): NavigationEntry => ({
	kind: "snapshot",
	label: "old",
	heading: { name: "Explore", modeLabel: undefined, description },
	outputFile,
});

/** Delegates to the fake app, optionally holding replies of one command until released. */
class GatedCli implements HerdrCli {
	private readonly holds = new Map<string, Promise<void>>();

	constructor(private readonly inner: HerdrCli) {}

	/** Holds `hc <sub>` or `herdr-app [do] <sub>` replies until the returned function runs. */
	hold(key: string): () => void {
		let release = () => {};
		this.holds.set(
			key,
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return () => {
			this.holds.delete(key);
			release();
		};
	}

	/** Receives `hc run` / `hc rm` as they complete, to order them against frame calls. */
	onCall: ((entry: string) => void) | undefined;

	async run(command: HerdrCommand, args: readonly string[]): Promise<HerdrResult> {
		const sub = command === "herdr-app" && args[0] === "do" ? args[1] : args[0];
		const result = await this.inner.run(command, args);
		if (command === "hc" && (sub === "run" || sub === "rm")) this.onCall?.(`hc ${sub}`);
		const hold = this.holds.get(`${command} ${sub}`);
		if (hold !== undefined) await hold;
		return result;
	}
}

/** Records frame-server calls; `socket` undefined simulates a server that cannot listen. */
function fakeFrames() {
	const log: string[] = [];
	const registered: Array<[string, ViewerTarget]> = [];
	const state: { socket: string | undefined } = { socket: "/tmp/pi/99/s.sock" };
	const frames = {
		socketPath: async () => state.socket,
		register: (key: string, target: ViewerTarget) => {
			log.push(`register ${key}`);
			registered.push([key, target]);
		},
		refresh: (key: string) => {
			log.push(`refresh ${key}`);
		},
		unregister: (key: string) => {
			log.push(`unregister ${key}`);
		},
		close: async () => {
			log.push("close");
		},
	};
	return { frames, log, registered, state };
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const never = () => new Promise<void>(() => {});

function setup(opts: { disposeSleep?: (ms: number) => Promise<void> } = {}) {
	const app = new FakeHerdrApp();
	const live = new Set<string>();
	const runFailsFor = new Set<string>();
	let next = 10;
	app.cli.reply(["run"], (args) => {
		if (args.some((a) => runFailsFor.has(a))) return { code: 1, stdout: "" };
		const address = `t${next++}`;
		live.add(address);
		return ok({ address, state: "live", parent: "t3s" });
	});
	app.cli.reply(["get"], (args) => ok({ address: args[1], state: live.has(args[1] ?? "") ? "live" : "finished" }));
	app.cli.reply(["keep"], ok({}));
	app.cli.reply(["kill"], (args) => {
		live.delete(args[1] ?? "");
		return ok({});
	});
	app.cli.reply(["rm"], ok({}));

	const cli = new GatedCli(app.cli);
	const root = mkdtempSync(join(tmpdir(), "herdr-observer-"));
	roots.push(root);
	const queue = new HerdrQueue();
	const column = new ViewerColumn(CTX, cli, async () => {});
	const registry = new ViewerRegistry();
	const fake = fakeFrames();
	cli.onCall = (entry) => fake.log.push(entry);
	const missing = new Set<string>();
	let pollFn: (() => void) | undefined;
	const timers = {
		setInterval: (fn: () => void) => {
			pollFn = fn;
			return 1;
		},
		clearInterval: () => {
			pollFn = undefined;
		},
	};
	const viewers = new HerdrViewers({
		column,
		processes: new ViewerProcesses(cli, { runtime: ["/rt/bun"], viewerPath: "/v.ts", pid: 99, parentTerminal: "t3s" }),
		frames: fake.frames,
		registry,
		createPoller: (onReady) => new OutputFilePoller(onReady, timers),
		queue,
		cwd: "/work",
		headingOf: (r) => ({ name: "Explore", modeLabel: undefined, description: r.description }),
		fileExists: (p) => !missing.has(p),
		sleep: opts.disposeSleep ?? never,
	});

	const flush = () => queue.enqueue("flush", async () => {});
	const tick = () => pollFn?.();
	const calls = () => app.cli.calls.map((c) => [c.command, ...c.args].join(" "));
	const runs = () => app.cli.calls.filter((c) => c.command === "hc" && c.args[0] === "run");
	const doCalls = (name: string) => calls().filter((c) => c.startsWith(`herdr-app do ${name} `));
	const viewerOf = (key: string) => registry.byKey(key)?.viewer;

	/** Start hook, file appears, poll fires, queue drains. */
	async function startChild(r: StubRecord) {
		viewers.onSubagentRunStarted(sub(r), "initial");
		await flush();
		r.outputFile ??= `/s/${r.id}.jsonl`;
		tick();
		await flush();
	}
	async function finishChild(r: StubRecord, s: SubagentStatus = "completed") {
		r.status = s;
		viewers.onSubagentRunFinished(sub(r), "initial");
		await flush();
	}
	async function resumeChild(r: StubRecord) {
		r.status = "running";
		viewers.onSubagentRunStarted(sub(r), "resume");
		await flush();
		tick();
		await flush();
	}

	return {
		app,
		cli,
		live,
		runFailsFor,
		missing,
		root,
		column,
		registry,
		frames: fake,
		viewers,
		flush,
		tick,
		calls,
		runs,
		doCalls,
		viewerOf,
		startChild,
		finishChild,
		resumeChild,
		isPolling: () => pollFn !== undefined,
	};
}

describe("HerdrViewers: viewer per child", () => {
	it("Background child gets a viewer", async () => {
		const h = setup();
		const r = rec("a1b2c3d4");
		await h.startChild(r);
		expect(h.runs()).toHaveLength(1);
		const args = h.runs()[0]?.args ?? [];
		expect(args.slice(0, 4)).toEqual(["run", "--bg", "--json", "--name"]);
		expect(args).toContain("/tmp/pi/99/s.sock");
		expect(args[args.indexOf("--key") + 1]).toBe("a1b2c3d4");
		expect(h.frames.registered[0]?.[0]).toBe("a1b2c3d4");
		expect(h.frames.registered[0]?.[1]).toMatchObject({ kind: "record", heading: { description: "task a1b2c3d4" } });
		expect(h.doCalls("terminal.keep")).toEqual(["herdr-app do terminal.keep --terminal t10 --place right"]);
	});

	it("Foreground child gets a viewer (start then keep)", async () => {
		const h = setup();
		await h.startChild(rec("fg"));
		const all = h.calls();
		const runAt = all.findIndex((c) => c.startsWith("hc run"));
		const keepAt = all.findIndex((c) => c.startsWith("herdr-app do terminal.keep"));
		expect(runAt).toBeGreaterThanOrEqual(0);
		expect(keepAt).toBeGreaterThan(runAt);
	});

	it("No session file", async () => {
		const h = setup();
		const r = rec("nofile");
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.finishChild(r);
		h.tick();
		await h.flush();
		expect(h.runs()).toHaveLength(0);
		expect(h.isPolling()).toBe(false);
	});

	it("Finish without a viewer clears the pending watch", async () => {
		const h = setup();
		const r = rec("pending");
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		expect(h.isPolling()).toBe(true);
		await h.finishChild(r, "stopped");
		expect(h.isPolling()).toBe(false);
		r.outputFile = "/s/pending.jsonl";
		h.tick();
		await h.flush();
		expect(h.calls()).toEqual([]);
	});

	it("Resume reuses the viewer", async () => {
		const h = setup();
		const r = rec("re");
		await h.startChild(r);
		await h.finishChild(r);
		await h.resumeChild(r);
		expect(h.runs()).toHaveLength(1);
		expect(h.calls()).toContain("hc get t10 --json");
	});

	it("Resumed child returns", async () => {
		const h = setup();
		const r = rec("back");
		await h.startChild(r);
		await h.finishChild(r);
		expect(h.doCalls("terminal.park")).toHaveLength(1);
		await h.resumeChild(r);
		expect(h.doCalls("terminal.keep")).toHaveLength(2);
		expect(h.column.isPlaced(h.viewerOf("back") ?? { terminal: "" })).toBe(true);
	});

	it("Resume after the viewer was closed", async () => {
		const h = setup();
		const r = rec("closed");
		await h.startChild(r);
		await h.finishChild(r);
		h.live.delete("t10");
		await h.resumeChild(r);
		expect(h.runs()).toHaveLength(2);
		expect(h.registry.byKey("closed")?.terminal).toBe("t11");
	});
});

describe("HerdrViewers: finished children", () => {
	it.each([
		["Completed child hides", "completed"],
		["Failed child hides", "error"],
		["Stopped child hides", "stopped"],
		["Aborted counts as finished", "aborted"],
	] as const)("%s", async (_name, finalStatus) => {
		const h = setup();
		const r = rec("fin");
		await h.startChild(r);
		const refreshes = () => h.frames.log.filter((e) => e === "refresh fin").length;
		expect(refreshes()).toBe(1);
		await h.finishChild(r, finalStatus);
		expect(refreshes()).toBe(2);
		const target = h.frames.registered[0]?.[1];
		expect(target?.kind === "record" && target.record).toBe(r);
		expect(r.status).toBe(finalStatus);
		expect(h.doCalls("terminal.park")).toEqual(["herdr-app do terminal.park --terminal t10"]);
		expect(h.calls()).not.toContain("hc kill t10");
	});

	it("Waiting child finishes", async () => {
		const h = setup();
		const records = ["a", "b", "c", "d", "e"].map((id) => rec(id));
		for (const r of records) await h.startChild(r);
		const fifth = records[4] as StubRecord;
		expect(h.column.isWaiting(h.viewerOf("e") ?? { terminal: "" })).toBe(true);
		const refreshes = () => h.frames.log.filter((e) => e === "refresh e").length;
		const before = refreshes();
		await h.finishChild(fifth);
		expect(refreshes()).toBe(before + 1);
		const target = h.frames.registered.find(([k]) => k === "e")?.[1];
		expect(target?.kind === "record" && target.record).toBe(fifth);
		expect(fifth.status).toBe("completed");
		expect(h.calls().filter((c) => c.includes("--terminal t14"))).toEqual([]);
		expect(h.column.isWaiting(h.viewerOf("e") ?? { terminal: "" })).toBe(false);
	});

	it("Resumed child waits when the column is full", async () => {
		const h = setup();
		const first = rec("first");
		await h.startChild(first);
		await h.finishChild(first);
		for (const id of ["b", "c", "d", "e"]) await h.startChild(rec(id));
		const refreshes = () => h.frames.log.filter((e) => e === "refresh first").length;
		const before = refreshes();
		await h.resumeChild(first);
		expect(refreshes()).toBe(before + 1);
		expect(h.frames.registered.filter(([k]) => k === "first")).toHaveLength(1);
		expect(h.column.isWaiting(h.viewerOf("first") ?? { terminal: "" })).toBe(true);
		expect(h.doCalls("terminal.keep").filter((c) => c.includes("t10 "))).toHaveLength(1);
	});
});

describe("HerdrViewers: frames", () => {
	it("registers the target before the viewer starts", async () => {
		const h = setup();
		const r = rec("ord");
		await h.startChild(r);
		const log = h.frames.log;
		expect(log.indexOf("register ord")).toBeGreaterThanOrEqual(0);
		expect(log.indexOf("register ord")).toBeLessThan(log.indexOf("hc run"));
		const [key, target] = h.frames.registered[0] ?? [];
		expect(key).toBe("ord");
		expect(target).toEqual({
			kind: "record",
			record: r,
			heading: { name: "Explore", modeLabel: undefined, description: "task ord" },
		});
		expect(target?.kind === "record" && target.record).toBe(r);
	});

	it("refreshes the frame before queued placement", async () => {
		const h = setup();
		const r = rec("early");
		await h.startChild(r);
		const release = h.cli.hold("herdr-app terminal.keep");
		r.outputFile = "/s/early.jsonl";
		h.viewers.onSubagentRunFinished(sub(r), "initial");
		await h.flush();
		r.status = "running";
		h.viewers.onSubagentRunStarted(sub(r), "resume");
		await vi.waitFor(() => expect(h.doCalls("terminal.keep")).toHaveLength(2));
		const before = h.frames.log.filter((e) => e === "refresh early").length;
		r.status = "completed";
		h.viewers.onSubagentRunFinished(sub(r), "resume");
		expect(h.frames.log.filter((e) => e === "refresh early")).toHaveLength(before + 1);
		release();
		await h.flush();
		expect(h.doCalls("terminal.park")).toHaveLength(2);
	});

	it("no viewer without a socket", async () => {
		const h = setup();
		h.frames.state.socket = undefined;
		await h.startChild(rec("nosock"));
		expect(h.runs()).toHaveLength(0);
		expect(h.frames.registered).toEqual([]);
	});

	it("unregisters the target when the viewer start fails", async () => {
		const h = setup();
		h.runFailsFor.add("bad");
		await h.startChild(rec("bad"));
		expect(h.frames.log.filter((e) => e.endsWith(" bad"))).toEqual(["refresh bad", "register bad", "unregister bad"]);
	});

	it("unregisters the target when the viewer start rejects", async () => {
		const h = setup();
		h.cli.run = async () => {
			throw new Error("exec down");
		};
		const r = rec("rej", { outputFile: "/s/rej.jsonl" });
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		h.tick();
		await h.flush();
		expect(h.frames.log).toContain("unregister rej");
	});

	it("unregisters a viewer whose terminal is gone", async () => {
		const h = setup();
		const r = rec("gone2");
		await h.startChild(r);
		await h.finishChild(r);
		h.live.delete("t10");
		await h.resumeChild(r);
		expect(h.frames.log).toContain("unregister gone2");
	});

	it("closes the frame server after the terminals end", async () => {
		const h = setup();
		await h.startChild(rec("cl"));
		const release = h.cli.hold("hc rm");
		const disposed = h.viewers.dispose();
		await vi.waitFor(() => expect(h.frames.log).toContain("hc rm"));
		await h.flush();
		expect(h.frames.log).not.toContain("close");
		release();
		await disposed;
		expect(h.frames.log.indexOf("close")).toBeGreaterThan(h.frames.log.indexOf("hc rm"));
		expect(h.frames.log.at(-1)).toBe("close");
	});
});

describe("HerdrViewers.open", () => {
	it("Running agent focused", async () => {
		const h = setup();
		const r = rec("run");
		await h.startChild(r);
		h.app.focused = "p1";
		expect(await h.viewers.open(liveEntry(r))).toBe(true);
		expect(h.doCalls("pane.focus").at(-1)).toBe("herdr-app do pane.focus --pane p10");
		expect(h.doCalls("terminal.peek")).toEqual([]);
	});

	it("Finished agent in a popup", async () => {
		const h = setup();
		const r = rec("done");
		await h.startChild(r);
		await h.finishChild(r);
		expect(await h.viewers.open(liveEntry(r))).toBe(true);
		expect(h.doCalls("terminal.peek")).toEqual(["herdr-app do terminal.peek --terminal t10"]);
		expect(h.runs()).toHaveLength(1);
	});

	it("Waiting agent in a popup", async () => {
		const h = setup();
		const records = ["a", "b", "c", "d", "e"].map((id) => rec(id));
		for (const r of records) await h.startChild(r);
		expect(await h.viewers.open(liveEntry(records[4] as StubRecord))).toBe(true);
		expect(h.doCalls("terminal.peek")).toEqual(["herdr-app do terminal.peek --terminal t14"]);
	});

	it("Agent from before a reload", async () => {
		const h = setup();
		const file = "/s/old.jsonl";
		const key = `f-${createHash("sha1").update(file).digest("hex").slice(0, 10)}`;
		expect(await h.viewers.open(snapshotEntry(file))).toBe(true);
		const args = h.runs()[0]?.args ?? [];
		expect(args[args.indexOf("--key") + 1]).toBe(key);
		expect(h.frames.registered).toEqual([
			[key, { kind: "file", outputFile: file, heading: { name: "Explore", modeLabel: undefined, description: "old task" } }],
		]);
		expect(args[args.indexOf("--name") + 1]).toBe(`explore-${key.slice(0, 6)}`);
		expect(h.doCalls("terminal.keep")).toEqual([]);
		expect(h.doCalls("terminal.peek")).toEqual(["herdr-app do terminal.peek --terminal t10"]);
		expect(h.registry.byKey(key)?.terminal).toBe("t10");
	});

	it("starts a finished live record's viewer with its done status", async () => {
		const h = setup();
		const r = rec("old", { status: "error", outputFile: "/s/old.jsonl" });
		expect(await h.viewers.open(liveEntry(r))).toBe(true);
		const target = h.frames.registered[0]?.[1];
		expect(h.frames.registered[0]?.[0]).toBe("old");
		expect(target?.kind === "record" && target.record).toBe(r);
		expect(target?.kind === "record" && target.record.status).toBe("error");
		expect(h.doCalls("terminal.peek")).toHaveLength(1);
	});

	it("Herdr fails", async () => {
		const h = setup();
		h.app.peekErrors = 99;
		expect(await h.viewers.open(snapshotEntry("/s/old.jsonl"))).toBe(false);
	});

	it("Agent without a file", async () => {
		const h = setup();
		expect(await h.viewers.open(liveEntry(rec("nofile")))).toBe(false);
		expect(h.calls()).toEqual([]);
	});

	it("returns false with no call when the file does not exist", async () => {
		const h = setup();
		h.missing.add("/s/gone.jsonl");
		expect(await h.viewers.open(snapshotEntry("/s/gone.jsonl"))).toBe(false);
		expect(h.calls()).toEqual([]);
	});

	it("open reuses a viewer for a released record", async () => {
		const h = setup();
		const r = rec("rel");
		await h.startChild(r);
		await h.finishChild(r);
		expect(await h.viewers.open(snapshotEntry("/s/rel.jsonl"))).toBe(true);
		expect(h.runs()).toHaveLength(1);
		expect(h.doCalls("terminal.peek")).toEqual(["herdr-app do terminal.peek --terminal t10"]);
	});

	it("poller does not start a second viewer", async () => {
		const h = setup();
		const r = rec("both");
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		r.outputFile = "/s/both.jsonl";
		expect(await h.viewers.open(liveEntry(r))).toBe(true);
		h.tick();
		await h.flush();
		expect(h.runs()).toHaveLength(1);
	});

	it("places a running record opened before its viewer started", async () => {
		const h = setup();
		const r = rec("early");
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		r.outputFile = "/s/early.jsonl";
		expect(await h.viewers.open(liveEntry(r))).toBe(true);
		expect(h.doCalls("terminal.keep")).toEqual(["herdr-app do terminal.keep --terminal t10 --place right"]);
		expect(h.column.isPlaced(h.viewerOf("early") ?? { terminal: "" })).toBe(true);
		h.tick();
		await h.flush();
		expect(h.runs()).toHaveLength(1);
		expect(h.doCalls("terminal.keep")).toHaveLength(1);
	});
});

describe("HerdrViewers: ordering and failure isolation", () => {
	it("places concurrent viewers one after another", async () => {
		const h = setup();
		const records = ["a", "b", "c"].map((id) => rec(id));
		for (const r of records) h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		for (const r of records) r.outputFile = `/s/${r.id}.jsonl`;
		h.tick();
		await h.flush();
		expect(h.doCalls("terminal.keep")).toEqual([
			"herdr-app do terminal.keep --terminal t10 --place right",
			"herdr-app do terminal.keep --terminal t11 --place down",
			"herdr-app do terminal.keep --terminal t12 --place down",
		]);
		const all = h.calls();
		expect(all.indexOf("herdr-app do pane.focus --pane p10")).toBeGreaterThan(
			all.indexOf("herdr-app do terminal.keep --terminal t10 --place right"),
		);
		expect(all.findIndex((c) => c.includes("run --bg") && c.includes("--key b"))).toBeGreaterThan(
			all.indexOf("herdr-app do terminal.keep --terminal t10 --place right"),
		);
	});

	it("Herdr command hangs", async () => {
		const h = setup();
		h.cli.hold("herdr-app status");
		const r = rec("hang", { outputFile: "/s/hang.jsonl" });
		expect(h.viewers.onSubagentRunStarted(sub(r), "initial")).toBeUndefined();
		await h.flush();
		h.tick();
		await vi.waitFor(() => expect(h.calls()).toContain("herdr-app status"));
		r.status = "completed";
		expect(h.viewers.onSubagentRunFinished(sub(r), "initial")).toBeUndefined();
		expect(h.viewers.onSubagentRunStarted(sub(rec("other")), "initial")).toBeUndefined();
		expect(h.doCalls("terminal.keep")).toEqual([]);
	});

	it("hides a finished child even when its frame refresh fails", async () => {
		const h = setup();
		const r = rec("nodisk");
		await h.startChild(r);
		h.frames.frames.refresh = () => {
			throw new Error("boom");
		};
		await h.finishChild(r);
		expect(h.doCalls("terminal.park")).toEqual(["herdr-app do terminal.park --terminal t10"]);
	});

	it("hc fails mid-session", async () => {
		const h = setup();
		h.runFailsFor.add("bad");
		await h.startChild(rec("bad"));
		await h.startChild(rec("good"));
		expect(h.registry.byKey("bad")).toBeUndefined();
		expect(h.registry.byKey("good")?.terminal).toBe("t10");
		expect(h.doCalls("terminal.keep")).toEqual(["herdr-app do terminal.keep --terminal t10 --place right"]);
	});
});

describe("HerdrViewers.dispose", () => {
	it("Session shutdown", async () => {
		const h = setup();
		const hidden = rec("hidden");
		await h.startChild(hidden);
		await h.finishChild(hidden);
		await h.startChild(rec("shown"));
		await h.viewers.dispose();
		const all = h.calls();
		for (const t of ["t10", "t11"]) {
			const keepOff = all.indexOf(`hc keep ${t} --off`);
			expect(keepOff).toBeGreaterThanOrEqual(0);
			expect(all.indexOf(`hc kill ${t}`)).toBeGreaterThan(keepOff);
			expect(all.indexOf(`hc rm ${t}`)).toBeGreaterThan(all.indexOf(`hc kill ${t}`));
		}
		expect(h.frames.log).toContain("close");
	});

	it("Reload", async () => {
		const h = setup();
		const r = rec("rl");
		await h.startChild(r);
		await h.viewers.dispose();
		expect(h.calls()).toContain("hc rm t10");
		const before = h.calls().length;
		expect(await h.viewers.open(liveEntry(r))).toBe(false);
		expect(h.calls()).toHaveLength(before);
	});

	it("resolves within DISPOSE_CAP_MS when hc kill never answers, ending viewers in parallel", async () => {
		const sleeps: number[] = [];
		const h = setup({
			disposeSleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await h.startChild(rec("a"));
		await h.startChild(rec("b"));
		h.cli.hold("hc kill");
		await h.viewers.dispose();
		expect(sleeps).toEqual([DISPOSE_CAP_MS]);
		await vi.waitFor(() => {
			expect(h.calls()).toContain("hc kill t10");
			expect(h.calls()).toContain("hc kill t11");
		});
		expect(h.frames.log).toContain("close");
	});

	it("drops queued jobs after dispose", async () => {
		const h = setup();
		const release = h.cli.hold("herdr-app status");
		const records = ["a", "b", "c"].map((id) => rec(id));
		for (const r of records) h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		for (const r of records) r.outputFile = `/s/${r.id}.jsonl`;
		h.tick();
		await vi.waitFor(() => expect(h.calls()).toContain("herdr-app status"));
		const disposed = h.viewers.dispose();
		release();
		await disposed;
		await h.flush();
		expect(h.runs()).toHaveLength(1);
		await vi.waitFor(() => expect(h.calls()).toContain("hc kill t10"));
	});

	it("Late lifecycle hooks after shutdown", async () => {
		const h = setup();
		const r = rec("late");
		await h.startChild(r);
		await h.viewers.dispose();
		const before = h.calls().length;
		r.status = "aborted";
		h.viewers.onSubagentRunFinished(sub(r), "initial");
		h.viewers.onSubagentRunStarted(sub(rec("new", { outputFile: "/s/new.jsonl" })), "initial");
		h.tick();
		await h.flush();
		expect(h.calls()).toHaveLength(before);
	});

	it("ends a viewer whose start resolves after dispose", async () => {
		const h = setup();
		const release = h.cli.hold("hc run");
		const r = rec("slow", { outputFile: "/s/slow.jsonl" });
		h.viewers.onSubagentRunStarted(sub(r), "initial");
		await h.flush();
		h.tick();
		await vi.waitFor(() => expect(h.runs()).toHaveLength(1));
		const disposed = h.viewers.dispose();
		release();
		await disposed;
		await vi.waitFor(() => expect(h.calls()).toContain("hc kill t10"));
		expect(h.doCalls("terminal.keep")).toEqual([]);
		expect(h.registry.byKey("slow")).toBeUndefined();
	});
});

describe("HerdrViewers: jobs in flight when dispose starts", () => {
	it("a resume whose liveness check answers after dispose does not place or write", async () => {
		const h = setup();
		const r = rec("res");
		await h.startChild(r);
		await h.finishChild(r);
		const keeps = h.doCalls("terminal.keep").length;
		const release = h.cli.hold("hc get");
		r.status = "running";
		h.viewers.onSubagentRunStarted(sub(r), "resume");
		await vi.waitFor(() => expect(h.calls()).toContain("hc get t10 --json"));
		await h.viewers.dispose();
		release();
		await h.flush();
		expect(h.doCalls("terminal.keep")).toHaveLength(keeps);
		expect(h.frames.log).toContain("close");
	});

	it("a resume of a closed viewer answering after dispose does not hide or restart", async () => {
		const h = setup();
		const r = rec("gone");
		await h.startChild(r);
		h.live.delete("t10");
		const release = h.cli.hold("hc get");
		h.viewers.onSubagentRunStarted(sub(r), "resume");
		await vi.waitFor(() => expect(h.calls()).toContain("hc get t10 --json"));
		await h.viewers.dispose();
		release();
		await h.flush();
		h.tick();
		await h.flush();
		expect(h.doCalls("terminal.park")).toEqual([]);
		expect(h.runs()).toHaveLength(1);
	});

	it("an open whose liveness check answers after dispose does not peek", async () => {
		const h = setup();
		const r = rec("op");
		await h.startChild(r);
		await h.finishChild(r);
		const release = h.cli.hold("hc get");
		const opened = h.viewers.open(liveEntry(r));
		await vi.waitFor(() => expect(h.calls()).toContain("hc get t10 --json"));
		await h.viewers.dispose();
		release();
		expect(await opened).toBe(false);
		expect(h.doCalls("terminal.peek")).toEqual([]);
		expect(h.frames.log).toContain("close");
	});

	it("an open whose new viewer is being placed at dispose ends it and does not peek", async () => {
		const h = setup();
		const r = rec("opn", { outputFile: "/s/opn.jsonl" });
		const release = h.cli.hold("herdr-app status");
		const opened = h.viewers.open(liveEntry(r));
		await vi.waitFor(() => expect(h.calls()).toContain("herdr-app status"));
		await h.viewers.dispose();
		release();
		expect(await opened).toBe(false);
		expect(h.doCalls("terminal.peek")).toEqual([]);
		await vi.waitFor(() => expect(h.calls()).toContain("hc kill t10"));
	});
});

describe("HerdrViewersSlot", () => {
	it("forwards only when set", () => {
		const slot = new HerdrViewersSlot();
		const r = sub(rec("s"));
		expect(() => {
			slot.onSubagentRunStarted(r, "initial");
			slot.onSubagentRunFinished(r, "initial");
			slot.onSubagentCreated(r);
			slot.onSubagentCompacted(r, { tokensBefore: 1 } as never);
		}).not.toThrow();
		const target = {
			onSubagentRunStarted: vi.fn(),
			onSubagentRunFinished: vi.fn(),
			onSubagentCreated: vi.fn(),
			onSubagentCompacted: vi.fn(),
		};
		slot.set(target as unknown as HerdrViewers);
		expect(slot.get()).toBe(target);
		slot.onSubagentRunStarted(r, "resume");
		slot.onSubagentRunFinished(r, "resume");
		expect(target.onSubagentRunStarted).toHaveBeenCalledWith(r, "resume");
		expect(target.onSubagentRunFinished).toHaveBeenCalledWith(r, "resume");
		slot.set(undefined);
		slot.onSubagentRunStarted(r, "initial");
		expect(target.onSubagentRunStarted).toHaveBeenCalledTimes(1);
	});
});
