## 1. Herdr command port and detection

Blocked by: none

- [x] 1.1 Add `src/herdr/cli.ts` (the `HerdrCli` port, its `pi.exec`-backed implementation with a 2 s timeout, and `HerdrQueue`) and `src/herdr/json.ts` (defensive JSON narrowing helpers) per design D1
- [x] 1.2 Add `src/herdr/detect.ts`: `detectHerdr({ mode, env, cli })` returning `HerdrContext` or `undefined` per design D2; tests with a scripted fake `HerdrCli` for every "Herdr detection" and "Inactive column changes nothing" scenario

## 2. Viewer program

Blocked by: none

- [ ] 2.1 Add `src/herdr/viewer.ts` with the pure exports `parseArgs`, `splitLines`, `renderEntry` (TypeScript, `node:` imports only, erasable syntax only), per design D6; unit tests
- [ ] 2.2 Add the main routine of `src/herdr/viewer.ts` (runs only as the entry module): title, wait for the file, follow appended bytes, rewrite reset, raw-mode input discard on a TTY, status-file polling, parent-pid watch with own keep off; integration tests spawning it against a temp file

## 3. Viewer column placement

Blocked by: 1

- [ ] 3.1 Add `src/herdr/column.ts`: `ViewerColumn` (plain async methods, no queue) with placement, waiting FIFO, hide with refill, focus and peek per design D4 and D7
- [ ] 3.2 Tests covering the "Column placement", "Placement keeps focus and order" and "Column overflow" scenarios, pane loss, keep failure, park failure and peek retries

## 4. Viewer lifecycle observer

Blocked by: 1, 2, 3

- [ ] 4.1 Add `src/herdr/runtime.ts` (`viewerRuntime`), `src/herdr/status-files.ts` (`ViewerStatusFiles`) and `src/herdr/viewer-process.ts` (`ViewerProcesses`: start with name retry, liveness, end) per design D3, D5, D8
- [ ] 4.2 Add `src/herdr/viewer-registry.ts` (`ViewerRegistry`) and `src/herdr/output-file-poller.ts` (`OutputFilePoller`)
- [ ] 4.3 Add `src/herdr/herdr-observer.ts`: `HerdrViewers` (the only queue owner: lifecycle hooks, `open(entry)`, `dispose()`) and `HerdrViewersSlot`, per design D1, D5, D7, D8
- [ ] 4.4 Tests covering "Running and finished", "Viewer per child", "Finished child leaves the column", "Resumed child returns to the column", "Sessions command inside Herdr", "Sessions command falls back", "Viewer cleanup" and "Failure isolation"

## 5. Composition and sessions command

Blocked by: 4

- [ ] 5.1 Add `src/herdr/activate.ts` (detection plus construction) and wire it in `src/index.ts`: one `HerdrViewersSlot` in the composite observer; non-blocking activation at `session_start` guarded by a session generation; dispose in a `session_shutdown` handler registered after the lifecycle handler
- [ ] 5.2 Extend `SessionNavigatorHandler` (`src/ui/session-navigator.ts`) with the optional `herdr` opener and the fallback to `openTranscript`; pass it from the `/subagents:sessions` registration
- [ ] 5.3 Tests: `activate`, the navigator's Herdr branch and fallback, and composition-root (no Herdr exec outside Herdr; activation, stale-generation dispose and shutdown inside a faked Herdr; fleet `Enter` unchanged with Herdr active); stub `HC_TERMINAL_ID` empty in suites that do not test Herdr

## 6. Docs, provenance and manual E2E

Blocked by: 5

- [ ] 6.1 Add ADR `docs/decisions/0015-subagent-viewers-in-a-herdr-column.md`; add a "Herdr" section to `README.md`; add a line to `docs/comparison-with-upstream.md`; add an "Unreleased" entry to `CHANGELOG.md`
- [ ] 6.2 Update `UPSTREAM.md`: extend the rows for every edited upstream file (`src/index.ts`, `src/ui/session-navigator.ts`, `test/ui/session-navigator.test.ts`, `test/composition-root.test.ts`, and any other test touched); add `add` rows for every new file under `src/herdr/` and `test/herdr/`
- [ ] 6.3 Run `bun run check`, `bun run test`, `bun run lint`, `bun run lint:md`, `bun run verify:public-types` and `openspec validate --all`
- [ ] 6.4 Manual E2E inside Herdr with the worktree loaded: 5 background children and 1 foreground child; column, focus, overflow, hide on finish, typing into a viewer, `/subagents:sessions` focus and popup, `/reload`, quit, and `kill -9` of Pi; record results in `apply.md`
