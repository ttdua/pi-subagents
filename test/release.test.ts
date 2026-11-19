import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const UPSTREAM_HISTORY = "## Upstream `@gotgenes/pi-subagents` history";

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json")) as {
	version: string;
	packageManager?: string;
	engines?: Record<string, string>;
};

/** Versions of this fork's `## [x.y.z]` entries, above the upstream history heading. */
function forkVersions(changelog: string): string[] {
	const [fork] = changelog.split(UPSTREAM_HISTORY);
	return [...(fork ?? "").matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1] as string);
}

describe("release check", () => {
	const changelog = read("CHANGELOG.md");

	it("keeps upstream entries under one heading below the fork's entries", () => {
		const at = changelog.indexOf(UPSTREAM_HISTORY);
		expect(at).toBeGreaterThan(0);
		expect(changelog.indexOf(UPSTREAM_HISTORY, at + 1)).toBe(-1);
		expect(changelog.slice(0, at)).not.toMatch(/^## \[upstream /m);
	});

	it("package.json version is the newest fork changelog entry", () => {
		expect(forkVersions(changelog)[0]).toBe(pkg.version);
	});

	it("the newest fork changelog entry links its release tag", () => {
		const v = pkg.version;
		expect(changelog).toContain(`## [${v}](https://github.com/ttdua/pi-subagents/releases/tag/v${v})`);
	});

	it("every README git install command pins the current version tag", () => {
		const pins = [...read("README.md").matchAll(/git:github\.com\/ttdua\/pi-subagents(@\S*)?/g)].map((m) => m[1]);
		expect(pins.length).toBeGreaterThan(0);
		for (const pin of pins) expect(pin).toBe(`@v${pkg.version}`);
	});

	it("pins bun once in packageManager, matching engines.bun", () => {
		const bun = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "")?.[1];
		expect(bun).toBeDefined();
		expect(pkg.engines?.bun).toBe(`>=${bun}`);
	});

	it("workflows read the bun version from package.json", () => {
		const dir = ".github/workflows";
		for (const file of readdirSync(join(ROOT, dir))) {
			const workflow = read(`${dir}/${file}`);
			expect(workflow, file).not.toMatch(/bun-version:/);
			if (workflow.includes("oven-sh/setup-bun")) expect(workflow, file).toMatch(/bun-version-file: package\.json/);
		}
	});
});
