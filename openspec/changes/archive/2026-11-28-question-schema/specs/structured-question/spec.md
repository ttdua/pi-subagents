## ADDED Requirements

### Requirement: Question schema on service launches
`SpawnOptions` SHALL accept an optional `questionSchema`, a JSON Schema in the subset, annotations and copy rules that `structured-result` defines for `resultSchema` ("Result schema on service launches", "Result schema annotations", "Result schema is copied at spawn"). Its root MUST declare `type` `object`, and its root `properties` MUST NOT declare `question`. The `subagent` tool and agent frontmatter MUST NOT accept a question schema.

#### Scenario: Schema accepted
- **WHEN** an extension calls `spawn("explore", brief, { questionSchema: { type: "object", properties: { topic: { enum: ["fact", "scope", "other"] } }, required: ["topic"], additionalProperties: false } })`
- **THEN** `spawn` returns an agent id and the launch runs with that schema

#### Scenario: Caller mutates the schema after spawn
- **WHEN** the caller removes `"other"` from the `enum` of its schema object after `spawn` returned
- **THEN** `ask_parent` with `{ "question": "Q", "topic": "other" }` is still accepted

#### Scenario: Not on the subagent tool
- **WHEN** the `subagent` tool's parameters and the agent frontmatter fields are read
- **THEN** neither has a question schema field

### Requirement: Refused question schemas
`spawn` MUST throw, before any record, session or launch-policy call, in every case "Refused result schemas" lists, and when the root `type` is not `object` or the root `properties` or `required` names `question`. Errors SHALL read `questionSchema <pointer>: <message>`; the `fork` refusal SHALL name `questionSchema` and `fork`. `resultSchema` error texts MUST NOT change.

#### Scenario: Non-object root
- **WHEN** an extension passes `questionSchema` `{ type: "string" }`
- **THEN** `spawn` throws an error starting `questionSchema /type:` and `listAgents()` is unchanged

#### Scenario: Declares question
- **WHEN** an extension passes `questionSchema` `{ type: "object", properties: { question: { type: "string" } } }`
- **THEN** `spawn` throws an error starting `questionSchema /properties/question:`

#### Scenario: Requires question
- **WHEN** an extension passes `questionSchema` `{ type: "object", required: ["question"] }`
- **THEN** `spawn` throws an error starting `questionSchema /required:`

#### Scenario: Unsupported keyword
- **WHEN** an extension passes `questionSchema` `{ type: "object", properties: { n: { type: "number", minimum: 0 } } }`
- **THEN** `spawn` throws an error naming `questionSchema`, `minimum` and `/properties/n/minimum`

#### Scenario: Fork with a schema
- **WHEN** an extension calls `spawn("explore", brief, { context: "fork", questionSchema: { type: "object" } })`
- **THEN** `spawn` throws an error naming `questionSchema` and `fork`, and no child starts

#### Scenario: Refusal before the policy
- **WHEN** `spawn` throws for a bad question schema while a launch policy is registered
- **THEN** the policy is not called

### Requirement: Schema-shaped ask_parent
A launch with a `questionSchema` SHALL give the child an `ask_parent` tool whose parameters are an object with the required string property `question` plus the schema's root `properties`. The schema's `required` entries SHALL be required next to `question`, and its root `additionalProperties` SHALL apply to the other properties. A launch without a `questionSchema` MUST keep today's `ask_parent` (name, description, parameters and result text), its tool count and its events.

#### Scenario: Parameters with a schema
- **WHEN** a launch has the reference schema `{ type: "object", properties: { topic: { enum: ["fact", "scope", "other"] } }, required: ["topic"], additionalProperties: false }`
- **THEN** the child's `ask_parent` parameters list `question` and `topic`, and require both

#### Scenario: No schema
- **WHEN** a launch passes no `questionSchema`
- **THEN** the child's `ask_parent` parameters are exactly `{ question: string }`, and its record and events carry no `structuredQuestion`

