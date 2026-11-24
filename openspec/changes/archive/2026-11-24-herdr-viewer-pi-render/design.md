## Context

Today (change `herdr-subagent-column`, ADR 0015):

- `HerdrViewers` (`src/herdr/herdr-observer.ts`) starts one viewer terminal per child with `hc run --bg`, through `ViewerProcesses` (`src/herdr/viewer-process.ts`), passing `--file <outputFile> --status <statusFile> --pid --parent-terminal --title`.
- The viewer (`src/herdr/viewer.ts`) is a standalone TypeScript program run by Bun or Node type stripping (`src/herdr/runtime.ts`), importing only `node:` built-ins. It tails the JSONL by byte offset and prints plain text; it polls a status file (`src/herdr/status-files.ts`) for `done (<status>)` / `running again`, and exits when the Pi pid dies.
- The in-TUI pane is `TranscriptPane` (`src/ui/session-navigator.ts`) over `TranscriptContent` (`src/ui/transcript-content.ts`), fed by a `TranscriptSource`: `liveSource(record)` (settled messages, streaming state, tool registry) or `fileSnapshotSource(outputFile, readFile)` (static). It needs a `TUI` (only `requestRender()` and `terminal.columns/rows` are used by the pane and Pi's transcript components it mounts), a Pi `Theme`, a `PaneKeys` keybindings manager and a `MarkdownTheme`.

The brainstorm fixed the approach: the main Pi process renders, the viewer is a display sink in a full-screen frame with local scrolling.

## Goals / Non-Goals

**Goals:**

- A Herdr viewer paints exactly the rows `TranscriptPane` produces for the same agent, at the viewer's terminal size, live.
- The viewer stays dependency-free (`node:` built-ins, erasable syntax) and keeps every guarantee of `herdr-viewer-column` that this change does not alter.
- Reuse `TranscriptPane` / `TranscriptContent` / `liveSource` / `fileSnapshotSource` unchanged in behavior for the in-TUI pane.

**Non-Goals:**

- Steering or any input to the child from a viewer.
- Rendering `custom`-role messages (the pane does not either).
- Images in viewers (`showImages: false`, as in the pane).
- Changing placement, overflow, park, peek, detection or cleanup.
- A setting to turn rendering off.

## Decisions

### D1. Transport: one Unix domain socket per Herdr activation, NDJSON frames

`FrameServer` (`src/herdr/frame-server.ts`) listens with `node:net` on `<dir>/s`, where `<dir>` is a fresh `mkdtemp` directory with mode `0700` under `<tmpdir>/pi-subagents-herdr/` (the same root the status files use today). The server and its sockets are `unref`'d, so they never keep Pi alive. Messages are newline-delimited JSON (`frame-protocol.ts`, see plan Contracts):

- viewer → Pi: `hello { key, cols, rows }`, `resize { cols, rows }`, `input { data }`, `wheel { delta }`.
- Pi → viewer: `frame { lines }` (the full frame, one string per terminal row).

Alternatives: a file the viewer polls (latency, disk churn, no input path back); a TCP loopback port (needs auth, visible to other users); `hc` stdin injection (Herdr has no such API). The `0700` directory is the access boundary: only the same user can connect, and that user already owns the session. The macOS socket path limit (104 bytes) is checked at listen; a path too long or a listen failure makes the column inactive for viewers (logged), as any Herdr failure does.

### D2. The viewer program becomes a frame painter

`src/herdr/viewer.ts` keeps its standalone constraints and its parent-pid watch and `hc keep --off` exit path. It now:

- connects to `--socket`, sends `hello` with `--key` and `process.stdout.columns/rows`, sends `resize` on `SIGWINCH`;
- enters the alternate screen, hides the cursor, enables SGR mouse reporting, and paints each `frame` in one synchronized-output write (`CSI ?2026h … CSI ?2026l`): cursor home, each row followed by erase-to-end-of-line, then erase below;
- reads stdin in raw mode: SGR wheel reports become `wheel { delta: ±3 }`, other mouse reports are dropped, everything else is sent as `input { data }`;
- on socket close or error, and when the Pi pid is gone, restores the screen, turns its own keep off and exits (within 2 s of Pi dying: pid check every 1 s, as today).

Paint-side sanitizing (`sanitizeFrameLine`): rows come from Pi's components and legitimately carry SGR styling and OSC 8 hyperlinks, so the plain-text `sanitize` no longer fits. The viewer keeps only `CSI <params> m` and `OSC 8 ; params ; uri ST` and drops every other escape sequence and every C0/C1 control character. Transcript text therefore cannot move the cursor, clear the screen, set the title or switch modes, whatever the components let through.

The protocol types and parsers live in `src/herdr/frame-protocol.ts` (only `node:` built-ins, no Pi packages, erasable syntax) imported by `viewer.ts` as `./frame-protocol.ts`; this needs `allowImportingTsExtensions` in `tsconfig.json` (allowed because the project is `noEmit`). Alternative: duplicate the protocol in the viewer; rejected because the two ends would drift silently.

### D3. Rendering host: `ViewerRenderer` per connected viewer, around `TranscriptPane`

`ViewerRenderer` (`src/herdr/viewer-renderer.ts`) owns one `TranscriptPane` in a new `fill` layout, a `HeadlessTui`, a `DeferredSource` and a frame scheduler:

- `HeadlessTui` (`src/herdr/headless-tui.ts`) implements the `TUI` members the pane and Pi's transcript components use: `requestRender()` (schedules a frame), `terminal.columns/rows` (the viewer's size), `mode: "regular"`, `invalidate()`. It is cast to `TUI` in this one module.
- **Deferred events.** `TranscriptPane` calls `content.apply(event)` inside its source subscription, and `apply` builds `ToolExecutionComponent`s, whose constructors and `updateResult` run extension `renderCall`/`renderResult` immediately. So the pane never subscribes to the real source: it subscribes to `DeferredSource` (`src/herdr/deferred-source.ts`), whose callback on the real source only queues the event and schedules a frame. At the frame turn the renderer flushes the queue into the pane's listener, then renders, all inside one `try`/`catch`. Consecutive `message_update` events collapse to the latest; every other event is kept in order. If the queue still passes 256 events, it is dropped and the renderer calls `pane.resync()` at the frame turn instead: a new `TranscriptPane.resync()` → `TranscriptContent.resync()` that resets settled blocks and the in-flight message and re-consumes the source's current history (an `undefined` event is not enough: `apply(undefined)` keeps a stale in-flight message). Independently of the queue, `DeferredSource` keeps the latest assistant `message_start`/`message_update` event and clears it on `message_end`, `agent_end` or a source switch; after a resync it delivers that event, so a message still streaming stays visible without waiting for its next token. The in-TUI pane keeps subscribing directly and is unchanged.
- **Frame scheduler.** A frame is scheduled by queued source events, `requestRender()`, `resize`, `input`, `wheel` and `refresh()`; at most one frame per 50 ms per viewer, on an `unref`'d timer. `refresh()` only sets a pending flag; the source refresh (which may switch sources and read the file), the status recompute, the deferred flush and the render all run at the frame turn. Nothing renders, reads a file or runs a tool renderer inside a lifecycle hook or a source callback. A flush or render that throws is logged and the frame skipped; the viewer keeps its last frame.
- **Input.** `wheel` and `resize` messages are only queued (wheel deltas summed, the last size wins); `input.data` is fed to pi-tui's `StdinBuffer`, whose listener only queues decoded keys (at most 64 applied per frame); all schedule a frame. The frame turn applies them inside its error boundary: the pending size (`tui.resize` + `pane.invalidate()`), then decoded keys into `pane.handleInput`, then the summed wheel into `pane.handleMouse`. The `StdinBuffer` that splits `input.data` into keys only enqueues decoded keys and schedules a frame, including when its own escape timeout fires later, so `pane.handleInput` runs only at the frame turn. `handleInput`, `handleMouse` and `invalidate` can run component code (scroll bounds render cold rows), so none of them runs in a socket callback. The pane only scrolls, so nothing reaches the child. `StdinBuffer` arms a short referenced escape timeout (bounded, owned by pi-tui); `dispose()` calls `destroy()` on it, so none outlives the renderer.

