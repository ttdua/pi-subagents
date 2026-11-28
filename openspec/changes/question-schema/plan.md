# Question Schema Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (`structured-question`, `service-launch-wait`) and `design.md`.

**Goal:** A service launch can declare `questionSchema`. The child's `ask_parent` then takes `{ question, ...fields }`, the fields are validated in the child, and the parent reads them as a per-run `structuredQuestion` on records, waited snapshots and record events.

**Architecture:** `src/seams/result-schema.ts` becomes the one parser and validator for both schemas: a label picks the error prefix, and the question variant adds two root rules and property-rooted paths. `AskParentTool` builds schema-shaped parameters, validates the fields and hands an `AskedQuestion { text, fields? }` to the recorder. `SubagentRun` stores the text and fields together, so every existing per-run rule for `pendingQuestion` (replace, fail drop, resume clear, waited run) covers the fields as well. The service adapter, snapshots and `buildEventData` copy the field out the way they copy `structuredResult`.

**Tech Stack:** TypeScript, vitest, biome, Bun scripts.

## Global Constraints

- A launch without `questionSchema` is unchanged: same `ask_parent` definition (name, label, snippet, description, TypeBox parameters), result text, tool count and events.
- `resultSchema` error texts and `validateResult` paths (`result.status`, …) stay exactly as today; existing tests in `test/seams/result-schema.test.ts` pass untouched.
- New service fields are optional; `implementation` stays `"@ttdua/pi-subagents"`.
- `structuredQuestion` is never persisted in `subagents:record`; main-session notification text and `get_subagent_result` text do not change.
- Reference schema in tests and docs: `{ type: "object", properties: { topic: { enum: ["fact", "scope", "other"] } }, required: ["topic"], additionalProperties: false }`; the invalid example is `topic: "unknown"`.
- Tests need no secrets, paid calls or network beyond loopback.
- Public repository: English only. Every changed upstream file has its `UPSTREAM.md` row updated.
- Apply `~/.agents/skills/coding-standards/SKILL.md`.

## Review Focus

- A schema with no `required` and `additionalProperties` unset, called with `{ question: "Q", extra: 1 }`: valid, `structuredQuestion` is `{ extra: 1 }` (JSON Schema default allows extras). Test `keeps undeclared fields when additionalProperties is unset` in Task 1 (validator) and Task 2 (tool).
- `question` passed as a non-string: a non-string `question` reaching `execute` directly is refused and nothing is recorded; through Pi a coercible value arrives as a string (argument coercion runs first) and is recorded as such. Task 2 test `refuses a non-string question without recording` calls `execute` directly with `{ question: 1, topic: "fact" }` and expects `isError` and no recorder call.
- An invalid call after a valid one in the same run: the earlier question and fields stay (invalid records nothing). Task 2 test `an invalid call leaves the earlier question in place`.
- A tool-call launch (no schema) after this change: `subagents:asked` has no `structuredQuestion` key at all, not `undefined`. Task 3 test `emits no structuredQuestion key without a schema` (asserts `not.toHaveProperty`).
- Schema `description` at the root: it must not replace the tool's own `ask_parent` description; property descriptions do pass through. Task 2 test `keeps the tool description when the schema has one`.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `QuestionSchema` | new | `ResultSchema & Readonly<{ type: "object" }>`: the `ResultSchema` subset with the root `type` fixed to `"object"`; exported from `src/service/service.ts` and `dist/public.d.ts` | yes |
| `SpawnOptions.questionSchema` | new | `questionSchema?: QuestionSchema`. Refused with `questionSchema <pointer>: <message>` (subset rules, root `type` not `object` at `/type`, `question` in `/properties/question` or `/required`), and with `context: "fork"` (message names `questionSchema` and `fork`). Copied and frozen at spawn | yes |
| `SubagentRecord.structuredQuestion` | new | `structuredQuestion?: unknown`: the validated fields without `question`, deep-frozen, `{}` when none; set only with `pendingQuestion` on a launch with a schema | yes |
| `subagents:asked` payload | modified | adds `structuredQuestion?: unknown`, present only when the launch has a schema | yes |
| `subagents:completed` / `failed` / `resumed` payloads | modified | add `structuredQuestion?: unknown` when set | yes |
| `parseQuestionSchema` | new | `(input: unknown) => QuestionSchema \| undefined` in `src/seams/result-schema.ts` | no |
| `validateQuestion` | new | `(schema: QuestionSchema, fields: Record<string, unknown>) => ResultViolation[]`; paths are property names (`topic`, `topic.0`), and a violation of the root node itself is reported at `(fields)` | no |
| `AskedQuestion` | new | `{ readonly text: string; readonly fields?: unknown }` in `src/session/ask-parent-tool.ts`. `fields` is a fresh `structuredClone` of the validated rest, not frozen; `SubagentRun.setPendingQuestion` deep-freezes it on store | no |
| `QuestionRecorder` | modified | `(question: AskedQuestion) => void` (was `(question: string) => void`) | no |
| `AskParentTool` constructor | modified | `new AskParentTool(record: QuestionRecorder, schema?: QuestionSchema)` | no |
| `SubagentRun.setPendingQuestion` | modified | `(question: AskedQuestion \| undefined) => void` | no |
| `RunOutcome.structuredQuestion`, `RunOutcome.pendingStructuredQuestion` | new | `unknown`: the recorded fields (also after `replaced`), and the same `undefined` once replaced (mirrors `question` / `pendingQuestion`) | no |
| `Subagent.structuredQuestion` | new | getter `unknown` = `currentRun.pendingStructuredQuestion` | no |
| `SubagentExecution.questionSchema`, `SpawnOptions` (manager) `questionSchema`, `CreateSubagentSessionParams.questionSchema` | new | `questionSchema?: QuestionSchema` | no |
| `SubagentObserver.onQuestionAsked`, `SubagentManagerObserver.onSubagentQuestion` | modified | second parameter `question: AskedQuestion` (was `string`) | no |

