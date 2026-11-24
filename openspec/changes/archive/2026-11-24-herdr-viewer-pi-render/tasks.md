## 1. Frame protocol, input framing and output sanitizing

Blocked by: none

- [x] 1.1 Add `src/herdr/frame-protocol.ts` (only `node:` built-ins, no Pi packages, erasable syntax): message types, `encodeMessage`, `parseViewerMessage`, `parsePiMessage` with field bounds, `MessageSplitter` with a per-line byte cap, and `chunkInput` splitting input at the data cap (design D1, D7)
- [x] 1.2 Add `sanitizeFrameLine` to `frame-protocol.ts`: keep SGR and OSC 8 only, drop every other escape sequence and C0/C1 control (design D2)
- [x] 1.3 Add `InputFramer` to `frame-protocol.ts`: stateful stdin framing that holds an incomplete SGR mouse report across chunks, emits wheel reports, drops other mouse reports and passes the rest through (design D7)
- [x] 1.4 Enable `allowImportingTsExtensions` in `tsconfig.json`
- [x] 1.5 Tests `test/herdr/frame-protocol.test.ts`: round trip, malformed, out-of-bounds and partial lines, line cap overflow, sanitizer payloads, input framing at every split point

## 2. Viewer program as frame painter

Blocked by: 1

- [x] 2.1 Rewrite `src/herdr/viewer.ts`: args `--socket --key --pid --parent-terminal`; connect, `hello`, `resize` on SIGWINCH; alternate screen, hidden cursor, SGR mouse; paint frames with synchronized output and `sanitizeFrameLine`; received line cap (design D2, D7)
- [x] 2.2 Input: raw mode; stdin through `InputFramer` into `wheel` and `input` messages
- [x] 2.3 Exit path: on socket close/error, line overflow, SIGTERM or dead Pi pid, restore screen, cursor, mouse and raw mode once, `hc keep <own> --off`, exit
- [x] 2.4 Rewrite `test/herdr/viewer.test.ts` (arg parsing, paint output, terminal restore on a fake TTY stdin) and `test/herdr/viewer.integration.test.ts` (real viewer against a loopback Unix socket in a temp dir: hello, sanitized paint, input and wheel forwarding, every exit trigger restores and exits, pid death within 2 s, keep off, starts with no Pi packages resolvable)

## 3. Transcript pane fill layout

Blocked by: none

- [x] 3.1 `TranscriptPaneOptions.layout` (`docked` default | `fill`) and `status?: () => string | undefined` in `src/ui/session-navigator.ts`; `TranscriptPane.resync()` and `TranscriptContent.resync()` in `src/ui/transcript-content.ts` (design D3, D4)
- [x] 3.2 `fill`: exactly `rows` lines (header, `rows - 2` transcript rows, footer; footer only at 1 row); Esc/`q` ignored; footer hint without `Esc close`; footer left label `<status> · <N> lines · <pct>` with `<status>` as narrow fallback
- [x] 3.3 Tests in `test/ui/session-navigator.test.ts` and `test/ui/transcript-content.test.ts`: fill height for 1–4 and 40 rows, close keys ignored, footer shows status, line count, percentage and scroll hints and no close hint, docked unchanged, resync drops a stale in-flight message

## 4. Viewer transcript source

Blocked by: none

