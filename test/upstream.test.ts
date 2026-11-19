import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const GUARDED_PREFIXES = ["src/", "test/", "agents/", "scripts/", "dist/"];
const GUARDED_ROOT_FILES = new Set(["package.json", "tsconfig.json"]);
const FORK_FILES_MARKER = "Outside the table below";

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

function splitCommit(doc: string): string {
	const sha = /^- Upstream split commit: `([0-9a-f]{40})`/m.exec(doc)?.[1];
	if (sha === undefined) throw new Error("UPSTREAM.md has no `- Upstream split commit:` line");
	return sha;
}

function commitExists(sha: string): boolean {
	return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT }).status === 0;
}

/** Paths changed since the split: committed, staged, unstaged and untracked. */
function changedPaths(split: string): string[] {
	const tracked = git("diff", "--no-renames", "--name-only", split).split("\n");
	const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
	return [...new Set([...tracked, ...untracked].filter((p) => p !== ""))].sort();
}

/** Paths named in the first backticked cell of the Local changes table rows. */
function listedPaths(doc: string): Set<string> {
	const section = doc.split(/^## Local changes\s*$/m)[1] ?? "";
	const rows = section.split("\n").filter((line) => line.startsWith("|"));
	return new Set(rows.map((row) => /^\|\s*`([^`]+)`/.exec(row)?.[1]).filter((p) => p !== undefined));
}

function forkFilesParagraph(doc: string): string {
	return doc.split("\n").find((line) => line.startsWith(FORK_FILES_MARKER)) ?? "";
}

const isGuarded = (path: string): boolean =>
	GUARDED_ROOT_FILES.has(path) || GUARDED_PREFIXES.some((prefix) => path.startsWith(prefix));

const doc = read("UPSTREAM.md");
const split = splitCommit(doc);
const shallow = !commitExists(split);
const againstSplit = shallow
	? `skipped: upstream split commit ${split} not in this clone; fetch full history (fetch-depth: 0)`
	: "against the upstream split commit";

describe("UPSTREAM.md", () => {
	it("records the upstream split commit", () => {
		expect(split).toMatch(/^[0-9a-f]{40}$/);
	});

	describe.skipIf(shallow)(againstSplit, () => {
		it("has a row for every changed upstream path", () => {
			const listed = listedPaths(doc);
			const unlisted = changedPaths(split).filter((p) => isGuarded(p) && !listed.has(p));
			expect(unlisted, `changed without an UPSTREAM.md row: ${unlisted.join(", ")}`).toEqual([]);
		});

		it("names every changed fork-only file in the fork-files paragraph", () => {
			const paragraph = forkFilesParagraph(doc);
			const unnamed = changedPaths(split).filter(
				(p) => !isGuarded(p) && !p.startsWith("docs/") && !paragraph.includes(`\`${p}\``),
			);
			expect(unnamed, `fork-only files missing from "${FORK_FILES_MARKER}": ${unnamed.join(", ")}`).toEqual([]);
		});

		it("keeps upstream's LICENSE", () => {
			expect(read("LICENSE")).toBe(git("show", `${split}:LICENSE`));
		});
	});
});

describe("NOTICE.md", () => {
	const notice = read("NOTICE.md");
	const line = (needle: string): string => notice.split("\n").find((l) => l.includes(needle)) ?? "";

	it("credits gotgenes/pi-packages under MIT", () => {
		expect(line("gotgenes/pi-packages")).toContain("MIT");
	});

	it("credits tintinweb for the fleet list and package agents", () => {
		expect(line("0.23.2")).toContain("src/ui/fleet-list.ts");
		expect(line("0.26.1")).toContain("src/config/package-agents.ts");
		for (const entry of [line("0.23.2"), line("0.26.1")]) {
			expect(entry).toContain("tintinweb/pi-subagents");
			expect(entry).toContain("MIT");
		}
	});
});

it("verify:public-types probes the package name from package.json", () => {
	const script = read("scripts/verify-public-types.sh");
	expect(script).toContain("require(process.argv[1]).name");
	expect(script).toContain('"$PKG_DIR/package.json"');
});
