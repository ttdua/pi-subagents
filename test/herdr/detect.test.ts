import { describe, expect, it } from "vitest";
import { detectHerdr } from "#src/herdr/detect";
import { FakeHerdrCli } from "./fake-cli";

const TERMINAL = "t3s";
const INSIDE_ENV = { HC_TERMINAL_ID: TERMINAL };

const hcGet = (labels: unknown = { "herdr.space": "sp1", "herdr.tab": "tb1", where: "x" }) =>
	JSON.stringify({ address: TERMINAL, labels, state: "live" });

const appLs = (terminals: Array<{ terminal: string; pane: string }> = [{ terminal: TERMINAL, pane: "p1" }], tabId = "tb1") =>
	JSON.stringify({
		spaces: [
			{
				id: "sp1",
				name: "main",
				tabs: [{ id: tabId, name: "1", terminals: terminals.map((t) => ({ ...t, status: "working", app: "pi", name: null, sub_agents: [] })) }],
			},
		],
	});

function herdrCli(opts: { get?: string | { code: number }; ls?: string | { code: number } } = {}): FakeHerdrCli {
	const cli = new FakeHerdrCli();
	const get = opts.get ?? hcGet();
	const ls = opts.ls ?? appLs();
	cli.reply(["get", TERMINAL, "--json"], typeof get === "string" ? { code: 0, stdout: get } : { code: get.code, stdout: "" });
	cli.reply(["ls"], typeof ls === "string" ? { code: 0, stdout: ls } : { code: ls.code, stdout: "" });
	return cli;
}

describe("detectHerdr", () => {
	it("Inside Herdr: returns the context when hc labels and herdr-app agree", async () => {
		const cli = herdrCli();

		const ctx = await detectHerdr({ mode: "tui", env: INSIDE_ENV, cli });

		expect(ctx).toEqual({ terminalId: "t3s", spaceId: "sp1", tabId: "tb1", parentPaneId: "p1" });
	});

	it("Outside Herdr: is inactive without HC_TERMINAL_ID and runs no command", async () => {
		const cli = herdrCli();

		expect(await detectHerdr({ mode: "tui", env: {}, cli })).toBeUndefined();
		expect(await detectHerdr({ mode: "tui", env: { HERDR_ENV: "1" }, cli })).toBeUndefined();
		expect(cli.calls).toEqual([]);
	});

	it("Child session: is inactive in print mode and runs no command", async () => {
		const cli = herdrCli();

		expect(await detectHerdr({ mode: "print", env: INSIDE_ENV, cli })).toBeUndefined();
		expect(await detectHerdr({ mode: undefined, env: INSIDE_ENV, cli })).toBeUndefined();
		expect(cli.calls).toEqual([]);
	});

	it("RPC mode: is inactive and runs no command", async () => {
		const cli = herdrCli();

		expect(await detectHerdr({ mode: "rpc", env: INSIDE_ENV, cli })).toBeUndefined();
		expect(cli.calls).toEqual([]);
	});

	it("Terminal not shown by Herdr: is inactive when herdr-app does not list the terminal", async () => {
		const cli = herdrCli({ ls: appLs([{ terminal: "other", pane: "p9" }]) });

		expect(await detectHerdr({ mode: "tui", env: INSIDE_ENV, cli })).toBeUndefined();
	});

	it("Herdr app unreachable: is inactive when herdr-app ls exits non-zero", async () => {
		const cli = herdrCli({ ls: { code: 1 } });

		expect(await detectHerdr({ mode: "tui", env: INSIDE_ENV, cli })).toBeUndefined();
	});

	it("Detection times out: is inactive when hc get fails", async () => {
		const cli = herdrCli({ get: { code: 1 } });

		expect(await detectHerdr({ mode: "tui", env: INSIDE_ENV, cli })).toBeUndefined();
	});

	it.each([
		["a JSON array instead of an object", "[]"],
		["non-JSON output", "not json"],
		["labels given as a string", hcGet("herdr.space,herdr.tab")],
		["a terminal listed in another tab", undefined],
	])("is inactive on malformed hc output: %s", async (_label, get) => {
		const cli =
			get === undefined ? herdrCli({ ls: appLs([{ terminal: TERMINAL, pane: "p1" }], "tb2") }) : herdrCli({ get });

		expect(await detectHerdr({ mode: "tui", env: INSIDE_ENV, cli })).toBeUndefined();
	});
});
