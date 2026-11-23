## Context

Children run in-process (`createAgentSession` in `src/index.ts`), and each child's transcript is persisted by Pi's `SessionManager.create(cwd, sessionDir)` as JSONL. `Subagent.outputFile` exposes that path from the moment the factory returns, and keeps it after `releaseSession()`. Pi writes the file lazily: nothing until the first user or assistant message, then one appended line per entry (`session-manager.js` `_persist`); it can also rewrite the whole file. `/subagents:sessions` (`src/ui/session-navigator.ts`) already reads such files for released agents (`fileSnapshotSource`).

Lifecycle reaches consumers through `SubagentManagerObserver`, fanned out by `CompositeSubagentObserver`; the widget and the fleet list are observers added in `src/index.ts`. `onSubagentRunStarted` fires for every run (initial and resume, foreground and background) before the session exists; `onSubagentRunFinished` fires on every terminal transition, including a stop of a queued resume that never started. At `session_shutdown` (quit, `/reload`, new, resume, fork) the lifecycle handler aborts every child, so late `onSubagentRunFinished` hooks arrive during shutdown.

The extension also loads inside child sessions (no UI: `hasUI` is false), and `hasUI` is true in RPC mode too; `ctx.mode` is `tui` only in the interactive TUI.

Herdr facts, verified by a spike in the user's Herdr (herdr-app, herdr-core `hc`):
- The current terminal is `$HC_TERMINAL_ID`; `hc get <t> --json` returns its `labels`, including `herdr.space` and `herdr.tab` when Herdr shows it.
- `hc run --bg --json` started from Pi's terminal creates a sub-agent terminal (`parent` = Pi's terminal) with no pane; Herdr lists it under the parent in its agent sidebar. Inside it, `HC_TERMINAL_ID` is the sub-agent's own address.
- `herdr-app do terminal.keep --terminal <t> --place right|down` gives it a pane beside the focused pane and enables core keep (reply carries `pane`); `terminal.park` removes the pane, disables keep, and the terminal returns under its parent in the sidebar.
- `herdr-app do pane.focus --pane <p>` moves focus; `terminal.keep` moves focus to the new pane.
- `herdr-app do terminal.peek --terminal <t>` shows a live terminal as a popup over the tab (`{"ok":true}`); right after `hc run` it can fail with `{"error":"no running terminal …"}` until the app learns of the terminal.
- `herdr-app ls` returns spaces > tabs > terminals with `terminal` and `pane` ids, but no geometry. `herdr-app status` returns `focused_pane`.
- Labelled terminals (`herdr.space`/`herdr.tab`) each open as a new column, so they cannot form a vertical stack; `pane.split` terminals have no parent, so parking them makes them invisible. Hence `hc run` + `terminal.keep`.

## Goals / Non-Goals

**Goals:**
- One read-only viewer per child, visible in a right-hand column while it runs, with focus kept where the user had it.
- No effect on child execution, launch latency, session start or results, inside or outside Herdr.
- Unit-testable without Herdr: every external call goes through one injected port.

**Non-Goals:**
- Token-level streaming, input to the child, the older `herdr` multiplexer, remote machines, a user setting.

## Decisions

