## MODIFIED Requirements

### Requirement: Snapshot of the waited run
The per-run fields of the snapshot `wait()` resolves with (`status`, `result`, `error`, `startedAt`, `completedAt`, `turnBudget`, `pendingQuestion` and `structuredQuestion`) SHALL describe the run the wait began on, even when a resume has replaced that run before the promise resolves. Every other field, including `resumeRefusal`, SHALL describe the record when the promise resolves.

#### Scenario: Resumed before the waiter reads it
- **WHEN** an observer resumes the agent from its `subagents:completed` listener while a `wait(id)` for the initial run is pending, and that run ended with question `Q`
- **THEN** the promise resolves with `status` `completed`, the initial run's result, `startedAt` and `completedAt`, `pendingQuestion` `Q`, and `resumeRefusal` `still-running`

#### Scenario: Structured question of the waited run
- **WHEN** a `wait(id)` is pending on a launch with a `questionSchema`, the child calls `ask_parent` with `{ "question": "Q", "topic": "scope" }` and ends its turn, and an observer resumes the agent before the promise resolves
- **THEN** the promise resolves with `pendingQuestion` `Q` and `structuredQuestion` `{ "topic": "scope" }`

### Requirement: Question event
When a child records a question with `ask_parent`, the executor SHALL emit `subagents:asked` with `id`, `type`, `description` and `question` (the question text, as recorded), plus `toolCallId` and `metadata` under the same rules as the other record events, and `structuredQuestion` when the launch has a `questionSchema`. The event SHALL be emitted for every launch that has `ask_parent`, whether or not a caller waits, and MUST NOT be emitted for a call that records nothing. It MUST NOT be persisted and MUST NOT send the main session a message.

#### Scenario: Service launch with metadata asks
- **WHEN** a service launch with metadata `{ change: "c1" }` calls `ask_parent` with `Which config?`
- **THEN** `subagents:asked` is emitted with the record's `id`, `question` `Which config?` and `metadata` `{ change: "c1" }`, before the run's `subagents:completed`

#### Scenario: Tool-call launch asks
- **WHEN** a child launched by `subagent` call `call_5` calls `ask_parent`
- **THEN** `subagents:asked` carries `toolCallId` `call_5`, and the main session's routing of the question is unchanged

#### Scenario: Structured question on the event
- **WHEN** a launch with the reference `questionSchema` calls `ask_parent` with `{ "question": "Q", "topic": "fact" }`
- **THEN** `subagents:asked` carries `question` `Q` and `structuredQuestion` `{ "topic": "fact" }`

#### Scenario: No schema, no field
- **WHEN** a launch without a `questionSchema` calls `ask_parent`
- **THEN** `subagents:asked` has no `structuredQuestion` key

## ADDED Requirements

### Requirement: Structured question reaches the waiting caller
When a waited child on a launch with a `questionSchema` calls `ask_parent` validly and its run then completes normally, the pending `wait()` SHALL resolve with `status` `completed`, the question in `pendingQuestion` and the validated fields in `structuredQuestion`.

#### Scenario: Ask with a topic
- **WHEN** an extension spawns with the reference `questionSchema`, calls `wait(id)`, and the child calls `ask_parent` with `{ "question": "Q", "topic": "scope" }` and ends its turn
- **THEN** the wait resolves with `status` `completed`, `pendingQuestion` `Q` and `structuredQuestion` `{ "topic": "scope" }`

#### Scenario: Failure after a structured question
- **WHEN** a waited child with the reference schema calls `ask_parent` validly and its run then fails
- **THEN** the wait resolves with `status` `error` and neither `pendingQuestion` nor `structuredQuestion`
