# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `herdr-viewer-pi-render`
**Iteration**: `1`
**Applied at**: `2026-11-24 10:00`
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-subagents.herdr-viewer-pi-render`
- **Worktree branch**: `herdr-viewer-pi-render`
- **Feature branch**: `spec/herdr-viewer-pi-render`
- **Base branch**: `main`

---

## Commits

- **Range**: `bfb4dbe..885d855` (`bfb4dbe` is the step 0 scaffold commit on the feature branch; implementation starts after it). The receipt commit follows.
- **Count**: `30`

---

## Tasks

- **Completed**: `30 of 30` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

All internal; no `public` contract changed (`bun run verify:public-types` passes).

- `createSender` / `Sender` (new, Task 2 fix round 1): keeps `hello` first on the viewer channel, queues earlier input, drops queued resize. Reason: the task review found input/resize could reach the socket before `hello`.
- `InputFramer` (modified, final fix wave): adds `flush()` and `holding`; wheel only for SGR reports ending in `M`. Reason: a held lone ESC merged with the next key into Alt+key; release reports scrolled.
- `SwitchableSource` (modified, final fix wave): replays the live session's in-flight assistant message on attach and on a file→live switch; `refresh()` emits nothing while it has no listeners. Reason: a viewer opened mid-stream missed the partial message.
- `DeferredSource` (modified, final fix wave): adds `pending` so the renderer reschedules after an aborted frame turn. Reason: a frame turn that threw before applying source events left the batch stuck.
- `ViewerProcesses.start(l, shouldContinue?)` (modified, final fix wave): skips the unnamed `hc run` retry when `shouldContinue()` is false. Reason: dispose did not stop the retry.
- `NavigableSubagent.inFlightMessage?()` (new optional member, final fix wave), backed by `Subagent.inFlightMessage()` and `SubagentSession.inFlightMessage` (reads `AgentSession.state.streamingMessage`). Reason: the in-flight replay above.

---

## Lanes

Tasks ran one after another in one worktree (all ready tasks shared `UPSTREAM.md`).

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `bfb4dbe..b0c52e3` | approved after 2 fix rounds | n/a |
| 3 | sequential | `c8d8dea..6e2be53` | approved after 1 fix round | n/a |
| 4 | sequential | `17c0d32..b54a7b3` | approved after 1 fix round (first reviewer run timed out, re-dispatched) | n/a |
| 2 | sequential | `b678823..4242652` | approved after 1 fix round (two reviewer runs lost to connection errors; reviewed in split passes) | n/a |
| 5 | sequential | `8d8f565..93d5ccc` | approved after 1 fix round | n/a |
| 6 | sequential | `7456c4a..cfd8e2c` | approved after 2 fix rounds | n/a |
| 7 | sequential | `cf41e3e..58b91d1` | approved after 2 fix rounds | n/a |
| 8 | sequential | `20383ea..a38cb39` | approved after 1 fix round | n/a |
| Final whole-branch review | sequential | `bfb4dbe..3694be8`, fixes `3694be8..885d855` | three slice reviews "with fixes" (5 Important, 3 Minor); one fix wave; re-review approved | n/a |

Evidence at `885d855`: `bun run check`, `bun run test` (3227 passed), `bun run lint`, `bun run verify:public-types`, `openspec validate --all` (15/15) all pass. Smoke: a real `src/herdr/viewer.ts` spawned with `viewerRuntime()` and the `ViewerProcesses` argv painted a transcript line served by `FrameServer` + `ViewerRenderer` (no Herdr in the loop; a run inside Herdr was not performed).

Deferred: `MessageSplitter` byte cap ignores up to 3 UTF-8 bytes held in `StringDecoder` (bounded; reviewed as non-blocking).

---

## Next step

Run `/opsx-verify`.
