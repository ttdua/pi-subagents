# herdr-viewer-column Specification

## Purpose
When the main Pi session runs inside the Herdr desktop app, every subagent gets a read-only viewer terminal that Herdr shows in a column next to the main pane; viewers stack, hide when their child finishes, can be reopened from `/subagents:sessions`, are cleaned up with the session, and never affect child execution.

## Requirements
### Requirement: Herdr detection
At each `session_start`, the executor SHALL decide once, without delaying the session start, whether the session has an active Herdr column. It MUST be active only when `ctx.mode` is `tui`, `HC_TERMINAL_ID` is set, `hc get <HC_TERMINAL_ID> --json` exits 0 with `labels` holding `herdr.space` and `herdr.tab`, and `herdr-app ls` exits 0 listing that terminal with a pane in that tab. `HERDR_ENV` and `HERDR_PANE_ID` MUST NOT be consulted.

#### Scenario: Inside Herdr
- **WHEN** a main session with a UI starts in a terminal whose `hc get` labels carry `herdr.space` and `herdr.tab`, and `herdr-app ls` shows that terminal with a pane in that tab
- **THEN** the Herdr column is active for that session

#### Scenario: Outside Herdr
- **WHEN** `HC_TERMINAL_ID` is not set
- **THEN** the column is inactive and no `hc` or `herdr-app` command is run for that session

#### Scenario: Terminal not shown by Herdr
- **WHEN** `hc get` succeeds but the labels lack `herdr.tab`
- **THEN** the column is inactive

#### Scenario: Herdr app unreachable
- **WHEN** the `hc` checks pass but `herdr-app ls` exits non-zero
- **THEN** the column is inactive

#### Scenario: Child session
- **WHEN** the extension loads in a child session, which has no UI
- **THEN** the column is inactive in that child session

#### Scenario: RPC mode
- **WHEN** Pi runs in RPC mode inside a Herdr terminal
- **THEN** the column is inactive

#### Scenario: Shutdown before detection ends
- **WHEN** the session shuts down before detection has answered
- **THEN** no column becomes active for that session and no viewer is started

### Requirement: Inactive column changes nothing
When the column is inactive, the executor MUST behave exactly as without this capability: it SHALL run no `hc` or `herdr-app` command after detection and start no viewer. A detection check that fails, times out or returns unexpected output MUST leave the column inactive.

#### Scenario: Detection times out
- **WHEN** `hc get` does not answer within its timeout
- **THEN** the column is inactive and children run with no viewer

### Requirement: Running and finished
In this capability a child SHALL count as running from the moment a run of it starts (initial or resume) until that run ends, and as finished once that run ends with any terminal status: `completed`, `aborted`, `stopped` or `error`.

#### Scenario: Aborted counts as finished
- **WHEN** a child's run ends `aborted` at its turn limit
- **THEN** the child counts as finished

### Requirement: Viewer per child
While the column is active, every subagent run, foreground or background, SHALL get one read-only viewer terminal as soon as its record has an `outputFile`, started with `hc run --bg` from the main session's terminal so herdr-core records that terminal as its parent. A run that finishes before its record has an `outputFile` MUST NOT get a viewer. A resumed record SHALL reuse its viewer while that viewer's terminal is live, and get a new one otherwise.

#### Scenario: Background child gets a viewer
- **WHEN** the column is active and a background child starts and its record gets an `outputFile`
- **THEN** one viewer terminal is started with `hc run --bg` for that file

#### Scenario: Foreground child gets a viewer
- **WHEN** the column is active and a foreground child starts and its record gets an `outputFile`
- **THEN** one viewer terminal is started for that file

#### Scenario: No session file
- **WHEN** a child's run finishes and its record never had an `outputFile`
- **THEN** no viewer is started for it

#### Scenario: Resume reuses the viewer
- **WHEN** a finished child with a live viewer is resumed
- **THEN** no second viewer is started for it

#### Scenario: Resume after the viewer was closed
- **WHEN** the user ended a finished child's viewer terminal and the child is resumed
- **THEN** a new viewer is started for it

### Requirement: Viewer is read-only
A viewer SHALL show the child's transcript from its session file as plain text, following new entries as the session appends them, under a title line with the agent's name and description. It MUST NOT forward any input to the child or to a shell: every key typed in a viewer is discarded. A viewer whose file does not exist yet SHALL wait for it, and lines it cannot parse MUST be skipped without stopping the viewer.

