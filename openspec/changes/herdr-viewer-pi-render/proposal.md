## Why

Inside Herdr every subagent gets a viewer terminal next to Pi, but it prints the transcript as plain text: raw markdown, tool calls as `-> <tool> <JSON>`, no tool framing, no streaming. The same transcript in `/subagents:sessions` renders with Pi's own components. Operators read the viewer as "a Pi agent" and expect that look (GitHub issue #16). Fixing it now keeps the Herdr column, which just shipped, from being the second-class way to watch a child.

## What Changes

**Viewer rendering**
- From: the viewer process reads the session JSONL and prints plain text lines.
- To: the main Pi process renders each viewer's transcript with the same pane, components and live source as `/subagents:sessions` (assistant markdown, thinking, tool renderers including extension tools, live streaming) and streams finished frames to the viewer over a private local channel; the viewer only paints them.
- Reason: only the main process has the live session (streaming) and the tool registry (extension renderers), and only it can load Pi's components under every install layout.
- Impact: non-breaking for the service and its consumers; visible change inside Herdr only.

**Viewer input**
- From: every key typed in a viewer is discarded.
- To: the viewer is a full-screen frame like the pane; scroll keys (Pi's bindings) and the mouse wheel scroll it, every other key is discarded; nothing reaches the child or a shell.
- Reason: a full-screen frame is needed to redraw the in-flight message; it then needs its own scrolling.
- Impact: non-breaking; viewers stay read-only toward the child.

**Viewer status**
- From: the viewer prints `done (<status>)` and `running again` lines, driven by per-viewer status files.
- To: the same `done (<status>)` and `running again` labels show as the status segment of the viewer frame's footer (`running` before the first finish), read from the record; the status files go away.
- Reason: the frame is redrawn from the record, so a separate status channel is redundant.
- Impact: non-breaking.

Column placement, overflow, parking, resume placement, `/subagents:sessions` inside Herdr, cleanup and failure isolation keep their behavior. Outside Herdr nothing changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `herdr-viewer-column`: "Viewer is read-only" changes from plain text and all-keys-discarded to pane rendering with local scrolling; "Finished child leaves the column" and "Resumed child returns to the column" show the run state in the frame instead of printing a line; "Failure isolation" covers rendering; new requirements for pane-equivalent rendering, the viewer as a display sink, the viewer's transcript source, viewer scrolling and the viewer channel.

## Impact

- Code: `src/herdr/` (viewer program rewritten as a frame painter; new frame server, renderer and headless TUI adapter; `status-files.ts` removed; observer, process launch and activation rewired), `src/ui/session-navigator.ts` (`TranscriptPane` gains a fill-the-terminal, non-closable layout), `src/index.ts` (passes the session's theme to activation).
- Tests: `test/herdr/*` for the new units and the rewritten viewer, `test/ui/session-navigator.test.ts` for the new layout.
- No new dependency; public types and the service are unchanged (`bun run verify:public-types`).
- Docs: new ADR `docs/decisions/0016-herdr-viewer-renders-in-pi.md` superseding ADR 0015's "plain text, no Pi components" consequence; README "Herdr" section; `CHANGELOG.md` entry.
- `UPSTREAM.md`: update the `src/ui/session-navigator.ts`, `src/index.ts`, `test/ui/session-navigator.test.ts` and `src/herdr/viewer.ts` rows; add rows for each new `src/herdr/` and `test/herdr/` file; remove the `src/herdr/status-files.ts` and `test/herdr/status-files.test.ts` rows.
