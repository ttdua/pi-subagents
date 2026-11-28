## Why

`ask_parent` takes only `{ question: string }`, so a parent receives free text in `pendingQuestion`. An orchestrator such as pi-livespec (ttdua/pi-livespec#67) must know what a question is about: a fact it may answer itself, a scope decision only the human may make, or something else. Guessing that from text is unreliable. The child knows best what it asks, so the label belongs in the tool call, checked against a schema the launcher owns, as `resultSchema` already does for final answers (ttdua/pi-subagents#23).

## What Changes

- `SpawnOptions.questionSchema?`: a JSON Schema in the same draft 2020-12 subset as `resultSchema`, whose root MUST be `type: "object"` and MUST NOT name `question` in `properties` or `required`. It is copied and frozen at spawn and refused with `questionSchema <pointer>: <message>` errors before any record, session or policy call. A launch whose context resolves to `fork` is refused with a schema, like `resultSchema`.
- With a schema, the child's `ask_parent` parameters become `{ question: string, ...schema properties }`. A call that breaks the schema returns a tool error naming each failing path, records no question, emits no `subagents:asked`, and leaves the run going.
- `SubagentRecord.structuredQuestion?: unknown`: the validated fields without `question` (`{}` when the call carried none), deep-frozen, set and cleared with `pendingQuestion` per run. It appears on the record snapshot, the waited snapshot, `subagents:completed`/`failed`/`resumed` and `subagents:asked` when set, and is never persisted in `subagents:record`.
- A launch without `questionSchema` is unchanged: same `ask_parent` tool, text, counts and events.
- The `subagent` tool and agent frontmatter do not accept a question schema.
- Reference example in specs, tests and docs: `topic: { enum: ["fact", "scope", "other"] }`, where `other` is the launcher's catch-all for any other kind of question.

**Snapshot of the waited run** (`service-launch-wait`)
- From: the per-run fields are `status`, `result`, `error`, `startedAt`, `completedAt`, `turnBudget` and `pendingQuestion`.
- To: `structuredQuestion` is a per-run field too.
- Reason: the fields describe the question the waited run ended with, so they belong to that run.
- Impact: non-breaking, optional field.

**Question event** (`service-launch-wait`)
- From: `subagents:asked` carries `id`, `type`, `description`, `question`, `toolCallId` and `metadata`.
- To: it also carries `structuredQuestion` when the launch has a schema. The trigger reads "records a question" instead of "calls", so a call refused by the schema emits nothing.
- Reason: an orchestrator can classify the question when it is asked, and an unrecorded question must not be announced.
- Impact: non-breaking, optional field.

## Capabilities

### New Capabilities
- `structured-question`: the `questionSchema` launch option, its refusals, the schema-shaped `ask_parent` parameters and their validation in the child, and the per-run `structuredQuestion` on records and record events.

### Modified Capabilities
- `service-launch-wait`: "Snapshot of the waited run" adds `structuredQuestion` to the per-run fields; "Question event" carries `structuredQuestion` when set.

## Impact

- Code: `src/service/service.ts` (`SpawnOptions.questionSchema`, `QuestionSchema`, `SubagentRecord.structuredQuestion`), `src/service/service-adapter.ts` (parse, fork refusal, snapshots), `src/seams/result-schema.ts` (shared parser with a label, question-schema rules, validator root path), `src/session/ask-parent-tool.ts` (schema parameters, validation), `src/lifecycle/subagent-run.ts`, `src/lifecycle/subagent.ts`, `src/lifecycle/subagent-manager.ts`, `src/lifecycle/create-subagent-session.ts`, `src/observation/notification.ts`, `src/observation/subagent-events-observer.ts` and the composite observer, `dist/public.d.ts` (regenerated).
- Tests: `test/seams/result-schema.test.ts`, `test/session/ask-parent-tool.test.ts`, `test/lifecycle/subagent-run.test.ts`, `test/observation/notification.test.ts`, `test/observation/subagent-events-observer.test.ts`, `test/service/service-adapter.test.ts`, `test/service/service-wait.test.ts`, `test/persisted-record.test.ts`, a new `test/seams/structured-question-flow.test.ts`.
- Docs: `README.md` (a "Structured questions" section beside "Structured results", the event table row for `subagents:asked`, the waited-run field list), `CHANGELOG.md` (an `Added` entry), `docs/configuration.md` (`ask_parent` note: service launches may shape its parameters).
- `UPSTREAM.md`: rows for every changed upstream file listed above (edit rows extended, new test file added).
- No new dependency, no persisted format change, no `subagent` tool or frontmatter change.