**Source.** `SwitchableSource` (`src/herdr/viewer-source.ts`) is the `TranscriptSource` under `DeferredSource`. It holds the current inner source and its kind (`live` | `file`): `liveSource(record)` while `record.isSessionReady()`, otherwise `followedFileSource(outputFile)`; snapshot targets are always `file`. While subscribed it probes readiness every 1000 ms (`unref`'d) and on `refresh()`; when the kind changes (resume makes the session ready, or `releaseSession()` drops it, which fires no hook) it swaps the inner source and emits one `undefined` event. `TranscriptContent` sees a history whose last consumed message is a different object and rebuilds its blocks, dropping tool components built with the old tool definitions. The pane itself is kept, so its scroll offset and follow state survive the switch.

`followedFileSource` wraps `fileSnapshotSource(outputFile, readFile)` and polls the file's size and mtime every 300 ms (`unref`'d, only while subscribed), rebuilding the snapshot and notifying when either changes. A missing or unreadable file yields an empty message list, and a failed read does not record the size and mtime as seen, so the next poll reads again; `parseSessionEntries` already skips invalid JSON lines. File sources have no tool definitions, so tools use the pane's generic fallback, exactly as `/subagents:sessions` does for the same file.

**Theme, keys, heading.** Theme: the main session's `ctx.ui.theme`, passed `session_start` → `HerdrActivation.start({ cwd, mode, theme })` → `Activate(cwd, mode, theme)` → `ActivateInput.theme`. Keys: pi-tui's `getKeybindings()` (the manager interactive mode installs, so remaps apply). Markdown theme: `getMarkdownTheme()`. Heading: the `EntryHeading` the navigator builds; `buildHeading` in `src/ui/session-navigation.ts` is exported and `HerdrViewersDeps.titleOf` becomes `headingOf: (record) => EntryHeading`, so a viewer's header matches the pane for display names and fork labels. Snapshot entries already carry their heading.

