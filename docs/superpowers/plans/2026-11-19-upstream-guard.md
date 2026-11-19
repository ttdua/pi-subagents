# Upstream guard and sync script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail `bun run test` when an upstream file changes without an `UPSTREAM.md` row, and script upstream syncs.

**Architecture:** A vitest file shells out to `git` (diff against the split commit read from `UPSTREAM.md`) and parses the `UPSTREAM.md` table and fork-files paragraph. A bash script performs `git subtree split` in a temp clone and merges the result.

**Tech Stack:** vitest, `node:child_process` (`execFileSync`), bash, git.

**Spec:** `docs/superpowers/specs/2026-11-19-upstream-guard-design.md`

## Global Constraints

- Guarded prefixes: `src/`, `test/`, `agents/`, `scripts/`, `dist/`; guarded root files: `package.json`, `tsconfig.json`.
- `docs/` is never guarded.
- Split commit comes from the line `- Upstream split commit: \`<40-hex>\`` in `UPSTREAM.md`.
- Missing split commit (shallow clone) → `describe.skipIf` with message `upstream split commit <sha> not in this clone; fetch full history (fetch-depth: 0)`.
- Repository content in English.

## Review Focus

- Uncommitted edit to `src/x.ts` with no row → must fail (diff against working tree, not `HEAD`). Covered by `changedPaths` using `git diff <split>` without `HEAD`.
- New untracked file under `src/` → must fail. Covered by adding `git ls-files --others --exclude-standard`.
- A rename shows as one `R` line → must list both paths. Covered by `--no-renames`.
- A row that mentions a path only in its reason column must not count. `listedPaths` reads only the first backticked cell.
- Running tests from a subdirectory: use `cwd` = repo root from `import.meta.dirname`.

---

### Task 1: Guard test, UPSTREAM.md paragraph, CI history

**Files:**
- Create: `test/upstream.test.ts`
- Modify: `UPSTREAM.md` (fork-files paragraph; add rows for the new files)
- Modify: `.github/workflows/ci.yml` (`actions/checkout` with `fetch-depth: 0`)

**Interfaces:**
- Produces (module-local): `splitCommit(doc: string): string`, `changedPaths(split: string): string[]`, `listedPaths(doc: string): Set<string>`, `forkFilesParagraph(doc: string): string`.

- [ ] **Step 1: Write tests**
  - `UPSTREAM.md records the split commit`: `splitCommit` matches `/^[0-9a-f]{40}$/`.
  - `every changed upstream path has a row`: guarded paths from `changedPaths` minus `listedPaths` equal `[]` (message lists them).
  - `fork-only root files are named in the fork-files paragraph`: every changed path that is not guarded, not under `docs/`, appears in backticks in the paragraph → `[]`.
  - `LICENSE is upstream's`: `git show <split>:LICENSE` equals the file.
  - `NOTICE.md credits upstream`: contains `gotgenes/pi-packages`, `MIT`, and a tintinweb line with `0.23.2` + `fleet-list` and one with `0.26.1` + `package-agents`.
  - `verify-public-types probes the package.json name`: script contains `require(process.argv[1]).name` and `"$PKG_DIR/package.json"`.
- [ ] **Step 2:** `bun run test test/upstream.test.ts` → fails on the fork-files test (missing `NOTICE.md`, `UPSTREAM.md`, `CHANGELOG.md`) and on the new test file itself lacking a row.
- [ ] **Step 3:** Update the `UPSTREAM.md` paragraph to name `NOTICE.md`, `UPSTREAM.md`, `CHANGELOG.md` and say `docs/` is rewritten and unguarded; add a row `| \`test/upstream.test.ts\` | add | ... |`. Set `fetch-depth: 0` in CI.
- [ ] **Step 4:** Mutation check: append a comment to an unlisted upstream file (e.g. `src/debug.ts`) without committing → test fails naming it; revert.
- [ ] **Step 5:** `bun run lint && bun run check && bun run test` pass. Commit `test: guard UPSTREAM.md against unlisted upstream edits (#3)`.

### Task 2: Sync script and README

**Files:**
- Create: `scripts/sync-upstream.sh` (executable)
- Modify: `README.md` "Syncing upstream" section, `UPSTREAM.md` (row for the script; "To sync" sentence points to the script)

- [ ] **Step 1:** Script: `set -euo pipefail`; usage error without `<version>`; refuse on a dirty tree; `mktemp -d` + `trap` cleanup; `git clone --quiet https://github.com/gotgenes/pi-packages.git`; `git -C $tmp subtree split --prefix packages/pi-subagents pi-subagents-v$version`; `git fetch $tmp <split>`; `git merge --no-edit FETCH_HEAD`; on merge failure print `git diff --name-only --diff-filter=U` and exit 1; finally print split sha, upstream commit (`git -C $tmp rev-parse pi-subagents-v$version^{commit}`) and a reminder to update Tag, Commit and Upstream split commit in `UPSTREAM.md`.
- [ ] **Step 2:** Run `scripts/sync-upstream.sh 25.0.5` on the branch → split sha equals `e6b408e…`, merge reports "Already up to date.", tree unchanged.
- [ ] **Step 3:** README section replaced by `scripts/sync-upstream.sh <version>` usage plus what to do afterward; add the `UPSTREAM.md` row.
- [ ] **Step 4:** `bun run lint && bun run test` pass; `shellcheck` if installed. Commit `chore: script upstream sync (#3)`.
