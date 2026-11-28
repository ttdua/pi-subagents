## 1. Question schema parsing and validation

Blocked by: none

- [x] 1.1 Parameterise `src/seams/result-schema.ts` with a schema label so refusals read `questionSchema <pointer>: …` for question schemas, keeping every `resultSchema` error text and `validateResult` path unchanged
- [x] 1.2 Add `parseQuestionSchema` (root `type` `object`; `question` refused in root `properties` and `required`) and `validateQuestion` (paths named by property) with tests in `test/seams/result-schema.test.ts`
- [x] 1.3 Add the public `QuestionSchema` type, `SpawnOptions.questionSchema` and `SubagentRecord.structuredQuestion` in `src/service/service.ts`

## 2. Schema-shaped ask_parent and per-run structured question

Blocked by: 1

- [x] 2.1 `AskParentTool` takes an optional `QuestionSchema`: schema parameters `{ question, ...properties }`, validation of the fields, error result without recording; unchanged definition without a schema (`test/session/ask-parent-tool.test.ts`)
- [x] 2.2 `QuestionRecorder` carries `AskedQuestion { text, fields? }`; `SubagentRun.setPendingQuestion` stores both and exposes `structuredQuestion`/`pendingStructuredQuestion` with the `replaced` rule; `fail` drops both (`test/lifecycle/subagent-run.test.ts`)
- [x] 2.3 Thread `questionSchema` through `SubagentManager.spawn` → `Subagent` execution → `createSubagentSession` → `AskParentTool`; observer hooks `onQuestionAsked`/`onSubagentQuestion` pass `AskedQuestion` (composite observer included)

## 3. Service door, snapshots and events

Blocked by: 2

- [ ] 3.1 `SubagentsServiceAdapter.spawn` parses `questionSchema` with the other refusals and refuses a `fork` context naming `questionSchema` and `fork` (`test/service/service-adapter.test.ts`)
- [ ] 3.2 `toSubagentRecord`, `toWaitedRecord` and `buildEventData` carry `structuredQuestion` when set; `subagents:asked` carries it when the launch has a schema; `subagents:record` does not persist it (`test/observation/*`, `test/persisted-record.test.ts`)
- [ ] 3.3 End-to-end flow test `test/seams/structured-question-flow.test.ts` and waited-run tests in `test/service/service-wait.test.ts` covering the spec scenarios

## 4. Docs, provenance and public types

Blocked by: 3

- [ ] 4.1 README "Structured questions" section, `subagents:asked` event row and waited-run field list; `docs/configuration.md` `ask_parent` note; `CHANGELOG.md` `Added` entry
- [ ] 4.2 `UPSTREAM.md` rows for every changed upstream file and the new test file
- [ ] 4.3 Regenerate `dist/public.d.ts` and run `bun run check`, `bun run lint`, `bun run test`, `bun run verify:public-types`, `openspec validate --all`