---

## Task 1: Question schema parsing and validation — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/seams/result-schema.ts`
- Modify: `src/service/service.ts` (`QuestionSchema`, `SpawnOptions.questionSchema`, `SubagentRecord.structuredQuestion`)
- Test: `test/seams/result-schema.test.ts`

**Interfaces:**
- Produces: `parseQuestionSchema`, `validateQuestion`, `QuestionSchema`, `SpawnOptions.questionSchema`, `SubagentRecord.structuredQuestion` (Contracts).

- [ ] **Step 1: Write failing tests** in a new `describe("parseQuestionSchema")` and `describe("validateQuestion")` in `test/seams/result-schema.test.ts`, with `REF` = the reference schema:
  - `returns undefined for undefined`.
  - `accepts the reference schema and returns a deep-frozen copy`: `Object.isFrozen(parsed.properties.topic.enum)` is `true`, and it deep-equals `REF`.
  - `refuses a non-object root at /type`: `{ type: "string" }` throws `/^questionSchema \/type: /`.
  - `refuses a missing root type`: `{ properties: {} }` throws `/^questionSchema \/type: /`.
  - `refuses question in properties`: throws `/^questionSchema \/properties\/question: /`.
  - `refuses question in required`: `{ type: "object", required: ["question"] }` throws `/^questionSchema \/required: /`.
  - `names minimum and its pointer with the questionSchema prefix`: the message contains `questionSchema`, `minimum` and `/properties/n/minimum`.
  - `refuses the draft-07 $schema with the questionSchema prefix`.
  - `validateQuestion` `reports a root-level violation at (fields)`: schema `{ type: "object", enum: ["x"] }` (accepted by the subset) and `{}` gives a violation with path `(fields)`.
  - `validateQuestion` `returns no violations for { topic: "other" }`; `reports topic for "unknown" listing the allowed values` (path `topic`, message contains `"fact", "scope", "other"`); `reports a missing topic at topic`; `reports an extra property at its name with additionalProperties false`; `keeps undeclared fields when additionalProperties is unset` (`{ type: "object" }` and `{ extra: 1 }` gives `[]`).
