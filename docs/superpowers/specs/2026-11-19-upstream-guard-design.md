# Upstream guard and sync script (issue #3)

## Intent

`UPSTREAM.md` lists every local change to upstream files, but nothing enforces it since the split from `pi-jev-pilot` dropped `tests/vendoring.test.ts` and `.upstream-manifest`. Upstream history now lives in this repository, so the guard reads git directly. Syncing a newer upstream release becomes one script.

## Goals

- Editing, adding or deleting a path under `src/`, `test/`, `agents/`, `scripts/`, `dist/`, or `package.json`/`tsconfig.json`, without a row in `UPSTREAM.md`, fails `bun run test` (uncommitted edits included).
- Any other non-`docs/` path changed from upstream is named in the single fork-files paragraph of `UPSTREAM.md`.
- Ported checks: `LICENSE` equals upstream's; `NOTICE.md` credits gotgenes (`gotgenes/pi-packages`, MIT) and tintinweb (0.23.2 fleet list, 0.26.1 package agents); `scripts/verify-public-types.sh` reads the package name from `package.json`.
- `scripts/sync-upstream.sh <version>` splits and merges an upstream tag; against `25.0.5` it is a no-op merge.

## Non-goals

- `docs/` is not guarded (the fork rewrote it).
- No manifest file; the split commit is the source of truth.

## Constraints

- Split commit is read from `UPSTREAM.md` (`- Upstream split commit: \`<sha>\``), never a constant.
- Shallow clone (commit missing) → tests skip with a clear message; CI checks out with `fetch-depth: 0`.
- Tooling: vitest, `bun`; script is bash.

## Approaches

1. **Git diff against the split commit (picked).** `git diff --no-renames --name-status <split>` against the working tree plus `git ls-files --others --exclude-standard` for untracked files. No extra state to maintain.
2. Manifest of blob ids (jev-pilot style). Rejected: duplicate state, must be regenerated at every sync.
3. Rows for every fork-only root file. Rejected (user agreed): these are not upstream edits; one paragraph naming them is enough and the test checks it.

## Decided

- Test file `test/upstream.test.ts`; root-level fork files are checked against the paragraph that starts with "Outside the table below"; `NOTICE.md`, `UPSTREAM.md`, `CHANGELOG.md` and the `docs/` exclusion are added to it.
- Sync script clones into a temp directory, fetches the split into this repo and merges; on conflict it prints the conflicted files and exits non-zero; it always ends with a reminder to update tag, commit and split commit in `UPSTREAM.md`.
- README "Syncing upstream" points to the script.

## Left to the builder

Helper names and error text inside the test and script.
