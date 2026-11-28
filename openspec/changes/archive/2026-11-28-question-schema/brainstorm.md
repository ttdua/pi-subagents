## Design Summary

A service launch can declare a `questionSchema`. The child's `ask_parent` call then carries structured fields next to its question text, checked in the child against that schema, and the parent reads the fields from the record as `structuredQuestion`, next to the unchanged `pendingQuestion` text. It mirrors `resultSchema` / `structuredResult` (living spec `structured-result`) and is driven by ttdua/pi-subagents#23 for pi-livespec (ttdua/pi-livespec#67). That orchestrator needs to know what a question is about (a fact it may answer, a scope decision only the human may make) without guessing from free text.

- **Intent**: the child labels its own question. The launcher owns the vocabulary through the schema.
- **Goals**: a structured, validated question payload on service launches; per-run semantics identical to `pendingQuestion`; no change for launches without a schema.
- **Non-goals**: the `subagent` tool or agent frontmatter declaring a question schema; rendering the fields into the main session's messages; persisting them in `subagents:record`; new schema keywords.
- **Anti-goals**: any behaviour change for existing `ask_parent` callers (tool shape, text, counts, events); a second schema dialect that drifts from the `resultSchema` subset.

Existing requirements involved:
- `structured-result`: "Result schema on service launches" (the subset), "Result schema annotations", "Result schema is copied at spawn", "Refused result schemas" (including the fork refusal). `questionSchema` adopts the same subset and rules; the `structured-result` requirements themselves are not changed.
- `service-launch-wait`: "Snapshot of the waited run" lists the per-run fields; this change **alters that requirement** by adding `structuredQuestion` to the list. "Question event" (`subagents:asked`) is **extended** with an optional `structuredQuestion`. "Questions reach the waiting caller" is unchanged in its rules; the new field follows `pendingQuestion`.

## Alternatives Considered

### Alternative A: Nested fields parameter
- **Approach**: `ask_parent({ question, fields: {...} })` where `fields` has the launch's schema, like `submit_result({ result })`.
- **Pros**: reuses the validator unchanged (path root `fields`); no clash between `question` and schema properties.
- **Cons**: an extra nesting level for the model; differs from the issue's agreed call shape `ask_parent({ question: "Q", topic: "scope" })`.
- **Why not chosen**: the issue fixes the flat shape, and a flat call is the simpler one for a model to produce.

### Alternative B: Separate tool
- **Approach**: keep `ask_parent` as is and add `ask_parent_structured` for schema launches.
- **Pros**: zero risk to the existing tool.
- **Cons**: two tools with overlapping purpose; the child can bypass the schema by calling the plain one; tool counts change.
- **Why not chosen**: bypassing the schema defeats the purpose.

## Agreed Approach

Flat parameters, as the issue proposes: with a schema, `ask_parent` parameters are `{ question: string, ...schema properties }`, where `question` is required and added by the executor, and the schema's `required` and `additionalProperties` apply to the rest. The schema is parsed with the same subset, copy and refusal rules as `resultSchema`, with errors prefixed `questionSchema <pointer>: <message>`. Without a schema `ask_parent` is byte-for-byte unchanged.

## Key Decisions

- New capability `structured-question` holds the schema, tool and record rules; `service-launch-wait` gets the snapshot and event deltas. (Agent call, issue left either open.)
- Schema root MUST be `type: "object"` and MUST NOT declare a `question` property; both refused at spawn. (From the issue.)
- An invalid `ask_parent` call returns a tool error naming each failing path, records nothing, emits no `subagents:asked`, and leaves the run going. (From the issue.)
- The reference schema in specs, tests and docs is `topic: { enum: ["fact", "scope", "other"] }`: `other` is the catch-all for a question that is neither a fact nor a scope decision, so a child never has to mislabel one. The executor adds no catch-all of its own; the launcher declares it in its schema. Because `other` is now valid, the invalid-call example uses `topic: "unknown"` instead of the issue's `topic: "other"`. (User note at the brainstorm gate.)
- `structuredQuestion` holds the validated fields without `question`. It is set and cleared together with `pendingQuestion`, with the same per-run rules: cleared on resume, present only when `pendingQuestion` is, last valid ask in a run wins. (Issue + agent call on "last wins", matching today's `setPendingQuestion`.)
- A `questionSchema` with a launch whose context resolves to `fork` is refused, like `resultSchema`, because a fork has no `ask_parent`. (Agent call; otherwise the schema would be silently ignored.)
- `subagents:asked` carries `structuredQuestion` when set, so an orchestrator can classify at ask time. (Agent call; the issue lists "record events".)
- Records, `subagents:completed`/`failed`/`resumed` and waited snapshots carry it when set and omit it otherwise; `subagents:record` does not persist it; main-session notifications and `get_subagent_result` text are unchanged. (Agent call, mirrors `structuredResult`.)
- `ask_parent` stays removable/addable exactly as today; the schema does not pin it the way `submit_result` is pinned. (Agent call: the issue asks for no change there.)

## Open Questions

- None blocking. The builder decides how to share the parser between both schemas (for example a label and root-path parameter), provided the `resultSchema` error texts stay as specified.
