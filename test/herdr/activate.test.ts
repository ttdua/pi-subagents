import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { activateHerdrViewers, HerdrActivation } from "#src/herdr/activate";
import { HerdrViewers, HerdrViewersSlot } from "#src/herdr/herdr-observer";
import { FakeHerdrCli } from "./fake-cli";

const TERMINAL = "t3s";

function insideHerdr(): FakeHerdrCli {
	const cli = new FakeHerdrCli();
	cli.reply(["get", TERMINAL, "--json"], {
		code: 0,
		stdout: JSON.stringify({ address: TERMINAL, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" }, state: "live" }),
	});
	cli.reply(["ls"], {
		code: 0,
		stdout: JSON.stringify({
			spaces: [{ id: "sp1", name: "m", tabs: [{ id: "tb1", name: "1", terminals: [{ terminal: TERMINAL, pane: "p1", status: "working", app: "pi", name: null, sub_agents: [] }] }] }],
		}),
	});
	return cli;
}

const headingOf = () => ({ name: "Explore", modeLabel: undefined, description: "d" });
const theme = {} as never;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("activateHerdrViewers", () => {
	it("is undefined without HC_TERMINAL_ID", async () => {
		const cli = insideHerdr();
		expect(await activateHerdrViewers({ mode: "tui", env: {}, cli, cwd: "/tmp", pid: 1, headingOf, theme })).toBeUndefined();
		expect(cli.calls).toEqual([]);
	});

	it("builds HerdrViewers inside Herdr", async () => {
		const viewers = await activateHerdrViewers({ mode: "tui", env: { HC_TERMINAL_ID: TERMINAL }, cli: insideHerdr(), cwd: "/tmp", pid: 4242, headingOf, theme });
		expect(viewers).toBeInstanceOf(HerdrViewers);
		await viewers?.dispose();
	});

	it("passes a viewer program path that exists on disk", async () => {
		const { viewerProgramPath } = await import("#src/herdr/activate");
		expect(existsSync(viewerProgramPath())).toBe(true);
	});
});

describe("HerdrActivation", () => {
	function fakeViewers() {
		return { dispose: vi.fn(async () => {}) } as unknown as HerdrViewers & { dispose: ReturnType<typeof vi.fn> };
	}

	it("forwards the session theme", async () => {
		const activate = vi.fn(async () => undefined);
		new HerdrActivation(new HerdrViewersSlot(), activate).start({ cwd: "/x", mode: "tui", theme });
		expect(activate).toHaveBeenCalledWith("/x", "tui", theme);
	});

	it("installs the instance when activation resolves", async () => {
		const slot = new HerdrViewersSlot();
		const viewers = fakeViewers();
		const activation = new HerdrActivation(slot, async () => viewers);
		activation.start({ cwd: "/x", mode: "tui", theme });
		await flush();
		expect(slot.get()).toBe(viewers);
	});

	it("disposes a result that arrives after stop", async () => {
		const slot = new HerdrViewersSlot();
		const viewers = fakeViewers();
		let resolve!: (v: HerdrViewers) => void;
		const activation = new HerdrActivation(slot, () => new Promise((r) => (resolve = r)));
		activation.start({ cwd: "/x", mode: "tui", theme });
		await activation.stop();
		resolve(viewers);
		await flush();
		expect(slot.get()).toBeUndefined();
		expect(viewers.dispose).toHaveBeenCalledTimes(1);
	});

	it("stop takes the instance out of the slot and disposes it", async () => {
		const slot = new HerdrViewersSlot();
		const viewers = fakeViewers();
		slot.set(viewers);
		await new HerdrActivation(slot, async () => undefined).stop();
		expect(slot.get()).toBeUndefined();
		expect(viewers.dispose).toHaveBeenCalledTimes(1);
	});

	it("a second start disposes the previous instance when it installs the new one", async () => {
		const slot = new HerdrViewersSlot();
		const first = fakeViewers();
		const second = fakeViewers();
		const results = [first, second];
		const activation = new HerdrActivation(slot, async () => results.shift());
		activation.start({ cwd: "/x", mode: "tui", theme });
		await flush();
		activation.start({ cwd: "/x", mode: "tui", theme });
		await flush();
		expect(slot.get()).toBe(second);
		expect(first.dispose).toHaveBeenCalledTimes(1);
	});

	it("survives an activation failure and installs nothing", async () => {
		const slot = new HerdrViewersSlot();
		const activation = new HerdrActivation(slot, async () => {
			throw new Error("boom");
		});
		activation.start({ cwd: "/x", mode: "tui", theme });
		await flush();
		expect(slot.get()).toBeUndefined();
	});

	it("stop swallows a rejecting dispose", async () => {
		const slot = new HerdrViewersSlot();
		slot.set({ dispose: vi.fn(async () => Promise.reject(new Error("x"))) } as unknown as HerdrViewers);
		await expect(new HerdrActivation(slot, async () => undefined).stop()).resolves.toBeUndefined();
	});
});