- [ ] **Step 2: Run** `bun run test test/seams/result-schema.test.ts`. Expected: the new tests FAIL (not exported); the existing ones PASS.
- [ ] **Step 3: Implement.** Thread a `label: "resultSchema" | "questionSchema"` through `refuse` and `parseNode` (the cleanest form is a small context object passed down). `parseResultSchema` passes `"resultSchema"`. `parseQuestionSchema(input)`: `undefined` gives `undefined`; otherwise parse with `"questionSchema"`. Then refuse root `type !== "object"` at `/type` (`type must be object`), `properties` owning `question` at `/properties/question` (`question is reserved for the question text`), and `required` including `question` at `/required` (same message). Generalise `checkNode`'s root path: `validateResult` calls it with path `"result"` as today. `validateQuestion` calls it with path `""`, children are joined by `joinPath(parent, key)` (returns `key` when `parent` is `""`, else `${parent}.${key}`, and is used in `checkObject`, `checkNode` items and `checkExtra`), and the violation pusher maps an empty path to `(fields)`. `validateResult` paths are unchanged because their parent is never empty. Add `QuestionSchema`, `SpawnOptions.questionSchema` (doc comment as for `resultSchema`, plus "MUST NOT name `question`") and `SubagentRecord.structuredQuestion` (doc: "The fields of `pendingQuestion`, validated against the launch's `questionSchema`; present only with `pendingQuestion` on such a launch.") in `src/service/service.ts`.
- [ ] **Step 4: Run** `bun run test test/seams/result-schema.test.ts && bun run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(structured-question): parse and validate questionSchema`.

---

## Task 2: Schema-shaped ask_parent and per-run structured question — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Modify: `src/session/ask-parent-tool.ts`
- Modify: `src/lifecycle/subagent-run.ts` (`RunOutcome`, `setPendingQuestion`, getters)
- Modify: `src/lifecycle/subagent.ts` (`SubagentExecution.questionSchema`, `structuredQuestion` getter, `startRun` `askParent` closure and `questionSchema` param, `fail`, `SubagentObserver.onQuestionAsked`)
- Modify: `src/lifecycle/subagent-manager.ts` (spawn options `questionSchema` forwarded; `onSubagentQuestion` signature)
- Modify: `src/lifecycle/create-subagent-session.ts` (`CreateSubagentSessionParams.questionSchema`; `buildChildTools` passes it)
- Modify: `src/observation/composite-subagent-observer.ts`, `src/observation/subagent-events-observer.ts` (signature only in this task: emit `question: question.text`)
- Test (new tests): `test/session/ask-parent-tool.test.ts`, `test/lifecycle/subagent-run.test.ts`, `test/lifecycle/create-subagent-session.test.ts`
- Test (existing callers move from `string` to `AskedQuestion`; no behaviour change): `test/lifecycle/subagent.test.ts` (`params().askParent?.(question)` ~:49, `onQuestionAsked` ~:1017), `test/lifecycle/subagent-manager.test.ts` (~:1553-1560), `test/observation/notification.test.ts` (~:299-308), `test/lifecycle/create-subagent-session.test.ts` (~:403-418 expects `{ text: "Which config wins?" }`), `test/observation/subagent-events-observer.test.ts` (~:370-408 pass `{ text: "Which config?" }`), `test/lifecycle/subagent-run.test.ts` (`setPendingQuestion("…")` ~:404, 412, 551, 652), `test/observation/composite-subagent-observer.test.ts` (~:123), `test/tools/get-result-tool.test.ts` (`ask?.("Which config?")` ~:182-191). Grep `askParent|onQuestionAsked|onSubagentQuestion|setPendingQuestion` under `test/` before committing 5a to catch any other string caller.

**Interfaces:**
- Consumes: `QuestionSchema`, `validateQuestion` (Task 1).
- Produces: `AskedQuestion`, `QuestionRecorder`, `AskParentTool(record, schema?)`, `SubagentRun.setPendingQuestion(AskedQuestion | undefined)`, `RunOutcome.structuredQuestion` / `pendingStructuredQuestion`, `Subagent.structuredQuestion`, the observer signatures (Contracts). Task 3 reads them.

