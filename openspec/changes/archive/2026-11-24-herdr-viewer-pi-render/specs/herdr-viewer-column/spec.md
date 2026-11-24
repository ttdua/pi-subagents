## ADDED Requirements

### Requirement: Viewer renders like the sessions pane
A viewer SHALL show the same header rule and transcript rows the `/subagents:sessions` pane shows for the same agent and source state, with the transcript rendered by Pi's components. Its footer rule SHALL carry the run status line, the line count, the scroll position and the scroll key hints, and MUST NOT carry a close hint. The frame SHALL fill the viewer's terminal and re-flow when the terminal is resized.

#### Scenario: Markdown is rendered
- **WHEN** the child's assistant message contains a heading, a list and a fenced code block
- **THEN** the viewer shows them as the sessions pane renders them, with no raw markdown markers such as the heading's `#` or the code fence

#### Scenario: Same rows as the pane
- **WHEN** a viewer and the sessions pane render the same source state at the same width, viewport height and scroll position
- **THEN** both produce the same header rule and transcript rows

#### Scenario: Viewer footer
- **WHEN** a viewer renders a running child's transcript
- **THEN** its footer shows the run status, the line count, the scroll position and the scroll key hints, and no close hint

#### Scenario: Resize re-flows
- **WHEN** the viewer's terminal is resized
- **THEN** the next frame is laid out at the new width and height

### Requirement: Viewer is a display sink
The main Pi process MUST produce every viewer frame. The viewer program SHALL only paint the frames it receives and send its terminal size and key input back; it MUST NOT load Pi's packages or read the transcript itself.

#### Scenario: Viewer runs without Pi packages
- **WHEN** the viewer program is started where Pi's packages cannot be resolved
- **THEN** it starts, paints the frames it receives and sends its size

### Requirement: Viewer transcript source
The main Pi process MUST render a viewer's frame from the live session while the agent's session is ready, including the in-flight assistant message, the activity row and the session's tool definitions. Otherwise it SHALL render from the agent's session file, following the file as it changes (a file-backed viewer). A viewer SHALL switch to the live session when a run of its agent starts with a ready session.

#### Scenario: Streaming is shown
- **WHEN** the viewer follows the bottom of a live source and the child is generating an assistant message
- **THEN** the viewer shows the partial message and the activity row, updated within one second of each change

#### Scenario: Tool uses its renderer
- **WHEN** a live child calls a tool that has its own renderer, including one registered by another extension
- **THEN** the viewer shows that tool's call and result through that renderer, as the sessions pane does

#### Scenario: Live source does not need the file
- **WHEN** a viewer is shown for an agent whose session is ready and has messages while its session file does not exist yet
- **THEN** the viewer shows those messages

#### Scenario: Released session
- **WHEN** a viewer is shown for an agent whose live session was released or that was recorded before a `/reload`
- **THEN** the viewer shows the transcript read from the agent's session file, without streaming

#### Scenario: Extension tool after release
- **WHEN** a file-backed viewer shows a call of a tool whose definition is not available
- **THEN** the call is rendered with the same fallback the sessions pane uses for that file

#### Scenario: Resume switches to live
- **WHEN** an agent whose viewer renders from its file is resumed and its session becomes ready
- **THEN** the viewer renders from the live session, including streaming

### Requirement: Viewer scrolling
A viewer SHALL follow new output at the bottom of the transcript. The sessions pane's scroll keys (up and down arrows, `j` and `k`, Pi's page up and down bindings, Pi's top and bottom bindings, as the operator configured them) and the mouse wheel SHALL scroll the viewer's transcript. Scrolling away from the bottom MUST stop following: new content is added below but the visible rows stay. Returning to the bottom MUST resume following. The keys that close the sessions pane MUST NOT close a viewer.

#### Scenario: Follows by default
- **WHEN** the viewer is at the bottom and the child appends a message
- **THEN** the new message is visible at the bottom of the frame

#### Scenario: Scrolling up stops following
- **WHEN** the user scrolls the viewer up and the child appends a message
- **THEN** the frame keeps showing the same transcript rows

#### Scenario: Back to the bottom resumes following
- **WHEN** the user scrolls back to the bottom and the child appends a message
- **THEN** the new message is visible at the bottom of the frame

#### Scenario: Mouse wheel scrolls
- **WHEN** the user turns the mouse wheel up over a viewer whose transcript is longer than the frame
- **THEN** the frame shows earlier transcript rows

#### Scenario: Remapped binding scrolls
- **WHEN** the operator bound Pi's page up action to another key and presses it in a viewer
- **THEN** the viewer scrolls up one page

#### Scenario: Close keys are ignored
- **WHEN** the user presses Esc or `q` in a viewer
- **THEN** the viewer keeps running and showing the transcript

### Requirement: Viewer channel
The main Pi process SHALL send frames to its viewers, and receive their size and keys, over a local channel that only the user running Pi can open. A viewer whose channel closes or fails SHALL restore its terminal's screen, cursor, input and mouse modes, turn its own core keep off and exit. A session with no viewer MUST NOT open a channel.

#### Scenario: Channel closes
- **WHEN** the main session closes a viewer's channel
- **THEN** the viewer leaves the alternate screen, shows the cursor, turns mouse reporting and raw input off, and exits, and its pane does not turn into a shell

