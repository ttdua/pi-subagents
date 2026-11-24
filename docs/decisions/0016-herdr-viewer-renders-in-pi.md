---
status: accepted
date: 2026-11-24
---

# 0016 — Herdr viewers render in Pi

## Status

Accepted.
Supersedes the rendering part of [ADR 0015]: placement, detection, overflow, park and cleanup are unchanged.

## Context

[ADR 0015]'s viewer was a standalone program that tailed the child's transcript file and printed plain text.
It showed none of what `/subagents:sessions` shows: no markdown, no tool renderers (including extension tools), no streaming tail ([issue #16](https://github.com/ttdua/pi-subagents/issues/16)).
The viewer cannot import Pi's components itself, because it must run under plain Bun or Node with only `node:` built-ins.

## Decision

The main Pi process renders; the viewer only paints.

- **Rendering:** per viewer, Pi renders the same `TranscriptPane` the in-TUI pane uses, in a new `fill` layout that takes every terminal row. The pane runs on a terminal-less `HeadlessTui` at the viewer's size.
- **Channel:** one Unix socket per activation, in a `0700` temporary directory, carrying NDJSON. The viewer sends `hello`, `resize`, `input` and `wheel`; Pi sends whole `frame`s. The server and sockets never keep Pi alive. A socket path that is too long, or a listen failure, means no viewer.
- **Viewer:** a `node:`-only frame painter. It uses the alternate screen and synchronized output, turns SGR wheel reports into `wheel`, and keeps only SGR styling and OSC 8 links in received rows, so transcript text cannot move the cursor or change modes. It restores the terminal and exits when the channel closes or Pi's process is gone.
- **Event timing:** the pane never subscribes to the real source. A `DeferredSource` queues events, so tool renderers run only at a frame turn inside an error boundary, at most one frame per 50 ms per viewer. Input is also applied at the frame turn.
- **Source:** a switchable source is live while the child has a session and follows the session file once it is released, and switches back on resume. The pane, and so the scroll position, survives the switch.
- **Status:** the run state (`running`, `running again`, `done (<status>)`) is shown in the pane's footer; status files are removed.
- **Bounds and backpressure:** the event queue is capped (over the cap it is dropped and the pane resyncs from the source), frames and messages have size limits, and a viewer that cannot keep up or fails is closed alone.

## Consequences

- Viewers show what the pane shows: markdown, tool call and result renderers (including extension tools), and the streaming tail.
- Scroll keys (remapped ones too) and the mouse wheel scroll the viewer; `Esc` and `q` are ignored. A viewer stays read-only toward the child.
- Status files and their tests are gone.
- Tool renderers that need `TUI` members `HeadlessTui` lacks fall back or show an error for that row. The last frame stays.
- The viewer's runtime requirement is unchanged from [ADR 0015]; a socket path over the platform limit (about 104 bytes on macOS) yields no viewer.
- Rendering cost in Pi grows with the number of connected viewers (waiting and hidden ones stay connected). Each viewer is limited to one frame per 50 ms and renders only when something changed.

[ADR 0015]: 0015-subagent-viewers-in-a-herdr-column.md
