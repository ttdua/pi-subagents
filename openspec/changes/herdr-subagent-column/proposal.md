## Why

Subagents run in-process and are only visible through the `Agents` widget, the fleet list and the in-TUI session pane, one at a time. Users who run Pi inside the Herdr desktop app already have a terminal workspace that can show many terminals side by side, and pi-subagentura shows that watching children in real panes is valuable. This change brings that experience to this fork without changing how children execute: every child gets a read-only viewer in a column beside the parent while it runs.

## What Changes

- New: when the main session runs inside Herdr (a herdr-core terminal that Herdr shows in a space and tab), every subagent with a session file gets a read-only viewer terminal. Viewers stack vertically in one column to the right of the parent pane, at most 4 at a time; the parent keeps keyboard focus.
- New: when a child finishes, its viewer marks it done and leaves the column; the viewer stays reachable under the parent in Herdr's agent sidebar. A running child waiting for a column slot moves in when one frees up.
- New: a dependency-free viewer program shipped with the package that follows a session file and renders its transcript as plain text.

**`/subagents:sessions` inside Herdr**
- From: the picked agent's transcript always opens in the in-TUI read-only pane, and the command "MUST keep its current behavior".
- To: inside Herdr, a running agent's viewer is focused and a finished agent's viewer is shown as a popup over the parent; if Herdr cannot show it, the in-TUI pane opens as before. Outside Herdr nothing changes.
- Reason: the user picked "show it in Herdr" for the command.
- Impact: non-breaking; only users inside Herdr see a difference.

The fleet list's `Enter` behavior is unchanged everywhere.

## Capabilities

### New Capabilities
- `herdr-viewer-column`: detecting Herdr, placing read-only subagent viewers in a right-hand column, hiding finished ones, overflow, reopening from `/subagents:sessions`, cleanup and failure isolation.

### Modified Capabilities
- `fleet-view`: the requirement "Fleet list opens the session pane" stops requiring `/subagents:sessions` to keep its exact behavior; inside Herdr the command shows the picked agent's Herdr viewer.

## Impact

- Code: new `src/herdr/` module (detection, command port, column placement, viewer process, observer, and the `viewer.ts` program, shipped through the existing `src` entry of `files`), wiring in `src/index.ts`, a Herdr branch in `src/ui/session-navigator.ts`.
- No new dependency, no public service API change, no setting. Uses the external `hc` and `herdr-app` CLIs only when present.
- `UPSTREAM.md`: extend the rows for `src/index.ts`, `src/ui/session-navigator.ts`, `test/ui/session-navigator.test.ts`, `test/composition-root.test.ts` and any other upstream test touched; `add` rows for every new file under `src/herdr/` and `test/herdr/`.
- `docs/`: a new ADR `docs/decisions/0015-subagent-viewers-in-a-herdr-column.md`; a "Herdr" section in `README.md`; a line in `docs/comparison-with-upstream.md`.
- `CHANGELOG.md`: an "Unreleased" entry.
