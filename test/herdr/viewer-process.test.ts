import { describe, expect, it } from "vitest";
import { type ViewerLaunch, ViewerProcesses } from "#src/herdr/viewer-process";
import { FakeHerdrCli } from "./fake-cli";

const OPTS = { runtime: ["/rt/bun"], viewerPath: "/pkg/src/herdr/viewer.ts", pid: 99, parentTerminal: "t3s" };

const launch = (over: Partial<ViewerLaunch> = {}): ViewerLaunch => ({
	key: "a1b2c3d4e5",
	agentType: "explore",
	cwd: "/work",
	socket: "/tmp/pi/99-abc/s.sock",
	...over,
});

const runOk = (address: string) => ({ code: 0, stdout: JSON.stringify({ address, state: "live", parent: "t3s" }) });

describe("ViewerProcesses.start", () => {
	it("runs the viewer with hc run --bg and returns its address", async () => {
		const cli = new FakeHerdrCli();
		cli.reply(["run"], runOk("t48"));
		const address = await new ViewerProcesses(cli, OPTS).start(launch());
		expect(address).toBe("t48");
		expect(cli.calls).toEqual([
			{
				command: "hc",
				args: [
					"run", "--bg", "--json", "--name", "explore-a1b2c3", "--cwd", "/work", "--",
					"/rt/bun", "/pkg/src/herdr/viewer.ts",
					"--socket", "/tmp/pi/99-abc/s.sock", "--key", "a1b2c3d4e5", "--pid", "99",
					"--parent-terminal", "t3s",
				],
			},
		]);
	});

	it("sanitizes the name and caps it at 32 chars", async () => {
		const cli = new FakeHerdrCli();
		cli.reply(["run"], runOk("t1"));
		const processes = new ViewerProcesses(cli, OPTS);
		await processes.start(launch({ agentType: "My Agent!", key: "ABCDEF123" }));
		await processes.start(launch({ agentType: undefined, key: "f-0123456789" }));
		await processes.start(launch({ agentType: "x".repeat(60), key: "abcdef" }));
		const names = cli.calls.map((c) => c.args[c.args.indexOf("--name") + 1]);
		expect(names[0]).toBe("my-agent-abcdef");
		expect(names[1]).toBe("agent-f-0123");
		expect(names[2]?.length).toBeLessThanOrEqual(32);
		expect(names[2]).toMatch(/^[a-z0-9_-]+$/);
	});

	it("retries once without --name when the name is taken", async () => {
		const cli = new FakeHerdrCli();
		cli.reply(["run", "--bg", "--json", "--name"], { code: 1, stdout: "" });
		cli.reply(["run"], runOk("t50"));
		expect(await new ViewerProcesses(cli, OPTS).start(launch())).toBe("t50");
		expect(cli.calls).toHaveLength(2);
		expect(cli.calls[1]?.args).not.toContain("--name");
		expect(cli.calls[1]?.args.slice(0, 5)).toEqual(["run", "--bg", "--json", "--cwd", "/work"]);
	});

	it("returns undefined when both attempts fail", async () => {
		const cli = new FakeHerdrCli();
		expect(await new ViewerProcesses(cli, OPTS).start(launch())).toBeUndefined();
		expect(cli.calls).toHaveLength(2);
	});

	it("skips the retry when the caller stops wanting the viewer", async () => {
		const cli = new FakeHerdrCli();
		let wanted = true;
		cli.reply(["run"], () => {
			wanted = false;
			return { code: 1, stdout: "" };
		});
		expect(await new ViewerProcesses(cli, OPTS).start(launch(), () => wanted)).toBeUndefined();
		expect(cli.calls).toHaveLength(1);
	});

	it("returns undefined when the reply has no address", async () => {
		const cli = new FakeHerdrCli();
		cli.reply(["run"], { code: 0, stdout: "not json" });
		expect(await new ViewerProcesses(cli, OPTS).start(launch())).toBeUndefined();
	});
});

describe("ViewerProcesses.isLive", () => {
	it("is true only for state live", async () => {
		const cli = new FakeHerdrCli();
		cli.reply(["get", "t1"], { code: 0, stdout: JSON.stringify({ address: "t1", state: "live" }) });
		cli.reply(["get", "t2"], { code: 0, stdout: JSON.stringify({ address: "t2", state: "finished" }) });
		cli.reply(["get", "t3"], { code: 0, stdout: "{" });
		const processes = new ViewerProcesses(cli, OPTS);
		expect(await processes.isLive("t1")).toBe(true);
		expect(await processes.isLive("t2")).toBe(false);
		expect(await processes.isLive("t3")).toBe(false);
		expect(await processes.isLive("t4")).toBe(false);
		expect(cli.calls[0]?.args).toEqual(["get", "t1", "--json"]);
	});
});

describe("ViewerProcesses.end", () => {
	it("turns keep off, kills and removes, ignoring failures", async () => {
		const cli = new FakeHerdrCli();
		await new ViewerProcesses(cli, OPTS).end("t48");
		expect(cli.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual([
			"hc keep t48 --off",
			"hc kill t48",
			"hc rm t48",
		]);
	});
});