### D4. `TranscriptPane` gains a `fill` layout and a status label

`TranscriptPaneOptions` gains `layout?: "docked" | "fill"` (default `docked`, today's behavior) and `status?: () => string | undefined`. In `fill`:

- the frame is exactly `terminal.rows` lines: header rule, `rows - 2` transcript rows and footer rule when `rows >= 2` (no `MIN_VIEWPORT` floor), the footer rule alone when `rows` is 1;
- `Esc` and `q` are ignored (the viewer cannot close; Herdr parks or the user closes the pane);
- the footer hint drops `Esc close`.

When `status` returns a label, the footer's left label is one string `<status> · <N> lines · <pct>`, with the fallback `<status>` when it does not fit; `labeledRule` treats its left list as fallbacks, not segments. The in-TUI pane passes neither option and is unchanged.

Alternative: a new viewer-specific pane class; rejected because it would fork the chrome and scroll logic the brainstorm asks to match.

### D5. Run state in the frame replaces status files

`viewerStatusLabel` reads the record: `running` for `queued`/`running` on the first run the viewer saw, `running again` once the viewer has seen the record finish and start again, `done (<status>)` otherwise; snapshot entries show `done`. This keeps the brainstorm's finished and resumed lines, moved from printed lines into the footer's status segment.

The run-started and run-finished hooks of `HerdrViewers` call `frames.refresh(record.id)` directly, before enqueueing their Herdr job. `refresh` only marks the renderer and schedules a frame (no render, no I/O), so the hook still just queues work and returns, and the label is not delayed behind placement commands in the serial queue (each may take up to 2 s). `ViewerStatusFiles` and its tests are deleted.

### D6. Ownership and lifetime

`HerdrViewers` keeps the serial queue and the column; it gains a `FrameServer` dependency instead of `ViewerStatusFiles`:

- inside the start job, the observer awaits `frames.socketPath()` (none → no viewer, logged), then `frames.register(key, target)` before `processes.start(...)`; `FrameServer` creates the `ViewerRenderer` when a `hello` with that key arrives (a later connection for the same key replaces the earlier one, which is closed);
- `ViewerProcesses` passes `--socket <path> --key <key> --pid --parent-terminal` (no `--file`, `--status`, `--title`);
- `forget` unregisters the key; `dispose()` ends the viewer terminals as today, then closes the server, its sockets and renderers, and removes the directory. A viewer whose socket closes exits on its own (D2), so even a failed `hc kill` leaves no stale frame.

`FrameServer` listens lazily on the first `socketPath()`, so a session with no child opens no socket.

### D7. Transport bounds and backpressure

Per connection, the server keeps at most one unsent frame: when `socket.write` returns `false` it stops writing, replaces the pending frame with each newer one, and writes the latest on `drain`. Incoming lines are capped at 65536 bytes (`MessageSplitter` reports overflow), `input.data` at 4096 UTF-16 code units, and `cols`/`rows` at 1–1000. The viewer is the only legitimate client, so the server closes a connection on any line it rejects: over the cap, malformed JSON, unknown type or a field out of bounds; other connections are unaffected. The viewer splits forwarded input into chunks of at most 4096 code units without splitting a surrogate pair, so a large paste never trips the cap. The viewer caps a received line at 4194304 bytes and exits on overflow. Write errors close the connection (D3).

The viewer frames its stdin with a stateful `InputFramer`: it holds a trailing incomplete SGR mouse report (`ESC [ <` …, at most 32 bytes) until the next chunk, emits each complete wheel report as `wheel`, drops other mouse reports and forwards everything else as `input`.

## Migration Plan

No data migration. Status files under `<tmpdir>/pi-subagents-herdr/<pid>-*` stop being written; existing directories from older runs are left as before (they were removed at shutdown). Rollback is reverting the change; the old viewer needs no state.

## Open Questions

None. The brainstorm's open questions are settled by D3 (snapshot source for released or pre-reload agents) and D2 (the viewer exits when the channel closes).
