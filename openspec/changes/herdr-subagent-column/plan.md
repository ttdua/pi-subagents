# Herdr Subagent Column Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (`herdr-viewer-column`, `fleet-view`) and `design.md`.

**Goal:** Inside the Herdr desktop app, show every subagent's transcript in a read-only viewer terminal, stacked in a column right of the main Pi pane, hidden into Herdr's sidebar when the child finishes.

**Architecture:** A new `src/herdr/` module talks to Herdr only through one injected port (`HerdrCli`, backed by `pi.exec`). `HerdrViewers`, a `SubagentManagerObserver`, is the only owner of a serial job queue; its jobs call `ViewerColumn` (placement with `herdr-app`), `ViewerProcesses` (viewer terminals with `hc`) and `ViewerStatusFiles` directly. The viewer program (`viewer.ts`) is TypeScript run directly by the runtime (Bun or Node type stripping) in its own process; it follows the child's session JSONL. Activation runs once per `session_start`, without blocking it.

**Tech Stack:** TypeScript (Pi extension, Bun, vitest, biome); `node:` built-ins only for the viewer; external CLIs `hc` (herdr-core) and `herdr-app`.

## Global Constraints

- No new dependency; public Pi APIs only (`pi.exec`, `ctx.mode`, observer hooks already in the repo).
- No change to the published service, its types, events or records (`bun run verify:public-types` unchanged).
- Every `hc` / `herdr-app` call has a timeout of 2000 ms (`HERDR_COMMAND_TIMEOUT_MS = 2000`); dispose is capped at 3000 ms (`DISPOSE_CAP_MS`).
- `MAX_COLUMN = 4`; `OUTPUT_FILE_POLL_MS = 250`; `PEEK_ATTEMPTS = 5`; `PEEK_RETRY_MS = 200`.
- Viewer: file poll 300 ms, status poll 500 ms, parent-pid check 1000 ms.
- Tests need no secrets, paid calls or network beyond loopback; no test runs real `hc` or `herdr-app`.
- Every edited upstream file and every new file under `src/` and `test/` gets an `UPSTREAM.md` row (`test/upstream.test.ts` enforces it).
- Coding standards (`~/.agents/skills/coding-standards/SKILL.md`): one responsibility per unit; `index.ts` only wires; no nested queueing.

## Review Focus

