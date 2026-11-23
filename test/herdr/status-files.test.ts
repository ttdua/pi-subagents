import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ViewerStatusFiles } from "#src/herdr/status-files";

const roots: string[] = [];
function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "status-files-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ViewerStatusFiles", () => {
	it("puts each key under an unpredictable <root>/<pid>-XXXXXX directory", () => {
		const root = makeRoot();
		const files = new ViewerStatusFiles(root, 42);
		expect(files.pathFor("abc")).toMatch(new RegExp(`^${root}/42-[A-Za-z0-9]{6}/abc\\.json$`));
		expect(files.pathFor("x")).toBe(join(dirname(files.pathFor("abc")), "x.json"));
		expect(new ViewerStatusFiles(root, 42).pathFor("abc")).not.toBe(files.pathFor("abc"));
		expect(statSync(dirname(files.pathFor("abc"))).mode & 0o077).toBe(0);
	});

	it("creates a missing root with mode 0700", () => {
		const root = join(makeRoot(), "nested");
		new ViewerStatusFiles(root, 1).write("a", { state: "running" });
		expect(statSync(root).mode & 0o077).toBe(0);
	});

	it("writes the status JSON with no temp file left", () => {
		const root = makeRoot();
		const files = new ViewerStatusFiles(root, 42);
		files.write("abc", { state: "done", status: "completed" });
		expect(JSON.parse(readFileSync(files.pathFor("abc"), "utf8"))).toEqual({ state: "done", status: "completed" });
		files.write("abc", { state: "running" });
		expect(JSON.parse(readFileSync(files.pathFor("abc"), "utf8"))).toEqual({ state: "running" });
		expect(readdirSync(dirname(files.pathFor("abc")))).toEqual(["abc.json"]);
	});

	it("removeAll deletes <root>/<pid> only", () => {
		const root = makeRoot();
		const mine = new ViewerStatusFiles(root, 42);
		const other = new ViewerStatusFiles(root, 43);
		mine.write("a", { state: "running" });
		const mineDir = dirname(mine.pathFor("a"));
		other.write("b", { state: "running" });
		mine.removeAll();
		expect(existsSync(mineDir)).toBe(false);
		expect(existsSync(other.pathFor("b"))).toBe(true);
	});

	it("removeAll with nothing written does not throw", () => {
		expect(() => new ViewerStatusFiles(makeRoot(), 7).removeAll()).not.toThrow();
	});
});