- [ ] **Step 1: Write failing tool tests** in `test/session/ask-parent-tool.test.ts`. Update the existing `execute` helper so the recorder receives `{ text }`, and expect `toHaveBeenCalledWith({ text: "…" })` with no `fields` key. Then add `describe("with a question schema")` using `REF`:
  - `lists question and the schema properties, requiring both`: `toToolDefinition().parameters` has `properties.question.type === "string"`, `properties.topic.enum` deep-equals the reference enum, `required` equals `["question", "topic"]` and `additionalProperties === false`.
  - `keeps the tool description when the schema has one`: with `{ ...REF, description: "X" }`, `parameters` has no `description` and the definition's `description` is today's text.
  - `records the text and fields for a valid call`: `{ question: "Q", topic: "scope" }` gives the recorder `{ text: "Q", fields: { topic: "scope" } }` and today's result text.
  - `hands the recorder a copy of the fields`: params `{ question: "Q", topic: "scope", nested: { a: 1 } }` with schema `{ type: "object" }`; the recorded `fields.nested` is not the same object as `params.nested`.
  - `sets additionalProperties only when the schema does`: with `{ type: "object", properties: { topic: { type: "string" } } }`, `"additionalProperties" in parameters` is `false`.
  - `accepts the catch-all`: `topic: "other"` is recorded.
  - `refuses an unknown topic without recording`: `topic: "unknown"` gives `isError: true`, text containing `topic`, and the recorder is not called.
  - `refuses a missing topic without recording`.
  - `refuses a non-string question without recording`.
  - `records {} for a schema without properties`: schema `{ type: "object" }`, `{ question: "Q" }` gives `fields: {}`.
  - `keeps undeclared fields when additionalProperties is unset`.
  - `without a schema the definition is unchanged`: `new AskParentTool(fn).toToolDefinition().parameters` deep-equals the TypeBox `Type.Object({ question: Type.String({ description: … }) })` it builds today (snapshot the JSON before editing the file).
- [ ] **Step 2: Write failing run tests** in `test/lifecycle/subagent-run.test.ts`:
  - `stores question text and fields together`: `setPendingQuestion({ text: "Q", fields: { topic: "scope" } })` gives `question` `Q`, `structuredQuestion` `{ topic: "scope" }` with `Object.isFrozen(run.structuredQuestion)` true, and the same for `pendingStructuredQuestion`.
  - `a later question replaces both`.
  - `undefined clears both`.
  - `replaced hides pending fields but keeps the recorded ones`: after `markReplaced()`, `pendingStructuredQuestion` is `undefined` and `structuredQuestion` still deep-equals.
  - `a text-only question has no structured question`.