- Two children starting in the same tick: placements must not interleave → `herdr-observer.test.ts` "places concurrent viewers one after another".
- User focused another pane during a placement → `column.test.ts` "Focus elsewhere is kept".
- A partially written last JSONL line must not print until complete → `viewer.test.ts` "keeps an incomplete trailing line".
- Shutdown while jobs are queued or while abort-driven finish hooks arrive → `herdr-observer.test.ts` "Late lifecycle hooks after shutdown", "drops queued jobs after dispose".
- Detection output with unexpected JSON shapes → `detect.test.ts` "is inactive on malformed hc output".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `HerdrCli` | new | `interface HerdrCli { run(command: "hc" \| "herdr-app", args: readonly string[]): Promise<{ code: number; stdout: string }> }`; never rejects | no |
| `createExecHerdrCli` | new | `(exec: (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>) => HerdrCli`; a result that is not `{ code: number; stdout: string }`, has `killed: true`, or a throw → `{ code: 1, stdout: "" }`; copies `args` | no |
| `HerdrQueue` | new | `class HerdrQueue { enqueue(label: string, job: () => Promise<void>): Promise<void>; close(): void }`; serial, in order; a throwing job is `debugLog`ged; after `close()` pending and new jobs are skipped (their promise resolves) | no |
| `json.ts` helpers | new | `parseJson(text: string): unknown`; `asRecord(v: unknown): Record<string, unknown> \| undefined`; `asArray(v: unknown): unknown[]`; `asString(v: unknown): string \| undefined` | no |
| `HerdrContext` | new | `interface HerdrContext { terminalId: string; spaceId: string; tabId: string; parentPaneId: string }` | no |
| `detectHerdr` | new | `(input: { mode: string \| undefined; env: Readonly<Record<string, string \| undefined>>; cli: HerdrCli }) => Promise<HerdrContext \| undefined>` | no |
| `ColumnViewer` | new | `interface ColumnViewer { readonly terminal: string; pane?: string }` | no |
| `ViewerColumn` | new | `class ViewerColumn { constructor(ctx: HerdrContext, cli: HerdrCli, sleep?: (ms: number) => Promise<void>); place(v): Promise<void>; hide(v): Promise<void>; focus(v): Promise<boolean>; peek(v): Promise<boolean>; isPlaced(v): boolean; isWaiting(v): boolean }`; no queueing inside; `hide` refills from the waiting FIFO through a private routine (deviation during apply, found by E2E: `keep` retries "no running terminal" `PEEK_ATTEMPTS` x `PEEK_RETRY_MS` and waits for the kept pane, polling every `KEEP_SETTLE_POLL_MS = 100` up to 1000 ms, before restoring focus; unreadable status falls back to the main pane) | no |
| `viewerRuntime` | new | `(proc?: { execPath: string; versions: Record<string, string \| undefined> }) => string[]` | no |
| `ViewerStatus` (status file) | new | JSON `{ "state": "running" } \| { "state": "done", "status"?: "completed" \| "aborted" \| "stopped" \| "error" }` at `<root>/<pid>-XXXXXX/<key>.json` (deviation during apply: `status` optional because snapshot entries carry no run status; per-process dir from `mkdtemp` under a 0700 root) | no |
| `ViewerStatusFiles` | new | `class ViewerStatusFiles { constructor(root: string, pid: number); pathFor(key: string): string; write(key: string, s: ViewerStatus): void; removeAll(): void }`; write = temp file + rename | no |
| `ViewerLaunch` | new | `interface ViewerLaunch { key: string; agentType: string \| undefined; title: string; outputFile: string; cwd: string; statusFile: string }` | no |
| `ViewerProcesses` | new | `class ViewerProcesses { constructor(cli: HerdrCli, opts: { runtime: string[]; viewerPath: string; pid: number; parentTerminal: string }); start(l: ViewerLaunch): Promise<string \| undefined>; isLive(terminal: string): Promise<boolean>; end(terminal: string): Promise<void> }` | no |
| viewer key | new | record id for live records; `f-<first 10 hex of sha1(outputFile)>` otherwise | no |
| `ViewerRegistry` | new | `class ViewerRegistry { add(key: string, e: { terminal: string; outputFile: string; viewer: ColumnViewer }): void; byKey(key); byOutputFile(file); remove(key); all(): Array<{ key; terminal; outputFile; viewer }> }` | no |
| `OutputFilePoller` | new | `class OutputFilePoller { constructor(onReady: (record: Subagent, file: string) => void, timers?: { setInterval; clearInterval }); watch(record: Subagent): void; unwatch(id: string): void; stop(): void }`; timer `unref()`'d and only running while records are watched | no |
| `HerdrViewers` | new | `class HerdrViewers implements SubagentManagerObserver { constructor(deps: { column: ViewerColumn; processes: ViewerProcesses; statusFiles: ViewerStatusFiles; registry: ViewerRegistry; createPoller: (onReady: (record: Subagent, file: string) => void) => OutputFilePoller; queue: HerdrQueue; cwd: string; titleOf: TitleOf; fileExists: (path: string) => boolean }); open(entry: NavigationEntry): Promise<boolean>; dispose(): Promise<void> }` | no |
| `TitleOf` | new | `type TitleOf = (x: { type: string; description: string }) => string`; production: `` `${getDisplayName(type, registry)} · ${description}` `` | no |
| `HerdrViewersSlot` | new | `class HerdrViewersSlot implements SubagentManagerObserver { set(v: HerdrViewers \| undefined): void; get(): HerdrViewers \| undefined }` | no |
| `activateHerdrViewers` | new | `(input: { mode: string \| undefined; env: Readonly<Record<string, string \| undefined>>; cli: HerdrCli; cwd: string; pid: number; titleOf: TitleOf }) => Promise<HerdrViewers \| undefined>` | no |
| viewer CLI | new | `<runtime> src/herdr/viewer.ts --file <path> --status <path> --pid <n> --parent-terminal <id> --title <text>` | no |
| `viewer.ts` exports | new | `parseArgs(argv: string[]) => { file: string; status: string; pid: number; parentTerminal: string \| undefined; title: string }`; `splitLines(buffered: string) => { lines: string[]; rest: string }`; `renderEntry(entry: unknown) => string[]` | no |
| `SessionNavigatorParams.herdr` | modified | adds optional `herdr?: { open(entry: NavigationEntry): Promise<boolean> }` | no |

---

## Task 1: Herdr command port and detection — implements 1