#### Scenario: Follows appended entries
- **WHEN** the child's session appends an assistant message to its file
- **THEN** the viewer prints that message's text within one second

#### Scenario: Input is discarded
- **WHEN** the user types into a viewer and presses Enter
- **THEN** nothing is sent to the child and the viewer keeps running

#### Scenario: File appears later
- **WHEN** a viewer starts before the session has written its file
- **THEN** it waits and starts printing once the file appears

#### Scenario: Unparsable line
- **WHEN** the file contains a line that is not valid JSON
- **THEN** the viewer skips that line and prints the following entries

### Requirement: Column placement
The executor SHALL show running children's viewers in one column to the right of the main session's pane, stacked vertically: the first viewer opens to the right of the main session's pane, and each further viewer opens below the last viewer still in the column. Before each placement the executor SHALL re-read the tab's panes and drop column entries whose pane no longer exists.

#### Scenario: First viewer opens to the right
- **WHEN** the column is empty and a child's viewer is placed
- **THEN** its pane opens to the right of the main session's pane

#### Scenario: Further viewers stack below
- **WHEN** one viewer is in the column and a second child's viewer is placed
- **THEN** its pane opens below the first viewer's pane

#### Scenario: Closed pane frees its slot
- **WHEN** the user closed a viewer's pane by hand and another viewer is placed
- **THEN** the closed pane is not counted and is not used as the anchor

### Requirement: Placement keeps focus and order
Placement commands for different children MUST run one at a time, in the order their viewers were started. After each placement, keyboard focus MUST return to the pane that had it before the placement.

#### Scenario: Focus returns
- **WHEN** the main session's pane has focus and a viewer is placed
- **THEN** the main session's pane has focus again after the placement

#### Scenario: Focus elsewhere is kept
- **WHEN** another pane of the tab has focus and a viewer is placed
- **THEN** that pane has focus again after the placement

#### Scenario: Concurrent launches
- **WHEN** three children start at the same moment
- **THEN** their viewers are placed one after another, each below the previous

### Requirement: Column overflow
At most 4 viewers SHALL be in the column at once. A further running child's viewer SHALL stay without a pane, listed under the main session in Herdr's agent sidebar; such a viewer is waiting. When a column slot frees up, the executor SHALL place the waiting viewer that started waiting first.

#### Scenario: Fifth child waits
- **WHEN** 4 viewers are in the column and a fifth child starts
- **THEN** the fifth viewer is started but gets no pane

#### Scenario: Waiting viewer moves in
- **WHEN** a fifth viewer is waiting and one of the 4 children in the column finishes
- **THEN** the fifth viewer is placed in the column

#### Scenario: Waiting order
- **WHEN** a fifth and then a sixth viewer are waiting and one slot frees up
- **THEN** the fifth viewer is placed and the sixth keeps waiting

### Requirement: Finished child leaves the column
When a child's run finishes, the executor SHALL tell its viewer, which SHALL print one line naming the final status. The executor SHALL then remove the viewer's pane with `terminal.park`, so the viewer keeps running under the main session in Herdr's agent sidebar and the remaining viewers re-flow. A waiting viewer whose child finishes MUST stop waiting and stay without a pane. A failure of `terminal.park`, including on a viewer the user already closed, MUST be ignored.

#### Scenario: Completed child hides
- **WHEN** a child in the column completes
- **THEN** its viewer prints that it is done with status `completed`, its pane is removed, and the viewer is still running

#### Scenario: Failed child hides
- **WHEN** a child in the column ends with an error
- **THEN** its viewer prints that it is done with status `error` and its pane is removed

#### Scenario: Stopped child hides
- **WHEN** a child in the column is stopped
- **THEN** its viewer prints that it is done with status `stopped` and its pane is removed

#### Scenario: Waiting child finishes
- **WHEN** a waiting viewer's child finishes
- **THEN** the viewer prints that it is done and is never placed

#### Scenario: Viewer already closed
- **WHEN** the user ended a child's viewer terminal and the child then finishes
- **THEN** the failed hide is ignored and the run's result is delivered as usual