### D1. A new `src/herdr/` module behind one port, one queue owner
`HerdrCli` is the only seam to the outside: `run(command, args) → Promise<{ code, stdout }>`, never rejecting, backed in production by `pi.exec` with a 2 s timeout (`killed`, a non-object result or a throw all become `{ code: 1, stdout: "" }`). Units, one responsibility each:
- `json.ts`: defensive JSON narrowing helpers shared by the units below.
- `detect.ts`: `detectHerdr` → `HerdrContext | undefined`.
- `column.ts`: `ViewerColumn`, placement state (placed list, waiting FIFO) and the `herdr-app` commands for keep, park, focus and peek. Its methods are plain async methods; it does not queue.
- `viewer-process.ts`: `ViewerProcesses`, start, liveness and end of viewer terminals through `hc`.
- `status-files.ts`: `ViewerStatusFiles`, atomic writes of per-viewer status files and removal of their directory.
- `viewer-registry.ts`: `ViewerRegistry`, the map from viewer key to `{ terminal, outputFile, column entry }`, looked up by record id or by `outputFile`.
- `output-file-poller.ts`: `OutputFilePoller`, the 250 ms timer (unref'd, running only while something is pending) that reports when a record first has an `outputFile`.
- `herdr-observer.ts`: `HerdrViewers`, the thin `SubagentManagerObserver` and `open(entry)`; it owns the single `HerdrQueue` and is the only caller of `enqueue`. `HerdrViewersSlot` forwards hooks to the current session's instance.
- `runtime.ts`: `viewerRuntime()`, the program that runs `viewer.ts`.
- `activate.ts`: detection plus construction, so `src/index.ts` only wires.
- `viewer.ts`: the viewer program (pure rendering exports plus its main routine), TypeScript like the rest of the package.
Only `HerdrViewers` enqueues; a queued job calls `ViewerColumn`/`ViewerProcesses` directly and awaits them, so no job ever waits on another queued job (no nested enqueue, no deadlock).
Alternative considered: queueing inside `ViewerColumn` too. Rejected: an observer job awaiting a column job behind it in the same serial queue deadlocks.

### D2. Detection and activation
Active only when all hold: `ctx.mode === "tui"` (excludes child sessions, print, JSON and RPC modes); `HC_TERMINAL_ID` is set; `hc get $HC_TERMINAL_ID --json` exits 0 with both `herdr.space` and `herdr.tab` labels; `herdr-app ls` exits 0 and lists that terminal with a pane in that tab (this gives the parent pane id). Any failure means inactive. `HERDR_ENV`/`HERDR_PANE_ID` are ignored. Detection runs once per `session_start` and is not awaited by the handler: the handler bumps a session generation counter and starts activation; when activation resolves for a stale generation (a shutdown happened meanwhile), the result is disposed instead of installed. Children launched before activation resolves get no viewer from the column (they stay reachable through `/subagents:sessions`).
Alternative: env-only detection (`__CFBundleIdentifier=dev.herdr.app`). Rejected: inherited env is not proof that this terminal is shown in Herdr.

### D3. A viewer is an `hc` sub-agent placed with `terminal.keep`
Start: `hc run --bg --json --name <name> --cwd <cwd> -- <runtime…> <viewer.ts> --file <outputFile> --status <statusFile> --pid <process.pid> --parent-terminal <HC_TERMINAL_ID of Pi> --title <title>`. The viewer key is the record id for live records, and `f-<first 10 hex of sha1(outputFile)>` for snapshot entries (no record id). `<name>` is `<agent type or "agent">-<first 6 of key>` lowered and reduced to `[a-z0-9_-]`, at most 32 chars; on a non-zero exit the start is retried once without `--name`. The title is `<display name> · <description>`, built from the record or from `entry.heading`.
`viewerRuntime()`: `[process.execPath]` when it is a runtime that runs TypeScript directly (Bun, or Node 22.18 or later, which strips types by default); otherwise `["node"]` from `PATH` (compiled single-binary Pi installs, older Node). A start that fails is "no viewer".
The viewer starts when the record first has an `outputFile` (D1 poller); a record still without one when its run finishes gets no viewer (in-memory sessions). The poller-ready job does nothing when the registry already holds a viewer for that record id or `outputFile` (for example one `open` started).

### D4. Placement algorithm with focus restore
Inside one queued job, to place viewer `v`:
1. `herdr-app status` → remember `focused_pane`.
2. `herdr-app ls` → the panes still present in the tab; drop placed entries whose pane is gone (the user closed it).
3. If 4 viewers are placed (`MAX_COLUMN = 4`), append `v` to the waiting FIFO and stop.
4. Anchor: the last placed pane with `--place down`, or the parent pane with `--place right` when none.
5. `pane.focus --pane <anchor>`, `terminal.keep --terminal t --place <dir>` (reply carries the new pane id), then `pane.focus --pane <remembered>`.
If `terminal.keep` fails, the viewer stays a sidebar sub-agent, neither placed nor waiting. `hide(v)` parks a placed viewer (ignoring failure) or drops a waiting one, then, when a slot freed, places the head of the waiting FIFO with the same internal routine, still inside the same job.
Alternative: always restore focus to the parent pane. Rejected: the user may have been typing elsewhere.

### D5. Finish, resume and the status file
On `onSubagentRunFinished`, the job writes `{"state":"done","status":"<record status>"}` to the viewer's status file, then calls `hide`. A resume (`onSubagentRunStarted` for a record with a known viewer) first checks `hc get <t> --json` for `"state":"live"`; if live it writes `{"state":"running"}` and places the viewer again; otherwise it forgets the viewer and treats the run as new. A finish with no known viewer (including a queued resume stopped before it started) only clears any pending poll. Status files live in `<os.tmpdir()>/pi-subagents-herdr/<process.pid>/<key>.json`, written to a temp file then renamed.
Alternative: closing the pane. Rejected by the user (hide, not close).

### D6. The viewer program
`src/herdr/viewer.ts` is a TypeScript file like the rest of the package, type-checked by `tsc` and linted by biome. It runs in its own process, outside Pi's extension loader, so it is executed directly by the runtime's own TypeScript support (Bun, or Node's type stripping). Two constraints follow: it imports only `node:` built-ins (no `#src/*` alias, no relative `.ts` import, which would need `allowImportingTsExtensions`), and it uses only erasable syntax (no `enum`, `namespace` or parameter properties). Node does not strip types under `node_modules`; this package is installed from git (`~/.pi/agent/git/...`), so that does not apply, and if it ever does the start fails into "no viewer". It exports the pure helpers (`parseArgs`, `splitLines`, `renderEntry`) for tests, and runs its main routine only when it is the entry module, comparing `fileURLToPath(import.meta.url)` with `realpathSync(process.argv[1])` (so symlinked paths still match). The viewer prints a title line, waits for the file to appear, then follows it: reads appended bytes every 300 ms, keeps an incomplete trailing line for the next read, and prints each parsed entry as plain text. If the file shrinks below the read offset (Pi rewrote it), it resets to offset 0 and prints a `(transcript rewritten)` line before reprinting. Rendering per entry: user message as `> <text>`; assistant text blocks as is; thinking blocks dimmed and truncated to 3 lines; tool calls as `-> <name> <first 120 chars of JSON args>`; tool results as their first 8 lines dimmed with `(+N lines)`; compaction as one dim line; other entry types print nothing; unparsable lines are skipped. Scrollback is Herdr's own. When stdin is a TTY it sets raw mode and discards all input. It polls the status file every 500 ms (ignoring unreadable or half-written JSON) and prints one `done (<status>)` / `running again` line on each change. Every 1 s it checks `process.kill(pid, 0)` for Pi; when that fails it runs `hc keep <own HC_TERMINAL_ID> --off` (only when that id is set and differs from `--parent-terminal`) and exits.
Alternative: reuse Pi's TUI components in the viewer. Rejected: needs Pi's runtime and module loader in a separate process; plain text is enough for observation.

### D7. `/subagents:sessions` inside Herdr
`SessionNavigatorHandler` gains an optional `herdr?: { open(entry: NavigationEntry): Promise<boolean> }`. `open` returns `false` without any Herdr call when the entry has no `outputFile` or the file does not exist. Otherwise, in one queued job, the viewer is looked up by record id, then by `outputFile` (a released record appears as a snapshot entry): a live entry whose viewer is placed → `pane.focus` on its pane; any other → start a viewer if none is live (status `done` unless the record is running), then `terminal.peek`, retried up to 5 times 200 ms apart until it exits 0 with no `error` field. `open` returns `false` on any failure, and the handler then falls back to `openTranscript`. The fleet list keeps calling `openTranscript` directly, so its `Enter` is unchanged.

### D8. Cleanup and failure isolation
`HerdrViewers.dispose()`: marks itself disposed (every later hook and `open` is a no-op), closes the queue (pending jobs are skipped), stops the poller, then ends every known viewer, viewers in parallel (`Promise.allSettled` of `processes.end(t)` per viewer, which runs keep off → kill → rm in sequence), capped at 3 s in total, and removes the status directory. A job already running when dispose starts may still finish a `processes.start` or `terminal.keep`; after each of those calls the job checks `disposed`, and if set it ends the terminal it just created instead of registering or placing it. In `src/index.ts` the dispose runs in a `session_shutdown` handler registered after the lifecycle handler, so the abort-driven finish hooks have already arrived and are ignored. Observer hooks never throw and never await Herdr: they enqueue and return. Every failed command is `debugLog`ged and otherwise ignored.

## Risks / Trade-offs

- [Focus flicker: keys typed during the ~100 ms between `terminal.keep` and the focus restore land in the viewer] → the viewer discards input, so nothing reaches a child or a shell; the restore runs immediately after.
- [`terminal.keep` enables core keep, so a viewer exiting on its own would be replaced by a shell] → the viewer turns its own keep off before exiting; cleanup turns it off before kill.
- [The user rearranges or closes viewer panes] → placement re-reads `herdr-app ls` every time and drops vanished panes; a closed viewer is replaced on the agent's next resume or pick in `/subagents:sessions`.
- [`herdr-app` command names or reply shapes change across Herdr versions] → detection and every command fail closed into "no viewer"; children are unaffected.
- [Viewer polling cost] → one small Node process per child with 300 ms file reads; ended at shutdown.
- [Children launched in the first moments of a session, before activation resolves, get no column viewer] → accepted; detection is two short CLI calls, and `/subagents:sessions` reaches them.
- [Popup right after `hc run` races the app] → bounded retry in D7, then fallback to the in-TUI pane.
- [Compiled single-binary Pi without `node` on `PATH`, Node older than 22.18, or an install under `node_modules`] → viewer start fails, which is "no viewer"; noted in README.
- [A future edit adds non-erasable syntax or an aliased import to `viewer.ts`] → the integration test runs the real file with `process.execPath`, so it fails in CI.
- [Developer test runs inside Herdr would see `HC_TERMINAL_ID`] → composition tests stub it empty.