**Covers:** 1.1, 1.2
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/herdr/cli.ts`, `src/herdr/json.ts`, `src/herdr/detect.ts`
- Test: `test/herdr/cli.test.ts`, `test/herdr/detect.test.ts`, `test/herdr/fake-cli.ts` (helper: `FakeHerdrCli` with `reply(prefix: string[], result | ((args) => result))`, unmatched → `{ code: 1, stdout: "" }`, and `calls: Array<{ command; args }>`)

**Interfaces:**
- Produces: `HerdrCli`, `createExecHerdrCli`, `HerdrQueue`, `HERDR_COMMAND_TIMEOUT_MS`, `json.ts` helpers, `HerdrContext`, `detectHerdr`, `FakeHerdrCli`.

- [ ] **Step 1: Failing tests** `test/herdr/cli.test.ts`: exec receives `{ timeout: 2000 }` and a copy of args; exec rejecting, returning `undefined`, or `{ killed: true, code: 0 }` → `{ code: 1, stdout: "" }`; `HerdrQueue` runs jobs in order (job 2 starts after job 1 resolves), continues after a throwing job, and skips pending jobs after `close()`.
- [ ] **Step 2:** `bunx vitest run test/herdr/cli.test.ts` → FAIL.
- [ ] **Step 3:** Implement `cli.ts` and `json.ts`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Failing tests** `test/herdr/detect.test.ts`, named after scenarios: "Inside Herdr" (`mode: "tui"`, `HC_TERMINAL_ID=t3s`, `hc get t3s --json` → labels `sp1`/`tb1`, `herdr-app ls` lists `t3s` with pane `p1` in `sp1`/`tb1` → `{ terminalId: "t3s", spaceId: "sp1", tabId: "tb1", parentPaneId: "p1" }`); "Outside Herdr" (no `HC_TERMINAL_ID` → `undefined`, `calls` empty, also with `HERDR_ENV=1`); "Child session" (`mode: "print"`, the runner default for children, and `mode: undefined` → no calls); "RPC mode" (`mode: "rpc"` → no calls); "Terminal not shown by Herdr"; "Herdr app unreachable"; "Detection times out" (`hc get` → `{ code: 1 }`); "is inactive on malformed hc output" (`[]`, `not json`, labels as string, terminal listed in another tab).
- [ ] **Step 6:** Run → FAIL. **Step 7:** Implement `detectHerdr` with guard clauses in design D2 order. **Step 8:** Run → PASS; `bun run check`; `bunx biome check src/herdr test/herdr`.
- [ ] **Step 9: Commit** `feat(herdr): command port, queue and detection`.

---

## Task 2: Viewer program — implements 2

**Covers:** 2.1, 2.2
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/herdr/viewer.ts`
- Test: `test/herdr/viewer.test.ts`, `test/herdr/viewer.integration.test.ts`

**Interfaces:**
- Produces: the viewer CLI and `viewer.ts` exports (Contracts); the `viewer.ts` path consumed by Task 4/5.

- [ ] **Step 1: Failing tests** `test/herdr/viewer.test.ts` (strip ANSI with `/\x1b\[[0-9;]*m/g`): `parseArgs` of the full CLI → the object in Contracts; missing `--file` throws. `splitLines('{"a":1}\n{"b"')` → `{ lines: ['{"a":1}'], rest: '{"b"' }` ("keeps an incomplete trailing line"). `renderEntry`: user text `hi` → `["> hi"]`; assistant text two lines → both; assistant `toolCall` `{name:"read",arguments:{path:"x"}}` → `['-> read {"path":"x"}']`; args longer than 120 chars truncated; `toolResult` with 12 text lines → 8 lines plus `(+4 lines)`; thinking with 5 lines → 3; `compaction` → one line; `session`, `model_change`, unknown → `[]`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the three exports in `src/herdr/viewer.ts` (imports only `node:*`; no `enum`/`namespace`/parameter properties). **Step 4:** Run → PASS.
- [ ] **Step 5: Failing integration tests** `test/herdr/viewer.integration.test.ts` (temp dir; spawn `process.execPath src/herdr/viewer.ts …` (this also proves the file runs without a TypeScript loader) with piped stdio and `HC_TERMINAL_ID=""`; helper `waitForOutput(text, ms)`):
  - "File appears later": file written 200 ms after start → `> hello` within 1000 ms.
  - "Follows appended entries": appended assistant text → printed within 1000 ms.
  - "Unparsable line": `not json` then a valid entry → valid entry printed, process alive.
  - "Input is discarded": stdin `abc\r` → process alive, no `abc` on stdout (TTY raw mode is checked in E2E 6.4).
  - rewrite: truncate the file and write one new entry → `(transcript rewritten)` and the entry.
  - status file `done/completed` → `done (completed)`; then `running` → `running again`; a half-written status file is ignored.
  - "Pi process gone": `--pid` of a child `process.execPath -e "setTimeout(()=>{},300)"` → viewer exits within 2000 ms after it ends.
