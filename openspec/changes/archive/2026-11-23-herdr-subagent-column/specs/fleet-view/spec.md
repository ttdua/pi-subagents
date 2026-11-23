## MODIFIED Requirements

### Requirement: Fleet list opens the session pane
`Enter` on an agent row SHALL open the same read-only session pane `/subagents:sessions` opens for that agent outside Herdr, mounted the same way in the current TUI mode: the live transcript when its session is ready, otherwise the transcript read from its `outputFile`. It MUST NOT open any other viewer, including a Herdr viewer, in any environment. When reading the file fails, the executor SHALL notify `Could not read the session transcript file.` as an error. Outside an active Herdr column (see `herdr-viewer-column`), `/subagents:sessions` MUST keep its behavior from before the Herdr column; inside one, the command SHALL show the picked agent in Herdr as `herdr-viewer-column` specifies and fall back to this pane when Herdr cannot show it.

#### Scenario: Enter opens the live pane
- **WHEN** the list is active, a running agent is selected and the operator presses `Enter`
- **THEN** the session pane opens on that agent's live transcript

#### Scenario: Released session opens from file
- **WHEN** the selected agent has finished, its session was released, and its `outputFile` is set
- **THEN** the session pane opens on the transcript read from that file

#### Scenario: Unreadable file
- **WHEN** the selected agent's `outputFile` cannot be read
- **THEN** an error notification reads `Could not read the session transcript file.` and no pane opens

#### Scenario: Command unchanged
- **WHEN** no Herdr column is active and the operator runs `/subagents:sessions` and picks an agent
- **THEN** the same pane opens as before this change

#### Scenario: Enter unchanged inside Herdr
- **WHEN** a Herdr column is active, the list is active, a running agent is selected and the operator presses `Enter`
- **THEN** the in-TUI session pane opens on that agent's live transcript and no Herdr command is issued