#### Scenario: Private channel
- **WHEN** the channel is created
- **THEN** it lives in a directory only the user running Pi can access

#### Scenario: No child, no channel
- **WHEN** the column is active and no child has started
- **THEN** no channel is open

### Requirement: Viewer output is sanitized
The viewer MUST sanitize frame content before it reaches the terminal: only text styling and hyperlinks MAY pass; every other control character and escape sequence MUST be dropped.

#### Scenario: Escape sequences are dropped
- **WHEN** a transcript contains text with cursor-movement, screen-clear, window-title or device-control sequences
- **THEN** none of them reaches the viewer's terminal, and styling still shows

## MODIFIED Requirements

### Requirement: Viewer is read-only
A viewer SHALL show the child's transcript as the requirements "Viewer renders like the sessions pane" and "Viewer transcript source" specify, following new entries as the session produces them, under a header naming the agent and its task. It MUST NOT forward any input to the child or to a shell: keys the requirement "Viewer scrolling" names act only on the viewer's own scroll position, and every other key typed in a viewer is discarded. A file-backed viewer whose file is missing or unreadable SHALL show an empty transcript until the file can be read, and lines it cannot parse MUST be skipped without stopping the viewer.

#### Scenario: Follows appended entries
- **WHEN** the viewer follows the bottom and the child's session appends an assistant message
- **THEN** the viewer shows that message within one second

#### Scenario: Input is discarded
- **WHEN** the user types text that holds no scroll key into a viewer of a finished child and presses Enter
- **THEN** nothing is sent to the child or a shell, the frame does not change and the viewer keeps running

#### Scenario: File appears later
- **WHEN** a file-backed viewer starts before the session file exists
- **THEN** it shows an empty transcript, and the entries within one second after the file is written

#### Scenario: Unparsable line
- **WHEN** the session file read for a file-backed viewer contains a line that is not valid JSON
- **THEN** the viewer skips that line and shows the following entries

### Requirement: Finished child leaves the column
When a child's run finishes, its viewer's status line SHALL show `done (<status>)` with the final status within one second. The executor SHALL then remove the viewer's pane with `terminal.park`, so the viewer keeps running under the main session in Herdr's agent sidebar and the remaining viewers re-flow. A waiting viewer whose child finishes MUST stop waiting and stay without a pane. A failure of `terminal.park`, including on a viewer the user already closed, MUST be ignored.

#### Scenario: Completed child hides
- **WHEN** a child in the column completes
- **THEN** its viewer shows `done (completed)`, its pane is removed, and the viewer is still running

#### Scenario: Failed child hides
- **WHEN** a child in the column ends with an error
- **THEN** its viewer shows `done (error)` and its pane is removed

#### Scenario: Stopped child hides
- **WHEN** a child in the column is stopped
- **THEN** its viewer shows `done (stopped)` and its pane is removed

#### Scenario: Waiting child finishes
- **WHEN** a waiting viewer's child finishes
- **THEN** the viewer shows that it is done and is never placed

#### Scenario: Viewer already closed
- **WHEN** the user ended a child's viewer terminal and the child then finishes
- **THEN** the failed hide is ignored and the run's result is delivered as usual

### Requirement: Resumed child returns to the column
When a finished child with a live viewer is resumed, its viewer's status line SHALL show `running again` and its transcript SHALL follow the new run, and the executor SHALL place it again under the column and overflow rules.

#### Scenario: Resumed child returns
- **WHEN** a hidden child's viewer exists and the child is resumed while the column has a free slot
- **THEN** the viewer shows `running again` and is placed in the column

#### Scenario: Resumed child waits when the column is full
- **WHEN** a hidden child's viewer exists, 4 viewers are in the column and the child is resumed
- **THEN** the viewer shows `running again` and waits without a pane

### Requirement: Failure isolation
Herdr work MUST NOT change any child's execution, result, events or timing: lifecycle hooks SHALL only queue Herdr work and return, every `hc` and `herdr-app` command SHALL have a timeout of at most 2 seconds, and every failed command SHALL be logged at debug level and otherwise ignored. Rendering viewer frames MUST NOT run inside a lifecycle hook or a session event callback. A frame that fails to render SHALL be logged and skipped, keeping the viewer's previous frame; a frame that fails to send SHALL be logged and that viewer's channel closed, so the viewer exits as the requirement "Viewer channel" specifies. A failure for one viewer MUST NOT prevent viewers for other children.

#### Scenario: Placement fails
- **WHEN** `terminal.keep` fails for a viewer
- **THEN** the child runs and completes as without Herdr, and the viewer stays without a pane

#### Scenario: Herdr command hangs
- **WHEN** a placement command does not answer
- **THEN** the child's run and result are not delayed by it, and the command is abandoned after its timeout

#### Scenario: hc fails mid-session
- **WHEN** the column is active and `hc run` fails for one child
- **THEN** that child gets no viewer, its run is unaffected, and the next child still gets one

#### Scenario: Render fails
- **WHEN** rendering a viewer's frame throws
- **THEN** the child's run is unaffected, the viewer keeps its previous frame and other viewers keep updating

#### Scenario: Send fails
- **WHEN** sending a frame to one viewer fails
- **THEN** the child's run is unaffected, that viewer's channel is closed and the viewer exits, and other viewers keep updating
