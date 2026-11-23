import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	it("puts each key under <root>/<pid>", () => {
		const root = makeRoot();
		expect(new ViewerStatusFiles(root, 42).pathFor("abc")).toBe(join(root, "42", "abc.json"));
	});

	it("writes the status JSON with no temp file left", () => {
		const root = makeRoot();
		const files = new ViewerStatusFiles(root, 42);
		files.write("abc", { state: "done", status: "completed" });
		expect(JSON.parse(readFileSync(files.pathFor("abc"), "utf8"))).toEqual({ state: "done", status: "completed" });
		files.write("abc", { state: "running" });
		expect(JSON.parse(readFileSync(files.pathFor("abc"), "utf8"))).toEqual({ state: "running" });
		expect(readdirSync(join(root, "42"))).toEqual(["abc.json"]);
	});

	it("removeAll deletes <root>/<pid> only", () => {
		const root = makeRoot();
		const mine = new ViewerStatusFiles(root, 42);
		const other = new ViewerStatusFiles(root, 43);
		mine.write("a", { state: "running" });
		other.write("b", { state: "running" });
		mine.removeAll();
		expect(existsSync(join(root, "42"))).toBe(false);
		expect(existsSync(other.pathFor("b"))).toBe(true);
	});

	it("removeAll with nothing written does not throw", () => {
		expect(() => new ViewerStatusFiles(makeRoot(), 7).removeAll()).not.toThrow();
	});
});
