# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `herdr-subagent-column`
**Iteration**: `1`
**Applied at**: `2026-11-23 20:30`
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`; final whole-branch review by `superspec.task-reviewer` with the requesting-code-review template)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-subagents.herdr-subagent-column`
- **Worktree branch**: `herdr-subagent-column`
- **Feature branch**: `spec/herdr-subagent-column` (created from `main` with Worktrunk; the change directory was moved off `main` and committed there as `6adb974`)
- **Base branch**: `main`

---

## Commits

- **Range**: `6adb974..b63f139` (the receipt commit follows `b63f139`)
- **Count**: `18`

---

## Tasks

- **Completed**: `17 of 17` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- `ViewerStatus` (internal): the `done` variant's `status` is optional. Snapshot entries reopened from `/subagents:sessions` carry no run status, so the viewer prints a bare `done` instead of a possibly wrong `done (completed)`.
- `ViewerColumn` (internal): `keep` retries while Herdr answers "no running terminal" (`PEEK_ATTEMPTS` x `PEEK_RETRY_MS`) and waits for the kept pane to be listed (`KEEP_SETTLE_POLL_MS = 100`, at most 1000 ms) before restoring focus; when `herdr-app status` is unreadable, focus is restored to the main pane. Found by the manual E2E: `terminal.keep` races `hc run` and applies asynchronously.
- `ViewerStatusFiles` (internal): the per-process directory is `mkdtemp(<root>/<pid>-)` under a 0700 root instead of `<root>/<pid>`.
- `viewer.ts` (internal): exports `ViewerArgs`, `sanitize`, `enableRawMode` in addition to the contract exports; all rendered text and the title are stripped of control characters.
- `detect.ts` (internal): exports `TerminalLocation` and `readTabTerminals`, reused by `column.ts`.
- `HerdrViewersDeps` (internal): optional `sleep` for the dispose cap; `OutputFilePoller` timers typed as `PollerTimers`.
- `activate.ts` (internal): also exports `HerdrActivation` (session generation guard) and `viewerProgramPath()`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 1 | sequential | `6adb974..d1211de` | Approved | n/a |
| Task 2 | sequential | `ecbb3de..9be969f` | Approved | n/a |
| Task 3 | sequential | `0b4b41d..cae9947`, post-E2E fixes `7bc4c35..263b1bc` | Approved; fixes ADDRESSED | n/a |
| Task 4 | sequential | `4da7559..c3ebde5` | Approved after 1 fix round | n/a |
| Task 5 | sequential | `17aee35..bfc910a` | Approved after 1 fix round | n/a |
| Task 6 | sequential | `da9f35d..7bc4c35` | Approved after 1 fix round | n/a |
| Final review fix wave | sequential | `9bad556..b63f139` | ADDRESSED | n/a |

Tasks 1 and 2 had no blockers but both append rows to `UPSTREAM.md`, so they ran one after another.

---

## Checks (fresh, at `b63f139`)

- `bun run check`: clean
- `bun run test`: 135 files, 3110 tests passed
- `bun run lint`: clean
- `bun run verify:public-types`: OK
- `openspec validate --all`: 14 passed, 0 failed (length warnings only)
- `bun run lint:md`: fails only on the untracked local file `docs/superpowers/plans/2026-11-19-prune-upstream-artefacts.md` (copied into the worktree as an ignored file; not part of the branch)

## Manual E2E in Herdr (task 6.4)

Pi loaded from the worktree (`pi -ne -e <worktree>/src/index.ts -e <provider extension>`) in a fresh Herdr tab:

- 5 background + 1 foreground child: one viewer each, named `<type>-<id6>`, parented to Pi's terminal; transcripts render; finished viewers print `done (completed)` and leave the column.
- 5 long-running children: 4 viewers stacked in one column right of Pi, the 5th waited in Herdr's sidebar and moved in when a slot freed; focus stayed on Pi throughout.
- Typing into a viewer has no effect; the viewer keeps running.
- `/subagents:sessions` on a finished agent opens its viewer as a Herdr popup.
- `/reload` ends and removes every viewer; children after the reload get new viewers.
- Quit: viewers ended and removed, status directory removed. `kill -9` of Pi: viewers exit within the budget, keep is off, no pane turns into a shell (the status directory stays behind, since no cleanup can run).
- Two bugs found and fixed during E2E (see Contract deviations, `ViewerColumn`).

---

## Next step

Run `/opsx-verify`.
