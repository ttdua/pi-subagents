# Herdr Viewer Pi Render Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (`herdr-viewer-column`) and `design.md`.

**Goal:** A Herdr viewer shows a subagent's transcript exactly like the `/subagents:sessions` pane, rendered by the main Pi process and painted by a dependency-free viewer over a private Unix socket.

**Architecture:** The main process hosts one `ViewerRenderer` per connected viewer: a `TranscriptPane` in a new `fill` layout over a `HeadlessTui`, fed through a `DeferredSource` (events applied only at frame turns) wrapping a `SwitchableSource` (live session or followed session file). `FrameServer` (Unix socket in a `0700` temp dir) routes bounded NDJSON messages between renderers and viewers. `viewer.ts` becomes a frame painter that sanitizes rows, frames stdin into keys and wheel, and exits when its channel or Pi dies. `HerdrViewers` keeps the queue and column, swapping status files for the frame server.

**Tech Stack:** TypeScript (Pi extension, Bun, vitest, biome); `node:net` Unix sockets; `@earendil-works/pi-tui` (`StdinBuffer`, `getKeybindings`) and `@earendil-works/pi-coding-agent` (`getMarkdownTheme`, `initTheme` in tests) in the main process only; `node:` built-ins only in `viewer.ts` and `frame-protocol.ts`.

## Global Constraints

- No new dependency; public Pi APIs only; published service and types unchanged (`bun run verify:public-types`).
- `viewer.ts` and `frame-protocol.ts`: only `node:` built-ins, no Pi packages, erasable syntax; `viewer.ts` imports `./frame-protocol.ts`.
- Constants: `FRAME_INTERVAL_MS = 50`; `FILE_POLL_MS = 300`; `READINESS_PROBE_MS = 1000`; `PARENT_CHECK_MS = 1000`; `WHEEL_LINES = 3`; `MAX_SOCKET_PATH = 103` bytes; `MAX_VIEWER_LINE = 65536` bytes; `MAX_INPUT_DATA = 4096` UTF-16 code units; `MAX_FRAME_LINE = 4194304` bytes (viewer side); geometry 1–1000; `MAX_QUEUED_EVENTS = 256`; `MAX_MOUSE_PENDING = 32` bytes; socket dir mode `0o700` under `join(tmpdir(), "pi-subagents-herdr")`.
- Every timer and socket created by this change in the main process is `unref`'d. Exception: pi-tui `StdinBuffer`'s own bounded escape timeout, destroyed in `ViewerRenderer.dispose()`.
- Nothing renders, and no extension tool renderer runs, inside a lifecycle hook or a source callback.
- Existing `herdr-viewer-column` scenario tests keep passing (`test/herdr/{herdr-observer,column,detect,activate}.test.ts`, `test/composition-root.test.ts`).
- Tests need no secrets, paid calls or network beyond loopback; Unix sockets live in per-test temp dirs; no test runs real `hc` or `herdr-app`.
- Every new or edited file under `src/` and `test/`, and `tsconfig.json`, gets an `UPSTREAM.md` row (`test/upstream.test.ts` enforces it).
- Coding standards (`~/.agents/skills/coding-standards/SKILL.md`): one responsibility per unit; `index.ts` only wires.

## Review Focus

