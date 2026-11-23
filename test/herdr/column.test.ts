import { describe, expect, it } from "vitest";
import { type ColumnViewer, MAX_COLUMN, PEEK_ATTEMPTS, PEEK_RETRY_MS, ViewerColumn } from "#src/herdr/column";
import { FakeHerdrApp } from "./fake-herdr-app";

const CTX = { terminalId: "t3s", spaceId: "sp1", tabId: "tb1", parentPaneId: "p1" };

function setup() {
	const app = new FakeHerdrApp();
	const sleeps: number[] = [];
	const column = new ViewerColumn(CTX, app.cli, async (ms) => {
		sleeps.push(ms);
	});
	return { app, column, sleeps };
}

const viewer = (n: number): ColumnViewer => ({ terminal: `t${n}` });
const doCalls = (app: FakeHerdrApp) => app.cli.calls.filter((c) => c.args[0] === "do").map((c) => c.args.join(" "));

describe("ViewerColumn placement", () => {
	it("First viewer opens to the right", async () => {
		const { app, column } = setup();
		const v = viewer(10);
		await column.place(v);
		expect(doCalls(app)).toContain("do pane.focus --pane p1");
		expect(doCalls(app)).toContain("do terminal.keep --terminal t10 --place right");
		expect(v.pane).toBe("p10");
		expect(column.isPlaced(v)).toBe(true);
	});

	it("Further viewers stack below", async () => {
		const { app, column } = setup();
		await column.place(viewer(10));
		await column.place(viewer(11));
		const calls = doCalls(app);
		expect(calls).toContain("do pane.focus --pane p10");
		expect(calls).toContain("do terminal.keep --terminal t11 --place down");
	});

	it("Focus returns", async () => {
		const { app, column } = setup();
		await column.place(viewer(10));
		expect(doCalls(app).at(-1)).toBe("do pane.focus --pane p1");
		expect(app.focused).toBe("p1");
	});

	it("Focus elsewhere is kept", async () => {
		const { app, column } = setup();
		app.panes.push({ terminal: "t9", pane: "p9" });
		app.focused = "p9";
		await column.place(viewer(10));
		expect(doCalls(app).at(-1)).toBe("do pane.focus --pane p9");
	});

	it("Closed pane frees its slot", async () => {
		const { app, column } = setup();
		const first = viewer(10);
		const second = viewer(11);
		await column.place(first);
		await column.place(second);
		app.closePane("p10");
		app.closePane("p11");
		app.cli.calls.length = 0;
		await column.place(viewer(12));
		expect(column.isPlaced(first)).toBe(false);
		expect(column.isPlaced(second)).toBe(false);
		expect(doCalls(app)).toContain("do terminal.keep --terminal t12 --place right");
	});

	it("Fifth child waits", async () => {
		const { app, column } = setup();
		for (let n = 10; n < 10 + MAX_COLUMN; n++) await column.place(viewer(n));
		app.cli.calls.length = 0;
		const fifth = viewer(20);
		await column.place(fifth);
		expect(doCalls(app).some((c) => c.includes("terminal.keep"))).toBe(false);
		expect(column.isWaiting(fifth)).toBe(true);
		expect(column.isPlaced(fifth)).toBe(false);
	});

	it("Waiting viewer moves in", async () => {
		const { app, column } = setup();
		const placed = [10, 11, 12, 13].map(viewer);
		for (const v of placed) await column.place(v);
		const waiting = viewer(20);
		await column.place(waiting);
		await column.hide(placed[0] as ColumnViewer);
		const calls = doCalls(app);
		const parked = calls.indexOf("do terminal.park --terminal t10");
		expect(parked).toBeGreaterThan(-1);
		expect(calls.findIndex((c) => c.startsWith("do terminal.keep --terminal t20"))).toBeGreaterThan(parked);
		expect(column.isPlaced(waiting)).toBe(true);
		expect(column.isWaiting(waiting)).toBe(false);
	});

	it("Waiting order", async () => {
		const { column } = setup();
		const placed = [10, 11, 12, 13].map(viewer);
		for (const v of placed) await column.place(v);
		const a = viewer(20);
		const b = viewer(21);
		await column.place(a);
		await column.place(b);
		await column.hide(placed[0] as ColumnViewer);
		expect(column.isPlaced(a)).toBe(true);
		expect(column.isWaiting(b)).toBe(true);
	});

	it("Placement fails", async () => {
		const { app, column } = setup();
		app.keepFails = true;
		const v = viewer(10);
		await column.place(v);
		expect(v.pane).toBeUndefined();
		expect(column.isPlaced(v)).toBe(false);
		expect(column.isWaiting(v)).toBe(false);
		expect(doCalls(app).at(-1)).toBe("do pane.focus --pane p1");
		app.keepFails = false;
		const next = viewer(11);
		await column.place(next);
		expect(column.isPlaced(next)).toBe(true);
	});

	it("Viewer already closed", async () => {
		const { app, column } = setup();
		const v = viewer(10);
		await column.place(v);
		app.parkFails = true;
		await column.hide(v);
		expect(column.isPlaced(v)).toBe(false);
		const next = viewer(11);
		await column.place(next);
		expect(column.isPlaced(next)).toBe(true);
	});

	it("drops a waiting viewer on hide without park", async () => {
		const { app, column } = setup();
		for (const n of [10, 11, 12, 13]) await column.place(viewer(n));
		const waiting = viewer(20);
		await column.place(waiting);
		app.cli.calls.length = 0;
		await column.hide(waiting);
		expect(column.isWaiting(waiting)).toBe(false);
		expect(doCalls(app).some((c) => c.includes("terminal.park"))).toBe(false);
	});
});

