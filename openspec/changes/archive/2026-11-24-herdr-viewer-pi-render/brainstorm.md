## Design Summary

Inside Herdr, a subagent's viewer terminal (change `herdr-subagent-column`, ADR 0015) prints the child's transcript as plain text: raw markdown, tool calls as `-> <tool> <JSON args>`, tool results as dim text. Operators expect it to look like the in-TUI `/subagents:sessions` pane, which renders the same transcript with Pi's own components. This change makes the Herdr viewer visually equivalent to that pane (GitHub issue #16).

What the operator sees in a Herdr viewer after the change:

- The same transcript content the `/subagents:sessions` pane shows for that agent: user messages, assistant markdown, thinking, tool executions drawn by each tool's own renderer (including tools registered by other extensions), compaction and branch summaries.
- Live streaming like the pane: the in-flight assistant message as it is generated and the activity row for running tools.
- The pane's frame: a header rule naming the agent and its model, a footer rule with the line count and scroll position, and the transcript following new output at the bottom.
- Scrolling inside the viewer with the pane's keys (line up/down, page up/down, top/bottom) and the mouse wheel; scrolling up stops following, scrolling back to the bottom resumes it.
- The finished and resumed status lines the viewer already prints, kept in the new frame.

What stays the same:

- The viewer stays read-only toward the child: no key or text typed in a viewer reaches the child or a shell. Only scroll keys act, and only inside the viewer.
- Column placement, overflow, parking, resume, `/subagents:sessions` inside Herdr, cleanup and failure isolation behave as the `herdr-viewer-column` spec specifies today.
- Outside Herdr nothing changes; the in-TUI pane is the reference look, not something this change modifies.

Existing requirements this change touches (living spec `openspec/specs/herdr-viewer-column/spec.md`):

- **Viewer is read-only** — altered. Today it says the viewer shows the transcript "as plain text" and that "every key typed in a viewer is discarded". After the change the viewer shows the transcript rendered like the `/subagents:sessions` pane, and scroll keys are handled inside the viewer while every other key is still discarded. Its scenarios (follows appended entries within one second, input is discarded, file appears later, unparsable line skipped) are kept in spirit and re-stated for the new rendering.
- **Finished child leaves the column** and **Resumed child returns to the column** — kept; the "done (<status>)" and "runs again" lines must still appear, now inside the rendered frame.
- **Viewer cleanup** — kept: a viewer whose Pi process exited still exits within 2 seconds without its pane turning into a shell.
- **Failure isolation** — kept and extended: rendering and delivering the transcript to viewers MUST NOT change any child's execution, result, events or timing.
- **Sessions command inside Herdr** / **Sessions command falls back** — kept unchanged.
- `fleet-view` — not affected; the fleet list and its `Enter` still open the in-TUI pane.

ADR 0015's consequence "The viewer is plain text and read-only: no steer, no input, no Pi components" no longer holds for the "no Pi components" part; a new ADR records the change.

## Alternatives Considered

### Alternative A: Viewer runs Pi's components itself

- **Approach**: Run the viewer process through Pi's runtime (a Pi-hosted entry or jiti) and reuse `TranscriptContent` with a file-based live source that re-reads the session file.
- **Pros**: The viewer stays independent of the main process once started; no channel between Pi and the viewer.
- **Cons**: The viewer only sees the session file, so it has no streaming (no in-flight message, no activity row) and no extension tool renderers (only the main process holds the tool registry); tools fall back to the generic renderer. The viewer must resolve `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` from its own process, which fails for package installs where Pi suppresses peer installation and for compiled single-binary Pi.
- **Why not chosen**: It cannot reach "visually equivalent" (streaming and tool renderers missing) and is fragile across install layouts.

### Alternative B: Main Pi process renders, viewer is a display sink

- **Approach**: The main Pi process, which already renders the pane for `/subagents:sessions`, renders each viewer's transcript with the same components and sends finished frames to the viewer; the viewer only paints what it receives and reports its size and scroll keys back.
- **Pros**: Exactly the pane's look, including streaming and extension tool renderers, because it is the same code with the same live source. The viewer stays dependency-free and starts under every install layout that runs it today.
- **Cons**: Needs a channel from Pi to each viewer and a render loop per viewer in the main process; that work must stay isolated from child execution.
- **Why not chosen**: Chosen (see Agreed Approach).

### Alternative C: Reduced renderer ported into the viewer

- **Approach**: Write a small markdown and tool renderer inside the viewer that imitates Pi's components without depending on them.
- **Pros**: No dependency on Pi inside the viewer and no channel.
- **Cons**: Only approximates the look; drifts as Pi's components change; no extension tool renderers; no streaming.
- **Why not chosen**: Fails the acceptance criterion of visual equivalence and adds a maintenance burden.

## Agreed Approach

Alternative B: the main Pi process renders each viewer's transcript with the same components and source the `/subagents:sessions` pane uses, and the viewer becomes a dumb display sink in a full-screen frame like the pane. The user picked B because only it gives full equivalence (live streaming and every tool's own renderer), and picked the full-screen frame with in-viewer scrolling over appending to terminal scrollback, because an appended stream cannot redraw an in-flight message.

## Key Decisions

- Fidelity target: full equivalence with the `/subagents:sessions` pane, including live streaming and extension tool renderers (user choice).
- Rendering happens in the main Pi process, reusing the pane's components; the viewer does not import Pi packages (user choice).
- The viewer is a full-screen frame like the pane, with its own scrolling; scroll keys and the mouse wheel act inside the viewer only, every other key is discarded, and nothing reaches the child (user choice).
- The `herdr-viewer-column` requirement "Viewer is read-only" is altered (plain text → pane rendering; all keys discarded → scroll keys handled locally). All other requirements of that capability stay as specified.
- A new ADR supersedes the "no Pi components" part of ADR 0015.

## Open Questions

- What a viewer shows for an agent whose live session was released (for example one picked in `/subagents:sessions` after a `/reload`): the pane falls back to the session file without streaming; the viewer should match that, to be confirmed in design.
- Whether the viewer keeps working, showing its last frame, if the channel to Pi breaks while Pi is still alive, or exits; design to decide within the existing cleanup guarantees.