- A frame row with SGR, OSC 8 and an injected `ESC ] 0 ; title BEL` or `ESC [ 2 J` → only the hostile parts are dropped → `frame-protocol.test.ts` "keeps SGR and OSC 8, drops other sequences".
- A wheel report split at any byte across stdin chunks → still one wheel message → `frame-protocol.test.ts` "frames a wheel report split at every point".
- An extension tool renderer that is slow or touches a `TUI` member `HeadlessTui` lacks → never runs in the child's event path; a throw keeps the last frame → `viewer-renderer.test.ts` "does not run tool renderers inside a source callback", "keeps the last frame when render throws".
- A viewer that stops reading its socket → main-process memory stays bounded → `frame-server.test.ts` "keeps one pending frame for a blocked reader".
- Session released after the run while a viewer is open → viewer switches to the file without a new connection → `viewer-renderer.test.ts` "switches live to file and back on one renderer".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `ViewerMessage` | new | `{ type: "hello"; key: string; cols: number; rows: number } \| { type: "resize"; cols: number; rows: number } \| { type: "input"; data: string } \| { type: "wheel"; delta: number }` | no |
| `PiMessage` | new | `{ type: "frame"; lines: string[] }` | no |
| Wire format | new | one `JSON.stringify(message)` per line, `\n`-terminated, UTF-8. Server: any line that `parseViewerMessage` rejects or that passes `MAX_VIEWER_LINE` closes that connection. Viewer: lines `parsePiMessage` rejects are ignored; a line past `MAX_FRAME_LINE` makes it exit | no |
| `encodeMessage` | new | `(m: ViewerMessage \| PiMessage) => string` (with trailing `\n`) | no |
| `parseViewerMessage` | new | `(line: string) => ViewerMessage \| undefined`; `cols`/`rows` integers 1–1000, `delta` finite, `data` ≤ `MAX_INPUT_DATA`, `key` non-empty | no |
| `parsePiMessage` | new | `(line: string) => PiMessage \| undefined`; `lines` all strings | no |
| `chunkInput` | new | `(data: string, max?: number) => string[]` — pieces of at most `max` (default `MAX_INPUT_DATA`) code units, never splitting a surrogate pair | no |
| `MessageSplitter` | new | `class MessageSplitter { constructor(maxLineBytes: number); push(chunk: Buffer \| string): { lines: string[]; overflow: boolean } }` — UTF-8 safe across chunks | no |
| `sanitizeFrameLine` | new | `(line: string) => string`; keeps `ESC [ [0-9;:]* m` and `ESC ] 8 ; <params> ; <uri> (BEL \| ESC \)`; drops every other ESC sequence (CSI, OSC, DCS, SOS/PM/APC, two-byte), all C0 (tab → one space) and C1 | no |
| `InputFramer` | new | `class InputFramer { push(chunk: string): Array<{ type: "input"; data: string } \| { type: "wheel"; delta: number }> }`; SGR wheel `ESC[<64;x;yM` → `delta: -WHEEL_LINES`, `65` → `+WHEEL_LINES`; other SGR mouse reports dropped; incomplete report (≤ `MAX_MOUSE_PENDING`) held; longer → passed through as input | no |
| Viewer CLI | modified | `viewer.ts --socket <path> --key <key> --pid <n> [--parent-terminal <id>]`; `--file`, `--status`, `--title` removed | no |
| `ViewerArgs` | modified | `{ socket: string; key: string; pid: number; parentTerminal: string \| undefined }` | no |
| `paintFrame` | new | `(lines: string[], rows: number) => string` in `viewer.ts`; `"\x1b[?2026h\x1b[H" + lines.slice(0, rows).map(l => l + "\x1b[K").join("\r\n") + "\x1b[J\x1b[?2026l"` | no |
| `RESTORE` | new | `const RESTORE = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l"` written once on exit, then `setRawMode(false)` | no |
| `TranscriptPaneOptions` | modified | adds `layout?: "docked" \| "fill"` (default `"docked"`) and `status?: () => string \| undefined` | no |
| `TranscriptPane.resync` / `TranscriptContent.resync` | new | `resync(): void` — reset settled blocks, pending tools and the in-flight message, then consume the source's current history | no |
| `buildHeading` | modified | now exported from `src/ui/session-navigation.ts`, signature unchanged | no |
| `PollTimers` | new | `{ setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }` (default unref'd) | no |
| `followedFileSource` | new | `(outputFile: string, deps?: { readFile?: (p: string) => string; stat?: (p: string) => { size: number; mtimeMs: number } \| undefined; timers?: PollTimers }) => TranscriptSource` | no |
| `ViewerTarget` | new | `{ kind: "record"; record: NavigableSubagent; heading: EntryHeading } \| { kind: "file"; outputFile: string; heading: EntryHeading }` | no |
| `SwitchableSource` | new | `class SwitchableSource implements TranscriptSource { constructor(target: ViewerTarget, deps?: { timers?: PollTimers; fileSource?: (f: string) => TranscriptSource }); kind(): "live" \| "file"; refresh(): void }`; a record with neither ready session nor `outputFile` → empty static file-kind source | no |
| `DeferredSource` | new | `class DeferredSource implements TranscriptSource { constructor(inner: TranscriptSource, onQueued: () => void); flush(): { resync: boolean }; redeliverInFlight(): void; dispose(): void }`; `subscribe` registers the pane's listener without forwarding inner events until `flush()`; past `MAX_QUEUED_EVENTS` the queue is dropped and the next `flush()` returns `{ resync: true }` without delivering it; the latest assistant `message_start`/`message_update` is kept apart (cleared on `message_end`/`agent_end`/inner switch) and `redeliverInFlight()` delivers it after the caller's resync; events reach the listener only through these two methods | no |
| `viewerStatusLabel` | new | `(status: SubagentStatus \| undefined, resumed: boolean) => string` → `"running"`, `"running again"`, `` `done (${status})` ``, or `"done"` when `status` is `undefined` | no |
| `FrameTimers` | new | `{ setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }` (default unref'd) | no |
| `HeadlessTui` | new | `class HeadlessTui { constructor(onRender: () => void); resize(cols: number, rows: number): void; readonly terminal: { readonly columns: number; readonly rows: number }; readonly mode: "regular"; requestRender(): void; invalidate(): void; asTui(): TUI }` | no |
| `ViewerRendererOptions` | new | `{ target: ViewerTarget; send: (lines: string[]) => void; theme: TranscriptTheme; keys: PaneKeys; cwd: string; markdownTheme: MarkdownTheme; timers?: FrameTimers; source?: SwitchableSource }`; the renderer uses `o.source ?? new SwitchableSource(o.target)` | no |
| `ViewerRenderer` | new | `class ViewerRenderer { constructor(o: ViewerRendererOptions); resize(cols: number, rows: number): void; input(data: string): void; wheel(delta: number): void; refresh(): void; dispose(): void }` | no |
| `FrameServerOptions` | new | `{ root: string; pid: number; createRenderer: (target: ViewerTarget, send: (lines: string[]) => void) => ViewerRenderer }` | no |
| `FrameServer` | new | `class FrameServer { constructor(o: FrameServerOptions); socketPath(): Promise<string \| undefined>; register(key: string, target: ViewerTarget): void; refresh(key: string): void; unregister(key: string): void; close(): Promise<void> }` | no |
| `HeadingOf` | new | `(record: Subagent) => EntryHeading` (replaces `TitleOf`) | no |
| `HerdrViewersDeps` | modified | removes `statusFiles` and `titleOf`; adds `frames: Pick<FrameServer, "socketPath" \| "register" \| "refresh" \| "unregister" \| "close">` and `headingOf: HeadingOf` | no |
| `ViewerLaunch` | modified | `{ key: string; agentType: string \| undefined; cwd: string; socket: string }` | no |
| `ActivateInput` | modified | removes `titleOf`; adds `headingOf: HeadingOf` and `theme: TranscriptTheme` | no |
| `HerdrActivation.start` / `Activate` | modified | `start(ctx: { cwd: string; mode?: string; theme: TranscriptTheme }): void`; `type Activate = (cwd: string, mode: string \| undefined, theme: TranscriptTheme) => Promise<HerdrViewers \| undefined>` | no |
| `ViewerStatusFiles`, `ViewerStatus`, `FinishedStatus` | removed | `src/herdr/status-files.ts` deleted | no |

---

## Task 1: Frame protocol, input framing and output sanitizing — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/herdr/frame-protocol.ts`, `test/herdr/frame-protocol.test.ts`
- Modify: `tsconfig.json`, `UPSTREAM.md`

**Interfaces:** Produces `ViewerMessage`, `PiMessage`, `encodeMessage`, `parseViewerMessage`, `parsePiMessage`, `MessageSplitter`, `chunkInput`, `sanitizeFrameLine`, `InputFramer`, constants `WHEEL_LINES`, `MAX_VIEWER_LINE`, `MAX_INPUT_DATA`, `MAX_FRAME_LINE`, `MAX_MOUSE_PENDING`.

- [ ] **Step 1:** Write failing tests:
  - `"round-trips every message type"`.
  - `"rejects malformed and out-of-bounds lines"`: `{type:"hello",key:"k",cols:0,rows:5}`, `cols:1001`, `"{"`, `{type:"frame",lines:[1]}`, `input.data` of 4097 chars → `undefined`.
  - `"splits across chunk boundaries"`: `"é"` split byte-wise and a line split mid-escape → one intact line.
  - `"reports overflow past the line cap"`: `new MessageSplitter(8).push("123456789")` → `overflow: true`.
  - `"keeps SGR and OSC 8, drops other sequences"`: `"\x1b[1mA\x1b[22m\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\\x1b[2J\x1b[H\x1b]0;t\x07\x1bP1$r\x1b\\\x9b31m\x07\x00B"` → `"\x1b[1mA\x1b[22m\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\B"`.
  - `"turns tab into a space"`.
  - `"frames a wheel report split at every point"`: for every split index of `"a\x1b[<64;3;4Mb"` → `[input "a", wheel -3, input "b"]` (adjacent inputs may merge).
  - `"drops non-wheel mouse reports"`: `"\x1b[<0;3;4M\x1b[<0;3;4m"` → `[]`.
  - `"passes a long unterminated report through as input"`.
  - `"chunks input at the cap without splitting a surrogate pair"`: `chunkInput("a".repeat(4095) + "😀b")` → `["a".repeat(4095), "😀b"]`; every piece ≤ 4096.
- [ ] **Step 2:** Run `bun run test test/herdr/frame-protocol.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement per Contracts; `MessageSplitter` uses `node:string_decoder`; sanitizer and framer are left-to-right scanners. Set `"allowImportingTsExtensions": true` in `tsconfig.json`.
- [ ] **Step 4:** Run the test file and `bun run check` → PASS.
- [ ] **Step 5:** Add `UPSTREAM.md` rows; commit `feat(herdr): add viewer frame protocol, input framer and sanitizer`.

## Task 2: Viewer program as frame painter — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Modify: `src/herdr/viewer.ts`, `test/herdr/viewer.test.ts`, `test/herdr/viewer.integration.test.ts`, `UPSTREAM.md`

**Interfaces:** Consumes Task 1 exports via `./frame-protocol.ts`. Produces Viewer CLI, `ViewerArgs`, `paintFrame`, `RESTORE` (Contracts), and exported `parseArgs(argv: string[]): ViewerArgs`, `createExit(deps: { write: (s: string) => void; stdin: { isTTY?: boolean; setRawMode?: (m: boolean) => unknown }; keepOff: () => void; exit: (code: number) => void }): () => void` (idempotent).

- [ ] **Step 1:** Rewrite unit tests: `parseArgs` requires `--socket`, `--key`, positive `--pid`; `paintFrame(["\x1b[2Jx"], 2)` starts `"\x1b[?2026h\x1b[H"`, contains `"x\x1b[K"` (caller sanitizes; test passes a sanitized row), ends `"\x1b[J\x1b[?2026l"`, at most `rows` rows; `"exit restores the terminal once"`: `createExit` with a fake TTY stdin called twice → `RESTORE` written once, `setRawMode` called with `false`, `keepOff` and `exit(0)` once.
- [ ] **Step 2:** Rewrite integration tests with a loopback `net.Server` on a socket in the test temp dir: `"sends hello with key and size"`; `"paints received frames sanitized"` (frame with `"\x1b]0;evil\x07ok"` → stdout contains `ok`, not `]0;evil`); `"forwards typed keys as input"`; `"forwards wheel as wheel"`; `"restores the terminal and exits when the channel closes"` (stdout ends with `RESTORE`, exit 0 within 2000 ms); same for `"…when the channel errors"`, `"…on an oversized frame line"` and `"…on SIGTERM"`; keep the `"Pi process gone"` test (exit within 2000 ms after the pid dies); `"keeps own terminal keep off on exit"` (fake `hc` on `PATH` records `keep <id> --off`); `"starts without Pi packages"` (copy `viewer.ts` and `frame-protocol.ts` into an empty temp dir, spawn there with `NODE_PATH` unset → sends `hello`, and a frame sent back with `"isolated-ok"` appears on stdout); `"splits a large paste into capped input messages"` (write 10000 chars to stdin → every `input` message ≤ 4096 code units, concatenation equals the paste, connection stays open).
- [ ] **Step 3:** Run `bun run test test/herdr/viewer` → FAIL.
- [ ] **Step 4:** Implement `viewer.ts`: write `"\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h"`, raw stdin via existing `enableRawMode`, `SIGWINCH` → `resize`; stdin through `InputFramer`, `input` pieces through `chunkInput`, → `encodeMessage`; socket data through `MessageSplitter(MAX_FRAME_LINE)` → `parsePiMessage` → `paintFrame(lines.map(sanitizeFrameLine), stdout.rows)`; one `createExit` wired to socket `close`/`error`, overflow, `SIGTERM` and the pid watch. Keep `isEntryModule`, `keepOwnTerminalOff`.
- [ ] **Step 5:** Run the viewer tests and `bun run check` → PASS.
- [ ] **Step 6:** Update `UPSTREAM.md` rows; commit `feat(herdr): viewer paints frames from the Pi process`.

## Task 3: Transcript pane fill layout — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/ui/session-navigator.ts`, `src/ui/transcript-content.ts`, `test/ui/session-navigator.test.ts`, `test/ui/transcript-content.test.ts`, `UPSTREAM.md`

**Interfaces:** Produces `TranscriptPaneOptions.layout`, `.status`, `TranscriptPane.resync`, `TranscriptContent.resync` (Contracts).

- [ ] **Step 1:** Failing tests: `"fill layout fills the terminal"` (40 rows, 100-line transcript → `render` returns 40 lines); `"fill layout fits short terminals"` (width 80, rows 1, 2, 3, 4 → exactly that many lines; the last line is the footer rule with the status); `"resync drops a stale in-flight message"` (`transcript-content.test.ts`: in-flight partial P, then the source's history gains settled P without `message_end`, `resync()` → P rendered once, no in-flight rows); `"fill layout ignores close keys"` (`escape`, `q` → `done` not called); `"fill footer shows status, position and hints"` (status `"running"`, width 120 → footer contains `running`, `100 lines`, `%`, `↑↓ scroll`, and not `Esc close`); `"fill footer falls back to the status when narrow"` (width 20 → contains `running`); existing docked tests unchanged.
- [ ] **Step 2:** Run `bun run test test/ui/session-navigator.test.ts test/ui/transcript-content.test.ts` → FAIL.
- [ ] **Step 3:** Implement: in `fill`, `render` returns exactly `rows` lines (`rows - CHROME_LINES` transcript rows, footer only when `rows === 1`); `resync()` on both classes; `handleInput` skips the close branch in `fill`; `footerHint` omits `Esc close` in `fill`; footer left candidates `[`${status} · ${position}`, status]` when `status()` returns a value, else `[position]`.
- [ ] **Step 4:** Run `bun run test test/ui/session-navigator.test.ts test/ui/transcript-content.test.ts` → PASS.
- [ ] **Step 5:** Update the `src/ui/session-navigator.ts`, `src/ui/transcript-content.ts` and test rows in `UPSTREAM.md`; commit `feat(ui): fill layout, status label and resync for the transcript pane`.

## Task 4: Viewer transcript source — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/herdr/viewer-source.ts`, `src/herdr/deferred-source.ts`, `test/herdr/viewer-source.test.ts`, `test/herdr/deferred-source.test.ts`
- Modify: `UPSTREAM.md`

**Interfaces:** Consumes `fileSnapshotSource`, `liveSource`, `TranscriptSource`, `NavigableSubagent`, `EntryHeading` from `src/ui/session-navigation.ts`. Produces `PollTimers`, `followedFileSource`, `ViewerTarget`, `SwitchableSource`, `DeferredSource`.

- [ ] **Step 1:** Failing tests in `viewer-source.test.ts` with fake `readFile`/`stat`/timers:
  - `"empty until the file appears"`: stat `undefined` → `getMessages()` `[]`; file with one user message, tick → one message, subscriber notified.
  - `"skips unparsable lines"`.
  - `"retries an unreadable file with unchanged size and mtime"`: `readFile` throws once, same stat next tick → messages appear.
  - `"has no tool definitions and no streaming"`.
  - `"stops polling when the last subscriber leaves"`.
  - `"is live for a ready record even without a file"`: ready record, `outputFile` missing → `kind() === "live"` and messages are the record's.
  - `"is file for a released record and for a snapshot target"`.
  - `"switches live to file on release and back on resume"`: ready → `isSessionReady` false → probe tick → `kind() === "file"`, one `undefined` event; ready again + `refresh()` → `"live"`.
- [ ] **Step 2:** Failing tests in `deferred-source.test.ts`: `"delivers nothing before flush"`; `"delivers queued events in order on flush"`; `"collapses consecutive message_update events"`; `"drops an overflowing queue and asks for a resync"` (257 non-update events → `flush()` delivers nothing and returns `{ resync: true }`; next flush `{ resync: false }`); `"keeps the latest in-flight event across an overflow"` (partial P update, then 300 events without `message_end` → after `flush()` `redeliverInFlight()` delivers P's latest update; after `message_end` it delivers nothing); `"calls onQueued once per batch"`; `"unsubscribes from the inner source on dispose"`.
- [ ] **Step 3:** Run `bun run test test/herdr/viewer-source.test.ts test/herdr/deferred-source.test.ts` → FAIL.
- [ ] **Step 4:** Implement per design D3 and Contracts: `followedFileSource` records `{size, mtimeMs}` only after a successful read; `SwitchableSource` subscribes to the inner source while it has listeners, probes readiness every `READINESS_PROBE_MS`, re-subscribes on switch; `DeferredSource` delegates `getMessages`/`streaming`/`getToolDefinition`/`sessionModel` to the inner source.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** `UPSTREAM.md` rows; commit `feat(herdr): switchable and deferred transcript sources for viewers`.

## Task 5: Headless rendering host — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Hard
**Blocked by:** Task 3, Task 4

**Files:**
- Create: `src/herdr/headless-tui.ts`, `src/herdr/viewer-renderer.ts`, `test/herdr/viewer-renderer.test.ts`
- Modify: `UPSTREAM.md`

**Interfaces:** Consumes `TranscriptPane`/`TranscriptPaneOptions`/`resync` (Task 3), `SwitchableSource`, `DeferredSource`, `ViewerTarget` (Task 4), `StdinBuffer` from `@earendil-works/pi-tui`. Produces `HeadlessTui`, `ViewerRenderer`, `ViewerRendererOptions`, `viewerStatusLabel`, `FrameTimers`.

- [ ] **Step 1:** Failing tests with fake timers, `initTheme()`, a fake record (pattern of `test/ui/session-navigator.test.ts`) and a `KeybindingsManager` (`TUI_KEYBINDINGS`):
  - `"matches the pane's header and transcript rows"`: same messages, width 80, a docked pane with an equal viewport → all rows but the footer equal; repeat after scrolling both up 5 rows.
  - `"renders markdown"`: `# Title`, `- item`, a fenced `ts` block → rows contain `Title`, `item`, the code text, and no row contains `"# Title"` or ```` "```" ````.
  - `"shows the streaming tail within one second"`: a `message_update` on a running record → after `advanceTimersByTime(50)` the frame contains the partial text and the activity glyph row.
  - `"uses live call and result renderers"`: tool definition with `renderCall` → `Text("CALL")`, `renderResult` → `Text("RESULT")` → frame contains both.
  - `"does not run tool renderers inside a source callback"`: spies on `renderCall`/`renderResult`, emit tool call and result events → spies not called synchronously; called after the frame timer.
  - `"renders a file-backed tool call like a file-backed pane"`: file target with a tool call → transcript rows equal a docked pane over `fileSnapshotSource` of the same file.
  - `"follows, stops when scrolled up, resumes at bottom"`.
  - `"keys and wheel repaint a static source"`: finished record, `input("\x1b[A")` → new frame within 50 ms with a different first transcript row; `wheel(-3)` likewise.
  - `"remapped page up scrolls"`: manager with `{"tui.altScreen.pageUp": "ctrl+u"}` → `input("\x15")` scrolls one page.
  - `"ignores close keys and text"`: finished record, `input("\x1b")`, `input("q")`, `input("hello\r")` → frames identical.
  - `"status labels"`: running → `running`; finish + `refresh()` → `done (completed)`; restart + `refresh()` → `running again`; file target → `done`.
  - `"switches live to file and back on one renderer"`: scrolled up 5 rows; release + probe → file transcript, no tool definition used, scroll offset kept; resume + `refresh()` → live.
  - `"re-flows on resize"`: `resize(80, 30)` then `resize(40, 20)` → 20 lines, a long line wraps to more rows.
  - `"coalesces frames to one per 50 ms"`.
  - `"refresh does no source work before the frame turn"`: injected `SwitchableSource` spy → `refresh()` returns without calling `source.refresh`; called after `advanceTimersByTime(50)`.
  - `"keeps a still-streaming message after an overflow"`: partial P, then 300 tool events, no further P update → next frame contains P's text and the activity row.
  - `"contains component errors during input and resize"`: a tool whose `renderCall` returns a component whose `render()` throws, transcript cache cold; `input("\x1b[A")` and `resize(60, 20)` do not throw; the frame timer logs and keeps the previous frame.
  - `"recovers rows after a queue overflow"`: partial P streaming, then 300 events ending with P settled and a new user message → next frame rows equal a fresh docked pane on the same source (P once, no stale partial).
  - `"shows live messages without a session file"`: ready record, nonexistent `outputFile` → frame contains the record's message text.
  - `"shows a file that appears later within one second"`: file target, no file; write the file; `advanceTimersByTime(400)` → frame contains its entry.
  - `"keeps the last frame when render throws"`: a good frame first, then a tool component whose `render()` throws (returned by `renderCall`, not thrown by it, since Pi catches `renderCall` errors) and a source update → no new frame sent, error logged.
  - `"renders a tiny terminal"`: `resize(4, 2)` → send called, no throw.
  - `"dispose destroys a pending escape"`: `input("\x1b")` (arms the `StdinBuffer` timeout), then `dispose()` before any frame turn → no timers left (`vi.getTimerCount() === 0`).
  - `"handles a timed-out escape only at a frame turn"`: failing component as in "contains component errors during input and resize"; `input("\x1b")`, advance past the frame and the `StdinBuffer` timeout → no throw escapes the timer callback, `pane.handleInput` was called only inside a frame turn (spy), previous frame kept.
- [ ] **Step 2:** Run `bun run test test/herdr/viewer-renderer.test.ts` → FAIL.
- [ ] **Step 3:** Implement `HeadlessTui` (only the members in Contracts; `asTui()` is the single cast) and `ViewerRenderer`: `DeferredSource(o.source ?? new SwitchableSource(o.target), schedule)` passed as the pane's `source`; pane `layout: "fill"`, `status: () => viewerStatusLabel(...)`, `done: () => {}`; `resize`/`wheel`/`refresh` only record pending work (last size wins, wheel deltas summed, refresh flag) and `input` feeds `data` to the `StdinBuffer` (no pane call); all call `schedule`, which arms one `FRAME_INTERVAL_MS` timer. The frame turn runs, in order and inside one `try`/`catch` (`debugLog`, frame skipped, previous frame kept): pending `source.refresh()` and status recompute; pending size → `tui.resize` + `pane.invalidate()`; queued decoded keys → `pane.handleInput` (the `StdinBuffer` `data` listener, attached once in the constructor, only pushes decoded keys to the queue and calls `schedule`, so its escape-timeout emissions also wait for a frame turn); summed wheel → `pane.handleMouse({ type: "wheel", wheelDelta, button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: cols, height: rows, shift: false, alt: false, ctrl: false })`; `deferred.flush()` (on `resync`: `pane.resync()` then `deferred.redeliverInFlight()`); `pane.render(cols)`; then `send(lines)`. `dispose` → `pane.dispose()`, `deferred.dispose()`, `stdinBuffer.destroy()`, clear timer.
- [ ] **Step 4:** Run → PASS; `bun run check`.
- [ ] **Step 5:** `UPSTREAM.md` rows; commit `feat(herdr): render viewer frames with the transcript pane`.

## Task 6: Frame server — implements 6

**Covers:** 6.1, 6.2
**Difficulty:** Hard
**Blocked by:** Task 1, Task 5

**Files:**
- Create: `src/herdr/frame-server.ts`, `test/herdr/frame-server.test.ts`
- Modify: `UPSTREAM.md`

**Interfaces:** Consumes Task 1 protocol and `ViewerRenderer`/`ViewerTarget`. Produces `FrameServer`, `FrameServerOptions`.

- [ ] **Step 1:** Failing tests over real sockets in a temp `root` with a fake `createRenderer`:
  - `"opens no socket before first use"`.
  - `"creates a 0700 directory"`: `statSync(dir).mode & 0o777` → `0o700`.
  - `"renders for a registered hello"`: client `hello` → `createRenderer(target, send)`, `resize(cols, rows)`; `send(["a"])` → client gets `{type:"frame",lines:["a"]}`.
  - `"closes an unknown key"`.
  - `"routes resize, input and wheel"`.
  - `"a newer connection replaces the older"`.
  - `"keeps one pending frame for a blocked reader"`: paused client, 1000 large frames sent → server buffered bytes stay below 2 frames; resume → last received frame is the latest.
  - `"closes only the connection with an oversized line"`.
  - `"closes only the connection with an invalid message"`: `hello` with `cols: 1001`, then (new connection) `input` with 4097 code units, then `{type:"nope"}` → each connection closed, another registered viewer keeps receiving.
  - `"closes only the failing viewer"`: destroy one client, `send` → that renderer disposed; the other still receives.
  - `"one renderer failing leaves another updating"`: `createRenderer` builds real `ViewerRenderer`s (`initTheme()`); after both clients got a frame, A's record gains a tool whose `renderCall` returns a component whose `render()` throws → A's client receives no new frame, B's client keeps receiving frames.
  - `"refresh reaches the renderer"`; `"unregister disposes the renderer"`.
  - `"reports no socket when the path is too long"`: root of 120 chars → `socketPath()` `undefined`.
  - `"close removes sockets, renderers and the directory"`.
- [ ] **Step 2:** Run `bun run test test/herdr/frame-server.test.ts` → FAIL.
- [ ] **Step 3:** Implement: `mkdirSync(root, { recursive: true, mode: 0o700 })`, `mkdtempSync(join(root, `${pid}-`))`, `chmodSync(dir, 0o700)`; socket `join(dir, "s")`, reject `Buffer.byteLength(path) > MAX_SOCKET_PATH`; server and sockets `unref()`; per connection `MessageSplitter(MAX_VIEWER_LINE)`; a rejected or overflowing line destroys that connection; send: if `writableNeedDrain`, store as pending and write it on `drain`; write error or `error` event → `debugLog`, `destroy`, renderer `dispose`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `UPSTREAM.md` rows; commit `feat(herdr): frame server for viewer channels`.

## Task 7: Wiring and removal of status files — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4, 7.5
**Difficulty:** Normal
**Blocked by:** Task 2, Task 6

**Files:**
- Modify: `src/herdr/viewer-process.ts`, `src/herdr/herdr-observer.ts`, `src/herdr/activate.ts`, `src/ui/session-navigation.ts`, `src/index.ts`, `test/herdr/viewer-process.test.ts`, `test/herdr/herdr-observer.test.ts`, `test/herdr/activate.test.ts`, `test/composition-root.test.ts`, `UPSTREAM.md`
- Delete: `src/herdr/status-files.ts`, `test/herdr/status-files.test.ts`

**Interfaces:** Consumes `FrameServer` (Task 6), Viewer CLI (Task 2), `ViewerRenderer` (Task 5). Produces modified `ViewerLaunch`, `HerdrViewersDeps`, `HeadingOf`, `ActivateInput`, `HerdrActivation.start`/`Activate`, exported `buildHeading` (Contracts).

- [ ] **Step 1:** Update tests first:
  - `viewer-process.test.ts`: argv `[...runtime, viewerPath, "--socket", s, "--key", k, "--pid", p, "--parent-terminal", t]`.
  - `herdr-observer.test.ts`: fake `frames`; `register(key, { kind: "record", record, heading })` before `processes.start`; snapshot `open` registers `{ kind: "file", outputFile, heading: entry.heading }`; `"refreshes the frame before queued placement"` (a placement command held unresolved, then run finished → `frames.refresh(id)` already called); `refresh` on run started; `unregister` in `forget`; `close` after terminals end in `dispose`; `"no viewer without a socket"` (`socketPath()` `undefined` → no `hc run`). Existing scenario test names stay.
  - `activate.test.ts`: passes `theme` and `headingOf`; `"forwards the session theme"` (`HerdrActivation.start({ cwd, mode, theme })` → `Activate` receives `theme`).
  - `composition-root.test.ts`: `"Shutdown before detection ends"` still passes; `"uses the navigator heading for viewers"` (custom display name and fork label reach `headingOf`).
- [ ] **Step 2:** Run `bun run test test/herdr test/composition-root.test.ts` → FAIL.
- [ ] **Step 3:** Implement per design D3, D5, D6: export `buildHeading`; `ViewerProcesses.program` builds the new argv; `HerdrViewers` hooks call `frames.refresh(record.id)` before `schedule`, start job awaits `socketPath()` then `register` then `processes.start`, `forget` unregisters, `dispose` ends terminals then `await frames.close()`; `activateHerdrViewers` builds `FrameServer({ root: join(tmpdir(), "pi-subagents-herdr"), pid, createRenderer })` with `createRenderer` closing over `input.theme`, `getKeybindings()`, `getMarkdownTheme()`, `input.cwd`; `src/index.ts` passes `theme: ctx.ui.theme` and `headingOf: (r) => buildHeading(r, registry)`. Delete the status-file files.
- [ ] **Step 4:** Run `bun run test` and `bun run check` → PASS.
- [ ] **Step 5:** `UPSTREAM.md`: update edited rows, remove status-files rows; commit `feat(herdr): wire viewers to Pi-rendered frames`.

## Task 8: Docs and provenance — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4
**Difficulty:** Easy
**Blocked by:** Task 7

**Files:**
- Create: `docs/decisions/0016-herdr-viewer-renders-in-pi.md`
- Modify: `docs/decisions/0015-subagent-viewers-in-a-herdr-column.md`, `README.md`, `CHANGELOG.md`, `UPSTREAM.md`

- [ ] **Step 1:** Write ADR 0016 (context: plain-text viewer; decision: design D1–D7 summary; consequences: Pi components in viewers, scroll keys and wheel, status in footer, deferred events, `HeadlessTui` limit for exotic tool renderers, socket path limit). Add "Rendering superseded by ADR 0016" to ADR 0015's Status.
- [ ] **Step 2:** README "Herdr": viewer renders like `/subagents:sessions`, scroll keys and wheel, read-only toward the child; drop "as plain text". `CHANGELOG.md` entry under the unreleased fork version.
- [ ] **Step 3:** Run `bun run check && bun run test && bun run lint && bun run lint:md && bun run verify:public-types && openspec validate --all` → all pass.
- [ ] **Step 4:** Commit `docs: ADR 0016 and README for Pi-rendered Herdr viewers`.

---

## Scenario → test

Unchanged requirements keep their existing tests: Herdr detection, Inactive column changes nothing (`detect.test.ts`); Running and finished, Viewer per child, Sessions command inside Herdr, Sessions command falls back, Viewer cleanup "Session shutdown"/"Reload"/"Late lifecycle hooks after shutdown" (`herdr-observer.test.ts`); "Shutdown before detection ends" (`composition-root.test.ts`); "Pi process gone" (`viewer.integration.test.ts`); Column placement, Placement keeps focus and order, Column overflow (`column.test.ts`, `herdr-observer.test.ts`). Task 7 keeps them passing.

- Markdown is rendered → `viewer-renderer.test.ts` "renders markdown"
- Same rows as the pane → `viewer-renderer.test.ts` "matches the pane's header and transcript rows"
- Viewer footer → `session-navigator.test.ts` "fill footer shows status, position and hints"
- Resize re-flows → `viewer-renderer.test.ts` "re-flows on resize" + `session-navigator.test.ts` "fill layout fits short terminals"
- Viewer runs without Pi packages → `viewer.integration.test.ts` "starts without Pi packages" (hello and painted frame)
- Streaming is shown → `viewer-renderer.test.ts` "shows the streaming tail within one second"
- Tool uses its renderer → `viewer-renderer.test.ts` "uses live call and result renderers"
- Live source does not need the file → `viewer-source.test.ts` "is live for a ready record even without a file" + `viewer-renderer.test.ts` "shows live messages without a session file"
- Released session → `viewer-source.test.ts` "is file for a released record and for a snapshot target" + `viewer-renderer.test.ts` "switches live to file and back on one renderer"
- Extension tool after release → `viewer-renderer.test.ts` "renders a file-backed tool call like a file-backed pane"
- Resume switches to live → `viewer-source.test.ts` "switches live to file on release and back on resume" + `viewer-renderer.test.ts` "switches live to file and back on one renderer"
- Streaming after an event burst (Review Focus) → `viewer-renderer.test.ts` "recovers rows after a queue overflow" + "keeps a still-streaming message after an overflow"
- Follows by default / Scrolling up stops following / Back to the bottom resumes following → `viewer-renderer.test.ts` "follows, stops when scrolled up, resumes at bottom"
- Mouse wheel scrolls → `viewer-renderer.test.ts` "keys and wheel repaint a static source" + `viewer.integration.test.ts` "forwards wheel as wheel" + `frame-protocol.test.ts` "frames a wheel report split at every point"
- Remapped binding scrolls → `viewer-renderer.test.ts` "remapped page up scrolls"
- Close keys are ignored → `session-navigator.test.ts` "fill layout ignores close keys" + `viewer-renderer.test.ts` "ignores close keys and text"
- Channel closes → `viewer.integration.test.ts` "restores the terminal and exits when the channel closes" + `viewer.test.ts` "exit restores the terminal once"
- Private channel → `frame-server.test.ts` "creates a 0700 directory"
- No child, no channel → `frame-server.test.ts` "opens no socket before first use"
- Escape sequences are dropped → `frame-protocol.test.ts` "keeps SGR and OSC 8, drops other sequences" + `viewer.integration.test.ts` "paints received frames sanitized"
- Follows appended entries → `viewer-renderer.test.ts` "follows, stops when scrolled up, resumes at bottom" (frame within 50 ms)
- Input is discarded → `viewer-renderer.test.ts` "ignores close keys and text"
- File appears later → `viewer-source.test.ts` "empty until the file appears" + `viewer-renderer.test.ts` "shows a file that appears later within one second"
- Unparsable line → `viewer-source.test.ts` "skips unparsable lines"
- Completed child hides / Failed child hides / Stopped child hides → `viewer-renderer.test.ts` "status labels" + `herdr-observer.test.ts` existing hide tests (refresh asserted) + "refreshes the frame before queued placement"
- Waiting child finishes → `herdr-observer.test.ts` "Waiting child finishes" (refresh asserted)
- Viewer already closed → `column.test.ts` "Viewer already closed"
- Resumed child returns / Resumed child waits when the column is full → `herdr-observer.test.ts` existing tests (refresh asserted) + `viewer-renderer.test.ts` "status labels"
- Placement fails / Herdr command hangs / hc fails mid-session → `herdr-observer.test.ts` and `column.test.ts` existing tests
- Render fails → `viewer-renderer.test.ts` "keeps the last frame when render throws" + "contains component errors during input and resize" + "handles a timed-out escape only at a frame turn" + `frame-server.test.ts` "one renderer failing leaves another updating"
- Send fails → `frame-server.test.ts` "closes only the failing viewer"