describe("ViewerColumn keep retries", () => {
	it("retries terminal.keep while Herdr has not seen the terminal", async () => {
		const { app, column, sleeps } = setup();
		app.keepUnknownTimes = 2;
		const v = viewer(10);
		await column.place(v);
		expect(column.isPlaced(v)).toBe(true);
		expect(v.pane).toBe("p10");
		expect(doCalls(app).filter((c) => c.includes("terminal.keep"))).toHaveLength(3);
		expect(sleeps).toEqual([PEEK_RETRY_MS, PEEK_RETRY_MS]);
		expect(doCalls(app).at(-1)).toBe("do pane.focus --pane p1");
	});

	it("gives up after PEEK_ATTEMPTS", async () => {
		const { app, column } = setup();
		app.keepUnknownTimes = 99;
		const v = viewer(10);
		await column.place(v);
		expect(column.isPlaced(v)).toBe(false);
		expect(column.isWaiting(v)).toBe(false);
		expect(doCalls(app).filter((c) => c.includes("terminal.keep"))).toHaveLength(PEEK_ATTEMPTS);
		expect(doCalls(app).at(-1)).toBe("do pane.focus --pane p1");
	});

	it("does not retry other keep failures", async () => {
		const { app, column, sleeps } = setup();
		app.keepFails = true;
		await column.place(viewer(10));
		expect(doCalls(app).filter((c) => c.includes("terminal.keep"))).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});
});

describe("ViewerColumn focus and peek", () => {
	it("focuses a placed viewer's pane", async () => {
		const { app, column } = setup();
		const v = viewer(10);
		await column.place(v);
		app.cli.calls.length = 0;
		expect(await column.focus(v)).toBe(true);
		expect(doCalls(app)).toEqual(["do pane.focus --pane p10"]);
	});

	it("does not focus an unplaced viewer", async () => {
		const { app, column } = setup();
		expect(await column.focus(viewer(10))).toBe(false);
		expect(app.cli.calls).toHaveLength(0);
	});

	it("peek succeeds on ok", async () => {
		const { column, sleeps } = setup();
		expect(await column.peek(viewer(10))).toBe(true);
		expect(sleeps).toEqual([]);
	});

	it("peek retries after errors", async () => {
		const { app, column, sleeps } = setup();
		app.peekErrors = 2;
		expect(await column.peek(viewer(10))).toBe(true);
		expect(sleeps).toEqual([PEEK_RETRY_MS, PEEK_RETRY_MS]);
	});

	it("peek gives up after five attempts", async () => {
		const { app, column, sleeps } = setup();
		app.peekErrors = 99;
		expect(await column.peek(viewer(10))).toBe(false);
		const peeks = app.cli.calls.filter((c) => c.args[1] === "terminal.peek");
		expect(peeks).toHaveLength(PEEK_ATTEMPTS);
		expect(sleeps).toHaveLength(PEEK_ATTEMPTS - 1);
	});
});
