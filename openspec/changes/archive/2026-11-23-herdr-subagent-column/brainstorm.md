## Design Summary

When the main Pi session runs inside the Herdr desktop app (herdr-app, with terminals owned by herdr-core / `hc`), every subagent the session launches gets a read-only viewer terminal that Herdr shows next to the parent. The viewers stack vertically in one column on the right of the parent's pane. A viewer follows its child's session transcript live; it never accepts input that reaches the child. When a child finishes, its viewer leaves the column and stays reachable from Herdr's agent sidebar (as a sub-agent of the parent terminal), and from `/subagents:sessions`.

Intent: borrow the "watch your subagents in real panes" experience of pi-subagentura, without changing how this fork runs children. Children stay in-process; only observation moves into Herdr.

Layout the user sees:

```
+-------------------------+------------------+
|                         | [child A] live   |
|          pi             +------------------+
|     (keeps focus)       | [child B] live   |
|                         +------------------+
|                         | [child C] live   |
+-------------------------+------------------+
  child B finishes -> its pane leaves the column (A, C remain)
                      B stays under "pi" in Herdr's agent sidebar
```

Goals:
- Detect Herdr automatically; no configuration needed to get the column.
- Every child (foreground and background) gets a viewer while it runs.
- Finished children hide, never lose their transcript, and can be reopened.
- `/subagents:sessions` inside Herdr shows the picked child in Herdr instead of the in-TUI overlay.

Non-goals:
- Running children as separate processes, or moving execution into Herdr.
- Typing into a child from its viewer (steering stays with `steer_subagent`).
- Supporting the older `herdr` terminal multiplexer (`HERDR_ENV`, `HERDR_PANE_ID`), tmux, Zellij or WezTerm.
- Remote machines.

Anti-goals (a failure even if it technically works):
- The user's typing in the parent prompt lands in a viewer because a new pane stole focus.
- Any error, missing binary or Herdr hiccup breaks, slows or fails a subagent launch; outside Herdr the extension behaves exactly as today.
- The column grows until panes are unreadable.

Living specs involved:
- `fleet-view` / "Fleet list opens the session pane": `Enter` in the fleet list opens the in-TUI session pane and "MUST NOT open any other viewer", and `/subagents:sessions` "MUST keep its current behavior". This change keeps the fleet list `Enter` behavior unchanged and explicitly alters `/subagents:sessions` only when running inside Herdr (see Key Decisions).
- `subagent-run-facts`, `launch-metadata`: unchanged; the viewer reads what the session already records.

## Alternatives Considered

### Alternative A: Interactive child processes in Herdr (pi-subagentura style)
- **Approach**: launch each child as its own `pi` process inside an `hc` terminal and coordinate it through a bridge.
- **Pros**: the user can type into a child; true native panes.
- **Cons**: replaces the in-process runtime; steering, `ask_parent`, structured results, fork context, launch policy, grants and the fleet view would all need an IPC re-implementation. Most living specs would change.
- **Why not chosen**: the user wants observation only; the cost is a runtime rewrite.

### Alternative B: Popup on demand (Herdr peek)
- **Approach**: children run as hidden `hc` sub-agents listed in Herdr's sidebar; the transcript opens as a floating popup (`terminal.peek`) only when the user asks.
- **Pros**: never touches the layout or focus; cheapest.
- **Cons**: nothing is visible while children run unless the user opens it; a popup covers the parent.
- **Why not chosen**: the user wants running children visible beside the parent. Peek is kept as the way to reopen finished children.

### Alternative C: Read-only viewer column (chosen)
- **Approach**: one read-only viewer terminal per child, placed in a right-hand column stacked vertically, hidden into the sidebar when the child finishes.
- **Pros**: children are visible while they run; runtime and specs of execution are untouched; finished work stays reachable.
- **Cons**: must manage pane placement and give focus back to the parent; depends on the herdr-app command surface.
- **Why not chosen**: chosen.

## Agreed Approach

Alternative C. A spike in the user's Herdr confirmed the building blocks: a terminal started as a sub-agent of the parent can be given a pane to the right of the parent or below another pane, the column re-flows when one pane is hidden, a hidden terminal keeps running under the parent in Herdr's sidebar, a popup can show it again, and focus can be returned to the parent. It won because it gives the "watch them work" experience at a fraction of the cost of Alternative A, and keeps every execution guarantee of this fork.

## Key Decisions

- **Detection**: active only when the current terminal is a herdr-core terminal that Herdr shows in a space and tab; any other environment, or any failure to confirm it, means the feature is off for the session and nothing changes.
- **Scope**: every child, foreground and background, gets a viewer.
- **Placement**: the first viewer opens to the right of the parent pane; later viewers stack below the last viewer of that column. The parent pane keeps keyboard focus after every placement.
- **Column limit**: at most 4 viewers are shown in the column at once; further running children get a viewer that stays only in Herdr's sidebar (under the parent) until a column slot frees up. (Whether a waiting viewer moves into a freed slot is left to the design.)
- **Finish**: when a child finishes, its viewer shows that it is done and its pane is hidden (not closed); the viewer keeps running under the parent in the sidebar so the transcript can be reopened. It ends when the user closes it or the parent Pi process exits.
- **Read-only**: a viewer only renders the child's transcript; keystrokes in it never reach the child.
- **Live granularity**: the viewer updates as the child's session records each message (assistant turns, tool calls, tool results), not token by token. That is what the session already records; streaming tokens would need a new channel.
- **`/subagents:sessions` inside Herdr**: picking a running child focuses its viewer in the column; picking a finished child shows its viewer as a popup over the parent. Outside Herdr the command is unchanged. This is an explicit change to the `fleet-view` requirement that the command "MUST keep its current behavior".
- **Fleet list `Enter`**: unchanged in every environment (still opens the in-TUI session pane).
- **No setting in this change**: the feature turns on by detection alone; an opt-out setting can follow if needed.
- **Failure policy**: any Herdr or `hc` error during placement, hiding or reopening is swallowed (debug-logged) and never affects the child run.

## Open Questions

- When a column slot frees up, should the oldest waiting running child move into it automatically? (Builder's call in design; default: yes.)
- Children without a session file (in-memory sessions in headless use) have nothing to tail; default: no viewer for them.
- If the user rearranges or closes viewer panes by hand, the extension should adapt rather than fight it; exact reconciliation is a design concern.
