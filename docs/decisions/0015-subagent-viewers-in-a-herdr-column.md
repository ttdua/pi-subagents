---
status: accepted
date: 2026-11-23
---

# 0015 — Subagent viewers live in a Herdr column

## Status

Accepted.
Adds a second surface next to [ADR 0013]: inside Herdr, `/subagents:sessions` can open a Herdr viewer instead of the in-TUI pane.
The fleet list's `Enter` keeps [ADR 0013]'s behavior.

## Context

Children run in-process (`createAgentSession`), and Pi persists each child's transcript as JSONL; `Subagent.outputFile` exposes the path and keeps it after the live session is released.
The in-TUI transcript pane ([ADR 0013]) shows one agent at a time, and only on request.
Operators who run Pi inside Herdr already have a multiplexer that can show several terminals at once.

Herdr facts, verified in a spike:

- `hc run --bg` from Pi's terminal creates a sub-agent terminal with no pane; Herdr lists it under Pi in its sidebar.
- `herdr-app do terminal.keep --place right|down` gives that terminal a pane next to the focused pane; `terminal.park` removes the pane and returns it to the sidebar.
- `terminal.peek` shows a live terminal as a popup.
- Terminals started with `herdr.space`/`herdr.tab` labels each open as a new column, and `pane.split` terminals have no parent, so neither forms a stack that can be hidden.

## Decision

Inside Herdr, each child gets a read-only viewer in a column right of Pi.

- **Module and port:** a `src/herdr/` module whose only outside seam is one `HerdrCli` port (`pi.exec` with a 2 s timeout, never rejecting). One serial queue, owned by the lifecycle observer, runs every Herdr job.
- **Detection:** active only in the interactive TUI, with `HC_TERMINAL_ID` set, `hc get` showing the Herdr labels, and `herdr-app ls` listing the terminal in that tab. Any failure means inactive. Children, print, JSON and RPC modes never activate.
- **Viewer:** `hc run --bg` starts a viewer terminal, placed with `terminal.keep`. The viewer is a TypeScript program using only `node:` built-ins and erasable syntax. It follows the child's transcript file and prints plain text. It discards input.
- **Placement:** at most 4 viewers in the column. The first goes right of Pi, the rest stack below. Focus is read before placement and restored after. Further viewers wait in a FIFO, in the sidebar under Pi.
- **Finish and resume:** a finished child's viewer is parked (hidden, not closed) and a status file tells it to print `done (<status>)`. A resumed child's viewer returns to the column, or waits when it is full.
- **`/subagents:sessions` inside Herdr:** a running agent's viewer is focused; a finished or waiting one opens as a popup. On any Herdr failure the command falls back to the in-TUI pane.
- **Cleanup:** shutdown ends every viewer. Each viewer also exits when Pi's process disappears, turning its own keep off first, so no pane turns into a shell.
- **Failure isolation:** hooks never throw and never await Herdr. A failed command is logged and ignored, and the child is unaffected.
- **No setting yet.**

## Consequences

- `/subagents:sessions` inside Herdr is the one exception to [ADR 0013]'s "the fleet list opens the in-TUI pane and nothing else": the command may open a Herdr viewer. The fleet list's `Enter` is unchanged, and outside Herdr nothing changes.
- The viewer is plain text and read-only: no steer, no input, no Pi components. Observation is the goal; `steer_subagent` stays the control path.
- The viewer needs Bun or Node 22.18 or later (which strips types by default), else `node` on `PATH`. Compiled single-binary Pi installs without `node`, and installs under `node_modules` (Node does not strip types there), cannot start it. That means "no viewer", and the in-TUI pane still works.
- Children launched before detection resolves get no column viewer; `/subagents:sessions` reaches them.
- A viewer closed by the user is replaced on the agent's next resume or pick in `/subagents:sessions`.
- Depends on `hc` and `herdr-app` command names and reply shapes. A change in either fails closed into "no viewer".
- The fork's vendored diff grows by the `src/herdr/` module, its tests and wiring in `index.ts` and `session-navigator.ts`. Each is listed in `UPSTREAM.md`.

[ADR 0013]: 0013-fleet-list-opens-the-session-pane.md