- [ ] **Step 6:** Run → FAIL. **Step 7:** Implement the main routine in `viewer.ts` per design D6 (runs only when `fileURLToPath(import.meta.url) === realpathSync(process.argv[1])`; offsets with `openSync`/`readSync`; raw mode only when `stdin.isTTY`; own keep off via `spawnSync("hc", ["keep", own, "--off"])` only when `HC_TERMINAL_ID` is set and differs from `--parent-terminal`). **Step 8:** Run → PASS.
- [ ] **Step 9: Commit** `feat(herdr): read-only transcript viewer program`.

---

## Task 3: Viewer column placement — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/herdr/column.ts`
- Test: `test/herdr/column.test.ts`, `test/herdr/fake-herdr-app.ts` (helper: a `FakeHerdrCli` preset whose `herdr-app ls`, `status`, `do terminal.keep`, `do terminal.park`, `do pane.focus`, `do terminal.peek` replies follow a mutable pane model)

**Interfaces:**
- Consumes: `HerdrCli`, `HerdrContext`, `json.ts`, `FakeHerdrCli` (Task 1).
- Produces: `ViewerColumn`, `ColumnViewer`, `MAX_COLUMN`, `PEEK_ATTEMPTS`, `PEEK_RETRY_MS`, `fake-herdr-app.ts`.