### Requirement: Resumed child returns to the column
When a finished child with a live viewer is resumed, its viewer SHALL print one line saying it runs again, and the executor SHALL place it again under the column and overflow rules.

#### Scenario: Resumed child returns
- **WHEN** a hidden child's viewer exists and the child is resumed while the column has a free slot
- **THEN** the viewer prints that it runs again and is placed in the column

#### Scenario: Resumed child waits when the column is full
- **WHEN** a hidden child's viewer exists, 4 viewers are in the column and the child is resumed
- **THEN** the viewer prints that it runs again and waits without a pane

### Requirement: Sessions command inside Herdr
While the column is active, picking an agent in `/subagents:sessions` SHALL show it in Herdr instead of the in-TUI pane: a running agent whose viewer is in the column SHALL have that pane focused; any other agent with an `outputFile` SHALL have its viewer shown as a popup over the main session (`terminal.peek`), with a viewer started first when it has none.

#### Scenario: Running agent focused
- **WHEN** the column is active and the operator picks a running agent whose viewer is in the column
- **THEN** that viewer's pane gets focus and no in-TUI pane opens

#### Scenario: Finished agent in a popup
- **WHEN** the column is active and the operator picks a finished agent whose viewer is hidden
- **THEN** its viewer is shown as a popup over the main session

#### Scenario: Waiting agent in a popup
- **WHEN** the column is active and the operator picks a running agent whose viewer is waiting
- **THEN** its viewer is shown as a popup over the main session

#### Scenario: Agent from before a reload
- **WHEN** the column is active and the operator picks an agent recorded before a `/reload`, which has an `outputFile` and no live viewer
- **THEN** a viewer is started for its file and shown as a popup

### Requirement: Sessions command falls back
The executor SHALL retry the popup up to 5 times 200 ms apart. When Herdr cannot show the picked agent, the agent has no `outputFile`, or its `outputFile` does not exist, `/subagents:sessions` SHALL open the in-TUI pane as it does outside Herdr.

#### Scenario: Herdr fails
- **WHEN** the column is active and the popup command fails on every retry
- **THEN** the in-TUI session pane opens for that agent

#### Scenario: Agent without a file
- **WHEN** the column is active and the operator picks a running agent that has no `outputFile` yet
- **THEN** the in-TUI session pane opens on its live transcript

### Requirement: Viewer cleanup
At `session_shutdown` (which Pi also runs before `/reload` and a session switch), the executor SHALL end every viewer its session started, turning core keep off first so no shell replaces it, and remove its terminal; after that it MUST NOT place, hide or start any viewer for that session. A viewer whose main Pi process has exited SHALL turn its own core keep off and exit within 2 seconds.

#### Scenario: Session shutdown
- **WHEN** the main session shuts down with two viewers, one in the column and one hidden
- **THEN** both viewer terminals are ended and removed

#### Scenario: Reload
- **WHEN** the main session reloads while viewers exist
- **THEN** those viewer terminals are ended and removed, and afterwards their agents are reachable through `/subagents:sessions`

#### Scenario: Late lifecycle hooks after shutdown
- **WHEN** shutdown stops a running child and its run-finished hook arrives after the viewers were ended
- **THEN** no Herdr command is issued for it

#### Scenario: Pi process gone
- **WHEN** the Pi process that started a viewer exits without running shutdown
- **THEN** the viewer exits within 2 seconds and its pane does not turn into a shell

### Requirement: Failure isolation
Herdr work MUST NOT change any child's execution, result, events or timing: lifecycle hooks SHALL only queue Herdr work and return, every `hc` and `herdr-app` command SHALL have a timeout of at most 2 seconds, and every failed command SHALL be logged at debug level and otherwise ignored. A failure for one viewer MUST NOT prevent viewers for other children.

#### Scenario: Placement fails
- **WHEN** `terminal.keep` fails for a viewer
- **THEN** the child runs and completes as without Herdr, and the viewer stays without a pane

#### Scenario: Herdr command hangs
- **WHEN** a placement command does not answer
- **THEN** the child's run and result are not delayed by it, and the command is abandoned after its timeout

#### Scenario: hc fails mid-session
- **WHEN** the column is active and `hc run` fails for one child
- **THEN** that child gets no viewer, its run is unaffected, and the next child still gets one
