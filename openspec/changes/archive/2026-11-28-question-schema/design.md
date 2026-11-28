## Context

`resultSchema` already provides most of the pieces: `src/seams/result-schema.ts` parses the subset into a frozen copy (`parseResultSchema`, errors `resultSchema <pointer>: …`) and validates with `validateResult` (paths rooted at `result`). `SubmitResultTool` builds raw JSON Schema parameters from it. `SubagentsServiceAdapter.spawn` parses before the session check and refuses `fork`, `Subagent.startRun` wires per-run sinks, and `SubagentRun` keeps per-run outcome fields that `toWaitedRecord`, `toSubagentRecord` and `buildEventData` copy out. `ask_parent` today is `AskParentTool` with a `QuestionRecorder = (question: string) => void`. `Subagent.startRun` passes a closure that calls `currentRun.setPendingQuestion` and `observer.onQuestionAsked`, which ends at `SubagentEventsObserver.onSubagentQuestion` → `subagents:asked`. `Subagent.fail` drops the question with `setPendingQuestion(undefined)`.

## Goals / Non-Goals

**Goals:**
- One schema parser and validator for both schemas, with the existing `resultSchema` error texts and violation paths unchanged.
- The question and its fields travel as one value through recorder, run, observer and snapshots, so they can never disagree.
- No observable change for launches without `questionSchema`.

**Non-Goals:**
- Rendering `structuredQuestion` in main-session notifications or `get_subagent_result` text.
- Persisting it; the `subagents:record` entry is unchanged.
- Pinning `ask_parent` against `disallowed_tools` or policy removal.

## Decisions

1. **Parameterise the parser, do not fork it.** `result-schema.ts` gains a label (`"resultSchema"` | `"questionSchema"`) carried through `refuse`, and `parseQuestionSchema(input)` = `parseSchema(input, "questionSchema")` plus two root checks: `type` must be `object`, and neither `properties` nor `required` may name `question`. Validation gains a root-path argument: `validateResult(schema, value)` keeps root `result`, and `validateQuestion(schema, fields)` checks the fields object at the root with paths named by property (`topic`), because the child sees flat parameters. Alternative: a second module copying the subset. Rejected because it would drift.
2. **`QuestionSchema` is a distinct public type alias** of the same subset node shape, narrowed at the root to `type: "object"`. A separate name documents intent in `SpawnOptions`. The parser enforces the root rules at runtime, since callers may pass untyped objects.
3. **Tool parameters.** With a schema, `AskParentTool` builds raw JSON Schema parameters `{ type: "object", properties: { question: <string schema>, ...schema.properties }, required: ["question", ...schema.required], additionalProperties: schema.additionalProperties }` and keeps the schema's `title`/`description` off the parameters root. Without one it keeps today's TypeBox parameters byte for byte. `execute` splits `question` from the rest, validates the rest with `validateQuestion`, and on violations returns `isError: true` with one line per violation, without calling the recorder. Pi's own argument validation may refuse a call earlier; either way nothing is recorded.
4. **One recorder value.** `QuestionRecorder` becomes `(question: AskedQuestion) => void` with `AskedQuestion = { text: string; fields?: unknown }`. `fields` is present exactly when the launch has a schema (`{}` when the call carried only `question`) and holds the validated rest, deep-frozen. `SubagentRun.setPendingQuestion` takes `AskedQuestion | undefined`, stores both, and exposes `pendingQuestion`/`question` (text, unchanged) plus `pendingStructuredQuestion`/`structuredQuestion` with the same `replaced` rule. `fail` clears both through the same call, so the existing "failure drops the question" rule covers the fields. A later valid ask in the same run replaces both, as today. Alternative: a separate setter. Rejected because the text and fields could then disagree.
5. **Observer signature.** `onQuestionAsked(agent, question: AskedQuestion)` and `onSubagentQuestion(record, question: AskedQuestion)` are internal. The events observer spreads `structuredQuestion` only when `fields` is defined.
6. **Snapshots and events.** `toSubagentRecord` sets `structuredQuestion` from `record.structuredQuestion` (current run, cleared once replaced, as `pendingQuestion`). `toWaitedRecord` sets it from `run.structuredQuestion` (the recorded fields, also after `replaced`, as `run.question`). `buildEventData` spreads it when set. `persisted-record.ts` copies an explicit field list that does not include it.
7. **Fork refusal** sits beside the `resultSchema` one in `spawn`, after context resolution and before `buildSnapshot`. Message: `questionSchema cannot be used with context "fork": …`. A fork child has no `ask_parent`, so the schema could never apply.
8. **Public contract.** `SpawnOptions.questionSchema` and `SubagentRecord.structuredQuestion` are optional additions (fork invariant), and `dist/public.d.ts` is regenerated. `implementation` is unchanged. Consumers detect the feature by trying `spawn` with the option on a current service; an older service ignores an unknown option, which is documented.

## Risks / Trade-offs

- [The schema's `additionalProperties: false` also applies to `question`, which the schema cannot list.] → Validation runs on the fields without `question`, and the tool parameters always list `question` explicitly, so `question` is never "additional".
- [Pi validates the raw parameters before `execute`, so its message may differ from ours.] → Both refuse and record nothing. Specs assert only "error result, nothing recorded"; our own text names the failing property path.
- [An older service silently ignores `questionSchema`.] → README tells consumers to check that `structuredQuestion` arrives, or to require a version, as for other optional fields.
- [Pi validates enum and `required` against the parameters before `execute`, so for those calls the error text is Pi's.] → Tests assert the observable outcome (error result naming the property, nothing recorded, no event), not the message source, as `structured-result` already accepts.
- [Last valid ask wins within a run.] → Unchanged from today's `pendingQuestion`, and stated in the spec.

## Migration Plan

Additive. No persisted data changes. Rollback is reverting the commits.

## Open Questions

None.