- [x] 4.1 Add `src/herdr/viewer-source.ts`: `followedFileSource` (300 ms unref'd poll on size+mtime while subscribed, failed read not recorded, missing file → empty) over `fileSnapshotSource` (design D3)
- [x] 4.2 Add `SwitchableSource` to `viewer-source.ts`: inner `liveSource` or `followedFileSource` by `record.isSessionReady()`, 1000 ms unref'd readiness probe while subscribed, `refresh()`, one `undefined` event on a kind switch; snapshot targets always file (design D3)
- [x] 4.3 Add `src/herdr/deferred-source.ts`: `DeferredSource` wrapping a `TranscriptSource`, queueing its events (collapsing `message_update`; past 256 events the queue is dropped and `flush()` reports `resync`; the latest in-flight assistant event is kept apart and delivered after a resync) and delivering them only during the frame turn through `flush()` or `redeliverInFlight()` (design D3)
- [x] 4.4 Tests `test/herdr/viewer-source.test.ts` and `test/herdr/deferred-source.test.ts`: file appears later, unparsable line skipped, unreadable then readable with same size/mtime, timer stops on unsubscribe, live chosen when ready, switch live → file on release and file → live on resume, no event delivered before `flush`, collapsing and overflow

## 5. Headless rendering host

Blocked by: 3, 4

- [x] 5.1 Add `src/herdr/headless-tui.ts`: the `TUI` members the pane and Pi's transcript components use, with a resize setter and a render-request callback (design D3)
- [x] 5.2 Add `src/herdr/viewer-renderer.ts`: `ViewerRenderer` owning `TranscriptPane` (`fill`, status) over `DeferredSource(SwitchableSource)`; 50 ms coalesced frames on an unref'd timer, flush + render in one error boundary; input, wheel and resize queued and applied at the frame turn inside the error boundary (`StdinBuffer` only enqueues decoded keys, also from its escape timeout; queued keys into `handleInput`, wheel into `handleMouse`); `resize`, `refresh`, `dispose` (destroys the `StdinBuffer`); `viewerStatusLabel` (design D3, D5)
- [x] 5.3 Tests `test/herdr/viewer-renderer.test.ts`: same header and transcript rows as a docked pane on the same source and scroll position, markdown heading/list/code rendered, streaming tail and activity row within 1 s, live `renderCall` and `renderResult` used, extension renderers not called inside a source callback, file fallback rows match a file-backed pane, follow/scroll-up/back-to-bottom, wheel and keys repaint a static source, remapped page-up binding, close keys and text ignored, status transitions, live → file → live on one renderer keeping scroll position, resize re-flows, render throw keeps the last frame, a component throwing during input or resize does not escape the handler, overflow while a message is still streaming keeps it visible, tiny terminal, dispose with a pending escape

## 6. Frame server

Blocked by: 1, 5

- [x] 6.1 Add `src/herdr/frame-server.ts`: lazy `listen` on a `0700` mkdtemp dir under `<tmpdir>/pi-subagents-herdr/`, socket path length check, `register`, `refresh`, `unregister`, renderer per `hello`, newer connection replaces older, one pending frame per connection on backpressure, incoming bounds, write error closes the connection, `close()` removes renderers, sockets and dir; everything unref'd (design D1, D6, D7)
- [x] 6.2 Tests `test/herdr/frame-server.test.ts` over a real Unix socket in a temp dir: dir mode, no socket before first use, hello → frames, unknown key closed, resize/input/wheel routed, replacement, blocked reader keeps one pending frame and gets the latest on drain, oversized line closes only that connection, send failure closes only that viewer while another keeps updating, render failure in one renderer leaves another updating, close cleans up

## 7. Wiring and removal of status files

Blocked by: 2, 6

- [x] 7.1 `src/herdr/viewer-process.ts`: launch argv `--socket --key --pid --parent-terminal` (design D6)
- [x] 7.2 `src/ui/session-navigation.ts`: export `buildHeading`; `src/herdr/herdr-observer.ts`: `titleOf` → `headingOf`, frame server instead of `ViewerStatusFiles`, `frames.refresh` called directly in run-started/finished hooks, `socketPath` + `register` before start, `unregister` in `forget`, `close` in `dispose` (design D3, D5, D6)
- [x] 7.3 `src/herdr/activate.ts` and `src/index.ts`: theme through `HerdrActivation.start({ cwd, mode, theme })` → `Activate` → `ActivateInput.theme`; build the frame server with `createRenderer`
- [x] 7.4 Delete `src/herdr/status-files.ts` and `test/herdr/status-files.test.ts`
- [x] 7.5 Update `test/herdr/viewer-process.test.ts`, `test/herdr/herdr-observer.test.ts`, `test/herdr/activate.test.ts`, `test/composition-root.test.ts` for the new wiring, keeping every existing `herdr-viewer-column` scenario test passing; add status-refresh-before-queue and heading tests

## 8. Docs and provenance

Blocked by: 7

- [x] 8.1 ADR `docs/decisions/0016-herdr-viewer-renders-in-pi.md` superseding ADR 0015's "plain text, no Pi components" consequence; note in ADR 0015's status
- [x] 8.2 README "Herdr" section and `CHANGELOG.md` entry
- [x] 8.3 `UPSTREAM.md` rows: add new files, update edited rows, remove the status-files rows
- [x] 8.4 Run `bun run check`, `bun run test`, `bun run lint`, `bun run lint:md`, `bun run verify:public-types`, `openspec validate --all`