- [ ] **Step 3: Write a failing factory test** in `test/lifecycle/create-subagent-session.test.ts`: `ask_parent takes the launch's question schema`. Call `createSubagentSession` with `askParent: vi.fn()` and `questionSchema: REF`; the `ask_parent` custom tool's parameters list `topic`. A second assertion: the tool count is the same as without a schema.
- [ ] **Step 4: Run** the three files. Expected: FAIL.
- [ ] **Step 5a: Recorder and run types.** Change `QuestionRecorder` and `SubagentRun.setPendingQuestion` to `AskedQuestion`, and update every existing caller listed under Files (tests and `src`) in the same commit. Run `bun run check && bun run test`. Expected: PASS except the new tests from Steps 1–3. Commit `refactor(structured-question): ask_parent records an AskedQuestion`.
- [ ] **Step 5b: Implement.** In `AskParentTool`, branch on `schema`. Without one, the current definition is kept as is. With one, the raw parameters are built as in design decision 3 (cast `as unknown as TSchema`, as `SubmitResultTool` does), and `execute` returns an error result when `typeof question !== "string"`. Otherwise it validates `rest` with `validateQuestion`; violations go into `- <path>: <message>` lines inside `The question does not match the required schema:\n…\nFix it and call ask_parent again.` with `isError: true`. A valid call records `{ text, fields: structuredClone(rest) }` (`src/session` imports nothing from `src/lifecycle`; freezing is the run's job). Build the parameters object without an `additionalProperties` key when the schema has none. In `SubagentRun`, keep `_pendingQuestion?: AskedQuestion`; `setPendingQuestion` stores `{ text, fields: fields === undefined ? undefined : deepFreeze(fields) }`, as `submitStructuredResult` freezes. `pendingQuestion`/`question` return `.text`; add `structuredQuestion` (`.fields`) and `pendingStructuredQuestion` (`undefined` when `_replaced`). `init.pendingQuestion` (a string) maps to `{ text }`. In `Subagent`, add `structuredQuestion` to the execution (`questionSchema`) and a getter. `startRun` passes `questionSchema: this.execution.questionSchema` and `askParent: (question) => { this.currentRun.setPendingQuestion(question); this.execution.observer?.onQuestionAsked?.(this, question); }`. Update the observer signatures through the manager and the composite observer. `SubagentEventsObserver.onSubagentQuestion` emits `question: question.text` for now.
- [ ] **Step 6: Run** `bun run test && bun run check`. Expected: PASS (all existing ask-back tests still pass).
- [ ] **Step 7: Commit** `feat(structured-question): schema-shaped ask_parent and per-run fields`.

---

## Task 3: Service door, snapshots and events — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Modify: `src/service/service-adapter.ts` (`spawn`, `toWaitedRecord`, `toSubagentRecord`)
- Modify: `src/observation/notification.ts` (`buildEventData`)
- Modify: `src/observation/subagent-events-observer.ts` (`onSubagentQuestion`)
- Test: `test/service/service-adapter.test.ts`, `test/config/custom-agents.test.ts`, `test/observation/notification.test.ts`, `test/observation/subagent-events-observer.test.ts`, `test/persisted-record.test.ts`, `test/service/service-wait.test.ts`
- Create: `test/seams/structured-question-flow.test.ts`

**Interfaces:**
- Consumes: `parseQuestionSchema` (Task 1); `Subagent.structuredQuestion`, `RunOutcome.structuredQuestion`, `AskedQuestion` (Task 2).

- [ ] **Step 1: Write failing adapter tests** in a `describe("questionSchema")` beside `describe("resultSchema")` in `test/service/service-adapter.test.ts`, following its existing patterns:
  - `refuses a non-object root before the session check`: no `currentCtx`, and `{ type: "string" }` throws `/^questionSchema \/type:/`.
  - `refuses fork naming questionSchema and fork` (caller `context: "fork"`), `refuses an agent default fork`, `accepts fresh`.
  - `does not call the policy for a refused schema`.
  - `passes a frozen copy to the manager`; `passes none without a schema`.
  - `the record snapshot carries structuredQuestion only when set` (fake record with and without the getter value).
  - `the subagent tool and frontmatter have no question schema field`, in `test/service/service-adapter.test.ts` or the nearest `AgentTool` test: the `parameters.properties` keys of `AgentTool`'s definition (`src/tools/agent-tool.ts`, `Type.Object` at ~:232) contain neither `questionSchema` nor `question_schema`. Also, in `test/config/custom-agents.test.ts`, an agent file loaded by `loadCustomAgents` (`src/config/custom-agents.ts`) with `question_schema: x` in its frontmatter yields an `AgentConfig` whose `Object.keys` contain no `questionSchema`.
- [ ] **Step 2: Write failing observation tests:**
  - `test/observation/notification.test.ts` `carries structuredQuestion only when set`.
  - `test/observation/subagent-events-observer.test.ts` `subagents:asked carries structuredQuestion with a schema` and `emits no structuredQuestion key without a schema`.
  - `test/persisted-record.test.ts` `does not persist structuredQuestion`.
- [ ] **Step 3: Write the failing flow test** `test/seams/structured-question-flow.test.ts`. Copy the harness shape of `test/seams/structured-result-flow.test.ts`: real adapter, manager, `createSubagentSession`, events observer, faked SDK session. Drop the `submit_result` hook; the child script receives `ask(params)`, which calls the installed `ask_parent` with the full params object. Spawn with `questionSchema`. Tests:
  - `wait resolves with pendingQuestion and structuredQuestion` (reference schema, `{ question: "Q", topic: "scope" }`; `wait(id)` gives `pendingQuestion` `Q` and `structuredQuestion` `{ topic: "scope" }`, and `getRecord(id).structuredQuestion` is frozen).
  - `subagents:asked and subagents:completed carry it`.
  - `an invalid call records nothing and emits no asked event` (`topic: "unknown"` gives an error result naming `topic`; the record has no `pendingQuestion`/`structuredQuestion`; no `subagents:asked`).
  - `the child fixes the call` (`unknown`, then `fact`).
  - `a later ask replaces the earlier one`.
  - `validates against the copy taken at spawn` (remove `"other"` from the caller's enum after spawn, then `topic: "other"` is still accepted).
  - `resume clears it, and the resumed run can ask again` (gate the resumed run to read the record mid-run, then `Q2`/`fact`).
  - `a launch without questionSchema is unchanged` (`ask_parent` parameters keys are `["question"]`; no `structuredQuestion` on the record, `subagents:asked` or `subagents:completed`).
- [ ] **Step 4: Write failing waited-run tests** in `test/service/service-wait.test.ts` `describe("structured question")`, using the existing `harness({ script })` and `t.tool("ask_parent", …)`:
  - `waited run keeps its structured question after a resume` (the `subagents:completed` listener resumes; the wait gets `pendingQuestion` `Q` and `structuredQuestion` `{ topic: "scope" }`).
  - `failure after a structured question` (`status` `error`, neither field).
  - `turn limit keeps it` (`aborted`, both fields; copy the turn-loop driver from `question at the turn limit`).
- [ ] **Step 5: Run** the files above. Expected: FAIL.
- [ ] **Step 6: Implement.** In `spawn`, after `parseResultSchema`, add `const questionSchema = parseQuestionSchema(options?.questionSchema);`. After the `resultSchema` fork check, add the same for `questionSchema` with the message `questionSchema cannot be used with context "fork": a forked child inherits the parent's conversation and gets no ask_parent tool.` Pass `questionSchema` to `manager.spawn`. Add `setOrOmit(out, "structuredQuestion", run.structuredQuestion)` in `toWaitedRecord` and `if (record.structuredQuestion !== undefined) out.structuredQuestion = record.structuredQuestion;` in `toSubagentRecord`. In `buildEventData`, spread it when defined. `onSubagentQuestion` spreads `structuredQuestion: question.fields` only when `fields !== undefined`. `persisted-record.ts` needs no change; the test pins it.
- [ ] **Step 7: Run** `bun run test && bun run check`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(structured-question): service option, snapshots and events`.

---

## Task 4: Docs, provenance and public types — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Easy
**Blocked by:** Task 3

**Files:**
- Modify: `README.md`, `docs/configuration.md`, `CHANGELOG.md`, `UPSTREAM.md`, `dist/public.d.ts`

- [ ] **Step 1: README.** Add `#### Structured questions` after `#### Structured results`, in the same style. Cover: the option, the schema rules (same subset; root `type: "object"`; no `question` in `properties`/`required`; fork refused; copied at spawn; not on the `subagent` tool or frontmatter), the reference example with the `other` catch-all, the `ask_parent` parameters, an invalid call returning an error and recording nothing, the per-run rules, where the field appears, and that it is not persisted. Also note that an older service ignores the option. Add `structuredQuestion (when set)` to the `subagents:asked`, `completed`, `failed` and `resumed` rows and to the waited-run per-run field list.
- [ ] **Step 2:** `docs/configuration.md` near the `ask_parent` note: one line saying a service launch's `questionSchema` adds typed fields to `ask_parent` (link to the README section). `CHANGELOG.md`: an `### Added` entry under a new top `## [Unreleased]` section in the fork part, linking #23.
- [ ] **Step 3: UPSTREAM.md.** `src/session/ask-parent-tool.ts` and `test/session/ask-parent-tool.test.ts` are upstream files (added upstream in `82752ee`) with no row yet: add `edit` rows for both. Extend the existing rows (reason appended) for `src/lifecycle/subagent-run.ts`, `src/lifecycle/subagent.ts`, `src/lifecycle/subagent-manager.ts`, `src/lifecycle/create-subagent-session.ts`, `src/observation/notification.ts`, `src/observation/subagent-events-observer.ts`, `src/observation/composite-subagent-observer.ts`, `src/service/service.ts`, `src/service/service-adapter.ts`, `src/seams/result-schema.ts`, `dist/public.d.ts` and every changed test file (each already has a row; extend the most recent one, e.g. the structured-result rows). Add an `add` row for `test/seams/structured-question-flow.test.ts`. Run `bun run test test/upstream.test.ts`. Expected: PASS.
- [ ] **Step 4:** `bun run build:types`, then `bun run check && bun run lint && bun run test && bun run verify:public-types && openspec validate --all`. Expected: all PASS; `dist/public.d.ts` contains `questionSchema?: QuestionSchema` and `structuredQuestion?: unknown`.
- [ ] **Step 5: Commit** `docs(structured-question): README, changelog, provenance and public types`.

---

## Scenario → test

**structured-question**
- Schema accepted → `structured-question-flow`: `wait resolves with pendingQuestion and structuredQuestion`; `result-schema.test` `accepts the reference schema…`
- Caller mutates the schema after spawn → `structured-question-flow`: `validates against the copy taken at spawn`
- Not on the subagent tool → `service-adapter.test` `the subagent tool and frontmatter have no question schema field` (Task 3 Step 1)
- Non-object root → `result-schema.test` `refuses a non-object root at /type`; `service-adapter.test` `refuses a non-object root before the session check`
- Declares question → `result-schema.test` `refuses question in properties`
- Requires question → `result-schema.test` `refuses question in required`
- Unsupported keyword → `result-schema.test` `names minimum and its pointer with the questionSchema prefix`
- Fork with a schema → `service-adapter.test` `refuses fork naming questionSchema and fork`
- Refusal before the policy → `service-adapter.test` `does not call the policy for a refused schema`
- Parameters with a schema → `ask-parent-tool.test` `lists question and the schema properties, requiring both`
- No schema → `ask-parent-tool.test` `without a schema the definition is unchanged`; `structured-question-flow` `a launch without questionSchema is unchanged`
- Valid call recorded → `ask-parent-tool.test` `records the text and fields for a valid call`
- Catch-all accepted → `ask-parent-tool.test` `accepts the catch-all`
- Invalid value refused → `ask-parent-tool.test` `refuses an unknown topic without recording`; `structured-question-flow` `an invalid call records nothing and emits no asked event`
- Missing required field → `ask-parent-tool.test` `refuses a missing topic without recording`
- Schema without properties → `ask-parent-tool.test` `records {} for a schema without properties`
- Child fixes the call → `structured-question-flow` `the child fixes the call`
- Later ask replaces → `subagent-run.test` `a later question replaces both`; `structured-question-flow` `a later ask replaces the earlier one`
- Failure drops it → `service-wait.test` `failure after a structured question`
- Resume clears it → `structured-question-flow` `resume clears it, and the resumed run can ask again`
- Resumed run asks again → same test
- Turn limit keeps it → `service-wait.test` `turn limit keeps it`
- Completed event → `structured-question-flow` `subagents:asked and subagents:completed carry it`; `notification.test` `carries structuredQuestion only when set`
- Not persisted → `persisted-record.test` `does not persist structuredQuestion`

**service-launch-wait**
- Resumed before the waiter reads it → existing `service-wait.test` test (unchanged)
- Structured question of the waited run → `service-wait.test` `waited run keeps its structured question after a resume`
- Service launch with metadata asks → existing `subagent-events-observer.test` (unchanged)
- Tool-call launch asks → existing `subagent-events-observer.test` (unchanged)
- Structured question on the event → `subagent-events-observer.test` `subagents:asked carries structuredQuestion with a schema`; `structured-question-flow` `subagents:asked and subagents:completed carry it`
- No schema, no field → `subagent-events-observer.test` `emits no structuredQuestion key without a schema`
- Ask with a topic → `structured-question-flow` `wait resolves with pendingQuestion and structuredQuestion`
- Failure after a structured question → `service-wait.test` `failure after a structured question`