- [ ] **Step 1: Failing tests** `test/herdr/column.test.ts`, named after scenarios: "First viewer opens to the right" (`do pane.focus --pane p1`, `do terminal.keep --terminal t10 --place right`, viewer gets `pane`); "Further viewers stack below" (anchor = first viewer's pane, `--place down`); "Focus returns" (last call focuses `p1`); "Focus elsewhere is kept" (status `p9` → last call focuses `p9`); "Closed pane frees its slot" (pane removed from the model → not counted, not the anchor; parent `right` when none left); "Fifth child waits" (no keep call; `isWaiting`); "Waiting viewer moves in" and "Waiting order" (`hide` placed → `terminal.park`, then FIFO head kept, next still waiting); "Placement fails" (keep code 1 → no pane, not waiting, focus restored, next place works); "Viewer already closed" (park code 1 ignored, slot freed); `hide` of a waiting viewer drops it without park; `focus` placed → `true` with `pane.focus`, unplaced → `false` and no call; `peek` retries on `{"error":…}` up to 5 times with injected `sleep(200)`, `true` on `{"ok":true}`, `false` after 5.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `ViewerColumn` per design D4: private `readFocus()`, `livePanes()`, `placeNow(v)`, `refill()`, `park(v)`; no queue.
- [ ] **Step 4:** Run → PASS; refactor per the coding-standards checklist.
- [ ] **Step 5: Commit** `feat(herdr): viewer column placement`.

---

## Task 4: Viewer lifecycle observer — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2, Task 3

**Files:**
- Create: `src/herdr/runtime.ts`, `src/herdr/status-files.ts`, `src/herdr/viewer-process.ts`, `src/herdr/viewer-registry.ts`, `src/herdr/output-file-poller.ts`, `src/herdr/herdr-observer.ts`
- Test: `test/herdr/runtime.test.ts`, `test/herdr/status-files.test.ts`, `test/herdr/viewer-process.test.ts`, `test/herdr/output-file-poller.test.ts`, `test/herdr/herdr-observer.test.ts`

**Interfaces:**
- Consumes: Task 1 (`HerdrCli`, `HerdrQueue`, `FakeHerdrCli`), Task 2 (`viewer.ts` path), Task 3 (`ViewerColumn`, `fake-herdr-app.ts`); `SubagentManagerObserver` (`src/lifecycle/subagent-manager.ts`), `Subagent` (`src/lifecycle/subagent.ts`), `NavigationEntry` (`src/ui/session-navigation.ts`), `getDisplayName` (`src/ui/display.ts`) for titles.
- Produces: `viewerRuntime`, `ViewerStatusFiles`, `ViewerProcesses`, `ViewerLaunch`, `ViewerRegistry`, `OutputFilePoller`, `HerdrViewers`, `HerdrViewersSlot`, `OUTPUT_FILE_POLL_MS`, `DISPOSE_CAP_MS`.

- [ ] **Step 1: Failing unit tests** for the small units:
  - `runtime.test.ts`: `{ execPath: "/x/node", versions: {} }` → `["/x/node"]`; `{ execPath: "/x/bun", versions: { bun: "1.4" } }` → `["/x/bun"]`; `{ execPath: "/x/pi", versions: { bun: "1.4" } }` → `["node"]`.
  - `status-files.test.ts`: `write` produces the JSON at `pathFor(key)` with no temp file left; `removeAll` deletes `<root>/<pid>`.
  - `viewer-process.test.ts`: `start` argv equals `hc run --bg --json --name explore-a1b2c3 --cwd <cwd> -- <runtime…> <viewerPath> --file <f> --status <s> --pid <pid> --parent-terminal t3s --title <title>` and returns `address`; name sanitizing (`My Agent!` + `ABCDEF123` → `my-agent-abcdef`, ≤ 32 chars); retry without `--name` once; both fail → `undefined`; `isLive` only for `"state":"live"`; `end` calls `keep --off`, `kill`, `rm` in order ignoring failures.
  - `output-file-poller.test.ts`: fake timers; `watch` a record without file → no callback; set `outputFile` → callback once after ≤ 250 ms and the record is no longer watched; `unwatch` stops it; timer cleared when nothing is watched.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `runtime.ts`, `status-files.ts`, `viewer-process.ts`, `viewer-registry.ts`, `output-file-poller.ts`. **Step 4:** Run → PASS.
- [ ] **Step 5: Failing tests** `test/herdr/herdr-observer.test.ts` (real `HerdrQueue`, `ViewerColumn`, `ViewerProcesses` over `fake-herdr-app.ts`; temp status root; fake poller timers; stub records with `id`, `type`, `description`, `status`, `outputFile`), named after scenarios: "Background child gets a viewer", "Foreground child gets a viewer" (start then keep); "No session file"; "Resume reuses the viewer" (`hc get` live → no second `hc run`); "Resumed child returns" (after hide, resume with a free slot → status file `running`, `terminal.keep` again); "Resume after the viewer was closed" (`hc get` not live → new `hc run`); "Completed/Failed/Stopped child hides" and "Aborted counts as finished" (status file `done/<status>` then `terminal.park`); "Waiting child finishes"; "Resumed child waits when the column is full"; a finish with no start clears the pending watch; "Running agent focused"; "Finished agent in a popup"; "Waiting agent in a popup"; "Agent from before a reload" (snapshot entry → key `f-<sha1 prefix>`, title from heading, start with status done, then peek); "Herdr fails" (peek always errors → `false`); "Agent without a file" and a missing file (`fileExists` false) → `false` with no calls; "places concurrent viewers one after another" (three `onSubagentRunStarted` in one tick); "Herdr command hangs" (hooks return before any fake reply resolves); "hc fails mid-session"; "Session shutdown" and "Reload" (`dispose` ends all viewers in parallel, removes the status dir, resolves within `DISPOSE_CAP_MS` even if `hc kill` never resolves); "drops queued jobs after dispose"; "Late lifecycle hooks after shutdown" (`onSubagentRunFinished` after `dispose` → no call); "ends a viewer whose start resolves after dispose" (`hc run` reply held until `dispose()` started → `hc kill` for that address, no `terminal.keep`); "open reuses a viewer for a released record" (snapshot entry with the same `outputFile` as a registered viewer → no `hc run`, peek on it); "poller does not start a second viewer" (`open` started one for a running record, then the file becomes ready → no second `hc run`); `HerdrViewersSlot` forwards only when set.
- [ ] **Step 6:** Run → FAIL.
- [ ] **Step 7:** Implement `HerdrViewers` as a thin coordinator: each hook checks `disposed`, then enqueues one job; jobs call collaborators directly. Implement `HerdrViewersSlot`.
- [ ] **Step 8:** Run → PASS; `bun run check`; `bunx biome check src/herdr test/herdr`.
- [ ] **Step 9: Commit** `feat(herdr): viewer lifecycle observer`.

---

## Task 5: Composition and sessions command — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 4

**Files:**
- Create: `src/herdr/activate.ts`
- Modify: `src/index.ts` (wiring only), `src/ui/session-navigator.ts`
- Test: `test/herdr/activate.test.ts`, `test/ui/session-navigator.test.ts`, `test/composition-root.test.ts`; add `vi.stubEnv("HC_TERMINAL_ID", "")` to other suites that load `src/index.ts` with a TUI-mode `session_start` (find them with `rg -l "from \"#src/index\"" test`)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `activateHerdrViewers`, `SessionNavigatorParams.herdr`.

- [ ] **Step 1: Failing tests:**
  - `activate.test.ts`: no `HC_TERMINAL_ID` → `undefined`; faked Herdr → a `HerdrViewers`; the viewer path it passes exists on disk.
  - `session-navigator.test.ts`: "Command unchanged" (no `herdr` → pane mounts as today); `herdr.open` → `true` → no `ui.custom`; `herdr.open` → `false` → pane mounts.
  - `composition-root.test.ts`: TUI `session_start` with `HC_TERMINAL_ID` stubbed empty → `pi.exec` never called with `hc`/`herdr-app`; with `HC_TERMINAL_ID=t3s` and `pi.exec` faking detection → `hc get` called, `session_start` resolves before `pi.exec` answers; "Shutdown before detection ends" (shutdown fired while detection is pending → when it resolves, no `hc run` ever happens and the instance is disposed); "Enter unchanged inside Herdr" (with Herdr active, a fleet `Enter` mounts `ui.custom` and issues no `herdr-app` command after detection).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `activate.ts`. In `src/index.ts`: create `HerdrViewersSlot` and `observer.add(slot)`; a `session_start` handler that increments `herdrGeneration`, and calls `activateHerdrViewers({ mode: ctx.mode, env: process.env, cli, cwd: ctx.cwd, pid: process.pid, titleOf: ({ type, description }) => `${getDisplayName(type, registry)} · ${description}` })` without awaiting; on resolve, install when the generation still matches, else `dispose()`; a `session_shutdown` handler registered after `lifecycle.handleSessionShutdown` that increments the generation, takes the instance out of the slot and awaits its `dispose()`; pass `herdr: slot.get()` into `sessionNavigator.handle`.
- [ ] **Step 4:** In `SessionNavigatorHandler.handle`, after the pick: `if (await herdr?.open(entry)) return;` before `openTranscript`.
- [ ] **Step 5:** Run → PASS; full `bun run test`.
- [ ] **Step 6: Commit** `feat(herdr): wire viewers into the session and /subagents:sessions`.

---

## Task 6: Docs, provenance and manual E2E — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Normal
**Blocked by:** Task 5

**Files:**
- Create: `docs/decisions/0015-subagent-viewers-in-a-herdr-column.md`
- Modify: `README.md`, `docs/comparison-with-upstream.md`, `CHANGELOG.md`, `UPSTREAM.md`

- [ ] **Step 1:** ADR 0015 (accepted, date of apply): context (in-process children, Herdr facts), decision (design D2–D8 in short), consequences (read-only plain-text viewer; `/subagents:sessions` inside Herdr is an exception to ADR 0013's "no other viewer", the fleet list is not).
- [ ] **Step 2:** README "Herdr" section (what users see, detection rule, fleet list unchanged, reopening finished children, compiled-binary installs need `node` on `PATH`); one line in `docs/comparison-with-upstream.md`; `CHANGELOG.md` "Unreleased → Added".
- [ ] **Step 3:** `UPSTREAM.md`: extend rows of edited upstream files; `add` rows for each new `src/herdr/*` and `test/herdr/*` file.
- [ ] **Step 4:** Run `bun run check`, `bun run test`, `bun run lint`, `bun run lint:md`, `bun run verify:public-types`, `openspec validate --all` → all pass (summaries only).
- [ ] **Step 5: Manual E2E in Herdr** from the worktree (`pi -e <worktree>/src/index.ts`, installed copy not loaded): 5 background `explore` children and 1 foreground child. Record in `apply.md`: column right of Pi with 4 panes and focus staying in Pi (`herdr-app status`); typing into a viewer does nothing; the 5th under Pi in the sidebar, moving in after one finishes; finished panes leaving the column; `/subagents:sessions` focusing a running one and popping up a finished one; `/reload` ends viewers; quit leaves no viewer (`hc ls --all`); `kill -9` of Pi → viewers exit within 2 s and no pane turns into a shell.
- [ ] **Step 6: Commit** `docs(herdr): ADR, README, changelog and provenance`.

---

## Scenario → test

- Enter opens the live pane → existing `test/ui/fleet-list.test.ts` (unchanged)
- Released session opens from file → existing `test/ui/fleet-list.test.ts` (unchanged)
- Unreadable file → existing `test/ui/fleet-list.test.ts`, `test/ui/session-navigator.test.ts` (unchanged)
- Command unchanged → `test/ui/session-navigator.test.ts`
- Enter unchanged inside Herdr → `test/composition-root.test.ts`
- Inside Herdr → `test/herdr/detect.test.ts`
- Outside Herdr → `test/herdr/detect.test.ts`, `test/composition-root.test.ts`
- Terminal not shown by Herdr → `test/herdr/detect.test.ts`
- Herdr app unreachable → `test/herdr/detect.test.ts`
- Child session → `test/herdr/detect.test.ts`
- RPC mode → `test/herdr/detect.test.ts`
- Shutdown before detection ends → `test/composition-root.test.ts`
- Detection times out → `test/herdr/detect.test.ts`, `test/herdr/cli.test.ts`
- Aborted counts as finished → `test/herdr/herdr-observer.test.ts`
- Background child gets a viewer → `test/herdr/herdr-observer.test.ts`
- Foreground child gets a viewer → `test/herdr/herdr-observer.test.ts`
- No session file → `test/herdr/herdr-observer.test.ts`
- Resume reuses the viewer → `test/herdr/herdr-observer.test.ts`
- Resume after the viewer was closed → `test/herdr/herdr-observer.test.ts`
- Follows appended entries → `test/herdr/viewer.integration.test.ts`
- Input is discarded → `test/herdr/viewer.integration.test.ts`, E2E 6.4
- File appears later → `test/herdr/viewer.integration.test.ts`
- Unparsable line → `test/herdr/viewer.integration.test.ts`
- First viewer opens to the right → `test/herdr/column.test.ts`
- Further viewers stack below → `test/herdr/column.test.ts`
- Closed pane frees its slot → `test/herdr/column.test.ts`
- Focus returns → `test/herdr/column.test.ts`
- Focus elsewhere is kept → `test/herdr/column.test.ts`
- Concurrent launches → `test/herdr/herdr-observer.test.ts` "places concurrent viewers one after another"
- Fifth child waits → `test/herdr/column.test.ts`
- Waiting viewer moves in → `test/herdr/column.test.ts`
- Waiting order → `test/herdr/column.test.ts`
- Completed child hides → `test/herdr/herdr-observer.test.ts`
- Failed child hides → `test/herdr/herdr-observer.test.ts`
- Stopped child hides → `test/herdr/herdr-observer.test.ts`
- Waiting child finishes → `test/herdr/herdr-observer.test.ts`, `test/herdr/column.test.ts`
- Viewer already closed → `test/herdr/column.test.ts`
- Resumed child returns → `test/herdr/herdr-observer.test.ts` "Resumed child returns"
- Resumed child waits when the column is full → `test/herdr/herdr-observer.test.ts`
- Running agent focused → `test/herdr/herdr-observer.test.ts`
- Finished agent in a popup → `test/herdr/herdr-observer.test.ts`
- Waiting agent in a popup → `test/herdr/herdr-observer.test.ts`
- Agent from before a reload → `test/herdr/herdr-observer.test.ts`
- Herdr fails → `test/herdr/herdr-observer.test.ts`, `test/ui/session-navigator.test.ts`
- Agent without a file → `test/herdr/herdr-observer.test.ts`
- Session shutdown → `test/herdr/herdr-observer.test.ts`, `test/herdr/viewer-process.test.ts`
- Reload → `test/herdr/herdr-observer.test.ts`, E2E 6.4
- Late lifecycle hooks after shutdown → `test/herdr/herdr-observer.test.ts`
- Pi process gone → `test/herdr/viewer.integration.test.ts`, E2E 6.4
- Placement fails → `test/herdr/column.test.ts`
- Herdr command hangs → `test/herdr/herdr-observer.test.ts`, `test/herdr/cli.test.ts`
- hc fails mid-session → `test/herdr/herdr-observer.test.ts`