### Requirement: Question fields are validated in the child
`ask_parent` on a launch with a schema SHALL validate the call's arguments other than `question` against the schema with the executor's own validator, after Pi's argument validation. An invalid call SHALL return an error result listing each violation with its property path, record nothing, emit no `subagents:asked`, and leave the run going. A valid call SHALL record the text and a deep-frozen copy of the fields, and return today's result text.

#### Scenario: Valid call recorded
- **WHEN** the child calls `ask_parent` with `{ "question": "Q", "topic": "scope" }`
- **THEN** the run's pending question is `Q` and its structured question is `{ "topic": "scope" }`

#### Scenario: Catch-all accepted
- **WHEN** the child calls `ask_parent` with `{ "question": "Q", "topic": "other" }`
- **THEN** the run's structured question is `{ "topic": "other" }`

#### Scenario: Invalid value refused
- **WHEN** the child calls `ask_parent` with `{ "question": "Q", "topic": "unknown" }`
- **THEN** the tool result is an error naming `topic`, no question is recorded, `subagents:asked` is not emitted, and the run continues

#### Scenario: Missing required field
- **WHEN** the child calls `ask_parent` with `{ "question": "Q" }`
- **THEN** the tool result is an error naming `topic`, and no question is recorded

#### Scenario: Schema without properties
- **WHEN** the schema is `{ type: "object" }` and the child calls `ask_parent` with `{ "question": "Q" }`
- **THEN** the run's structured question is `{}`

#### Scenario: Child fixes the call
- **WHEN** after an invalid call the child calls `ask_parent` with `{ "question": "Q", "topic": "fact" }`
- **THEN** the run's pending question is `Q` and its structured question is `{ "topic": "fact" }`

### Requirement: Structured question per run
`structuredQuestion` SHALL follow `pendingQuestion`. On a launch with a schema it is set, also as `{}`, by every valid `ask_parent` call on the run under way, replaced by a later valid call in the same run, dropped with the question when the run fails, cleared on the record when a resume replaces the run, and never present without `pendingQuestion`. It SHALL hold the validated fields without `question`.

#### Scenario: Later ask replaces
- **WHEN** a run calls `ask_parent` validly with `topic` `fact`, then validly with `topic` `scope`, and ends its turn
- **THEN** the record has the second call's `pendingQuestion` and `structuredQuestion` `{ "topic": "scope" }`

#### Scenario: Failure drops it
- **WHEN** the child calls `ask_parent` validly and its run then fails
- **THEN** the record has neither `pendingQuestion` nor `structuredQuestion`

#### Scenario: Resume clears it
- **WHEN** a record with `structuredQuestion` is resumed
- **THEN** while the resumed run is running the record has neither `pendingQuestion` nor `structuredQuestion`

#### Scenario: Resumed run asks again
- **WHEN** the resumed run calls `ask_parent` with `{ "question": "Q2", "topic": "fact" }` and ends its turn
- **THEN** the record has `pendingQuestion` `Q2` and `structuredQuestion` `{ "topic": "fact" }`

#### Scenario: Turn limit keeps it
- **WHEN** the child asks validly with `topic` `scope` and its run is ended at its turn limit
- **THEN** the record's status is `aborted` and it keeps `pendingQuestion` and `structuredQuestion`

### Requirement: Structured question on records and events
The `SubagentRecord` snapshot and the payloads of `subagents:completed`, `subagents:failed` and `subagents:resumed` SHALL carry `structuredQuestion` when set, and MUST omit it when not set. The persisted `subagents:record` session entry MUST NOT store it. Main-session notifications and `get_subagent_result` text MUST NOT change.

#### Scenario: Completed event
- **WHEN** a child asks validly with `topic` `scope` and its run completes
- **THEN** `subagents:completed` carries `structuredQuestion` `{ "topic": "scope" }` and `getRecord(id).structuredQuestion` deep-equals it

#### Scenario: Not persisted
- **WHEN** a run with a structured question settles
- **THEN** the appended `subagents:record` entry has no `structuredQuestion`
