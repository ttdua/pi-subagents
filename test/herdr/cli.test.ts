import { describe, expect, it, vi } from "vitest";
import { createExecHerdrCli, HERDR_COMMAND_TIMEOUT_MS, type HerdrExec, HerdrQueue } from "#src/herdr/cli";

const FAILED = { code: 1, stdout: "" };

describe("createExecHerdrCli", () => {
	it("runs commands with the 2000 ms timeout and a copy of the args", async () => {
		const exec = vi.fn<HerdrExec>(async () => ({ code: 0, stdout: "ok" }));
		const cli = createExecHerdrCli(exec);
		const args = ["get", "t3s", "--json"];

		const result = await cli.run("hc", args);

		expect(HERDR_COMMAND_TIMEOUT_MS).toBe(2000);
		expect(exec).toHaveBeenCalledWith("hc", ["get", "t3s", "--json"], { timeout: 2000 });
		expect(exec.mock.calls[0]?.[1]).not.toBe(args);
		expect(result).toEqual({ code: 0, stdout: "ok" });
	});

	it("reports a rejected exec as a failed result", async () => {
		const cli = createExecHerdrCli(async () => {
			throw new Error("spawn ENOENT");
		});
		await expect(cli.run("herdr-app", ["ls"])).resolves.toEqual(FAILED);
	});

	it("reports an undefined exec result as a failed result", async () => {
		const cli = createExecHerdrCli(async () => undefined);
		await expect(cli.run("hc", ["get"])).resolves.toEqual(FAILED);
	});

	it("reports a killed (timed out) exec as a failed result even with code 0", async () => {
		const cli = createExecHerdrCli(async () => ({ killed: true, code: 0, stdout: "partial" }));
		await expect(cli.run("hc", ["get"])).resolves.toEqual(FAILED);
	});
});

describe("HerdrQueue", () => {
	const deferred = () => {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	};

	it("starts each job only after the previous one resolves", async () => {
		const queue = new HerdrQueue();
		const first = deferred();
		const started: string[] = [];

		const a = queue.enqueue("a", async () => {
			started.push("a");
			await first.promise;
		});
		const b = queue.enqueue("b", async () => {
			started.push("b");
		});

		await Promise.resolve();
		expect(started).toEqual(["a"]);
		first.resolve();
		await Promise.all([a, b]);
		expect(started).toEqual(["a", "b"]);
	});

	it("continues with later jobs after a job throws", async () => {
		const queue = new HerdrQueue();
		const ran: string[] = [];

		await expect(
			queue.enqueue("bad", async () => {
				throw new Error("boom");
			}),
		).resolves.toBeUndefined();
		await queue.enqueue("good", async () => {
			ran.push("good");
		});

		expect(ran).toEqual(["good"]);
	});

	it("skips pending and new jobs after close()", async () => {
		const queue = new HerdrQueue();
		const gate = deferred();
		const ran: string[] = [];

		const running = queue.enqueue("running", async () => {
			await gate.promise;
		});
		const pending = queue.enqueue("pending", async () => {
			ran.push("pending");
		});
		queue.close();
		gate.resolve();
		await Promise.all([running, pending]);
		await queue.enqueue("late", async () => {
			ran.push("late");
		});

		expect(ran).toEqual([]);
	});
});
