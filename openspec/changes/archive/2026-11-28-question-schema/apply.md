# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `question-schema`
**Iteration**: `1`
**Applied at**: `2026-11-28 18:40`
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-subagents.question-schema`
- **Worktree branch**: `question-schema`
- **Feature branch**: `feat/question-schema`
- **Base branch**: `main`

---

## Commits

- **Range**: `2f4f416..1409bc2` (`2f4f416` is the step 0 scaffold commit on the feature branch; implementation starts after it). The receipt commit follows.
- **Count**: `12`

---

## Tasks

- **Completed**: `12 of 12` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- `AskParentTool.execute` (internal): params typed `Record<string, unknown>` instead of `{ question: string }`, and the result may carry `isError`, so the schema-shaped call can carry extra fields and be refused. Not public; no plan entry depends on the old shape.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 1 | `sequential` | `2f4f416..8581ce5` | approved (1 minor n/a: biome formatter disabled) | n/a |
| Task 2 | `sequential` | `a6198fa..9db6cb7` | approved (2 minors ruled) | n/a |
| Task 3 | `sequential` | `7c4e887..5c10ae6` | approved (1 minor ruled) | n/a |
| Task 4 | `sequential` | `0e0a943..8ef92ed` | approved (1 minor deferred, fixed in final wave) | n/a |
| Final fix wave | `sequential` | `e32342d..1409bc2` | re-review: all 5 findings addressed | n/a |

Final whole-branch review over `2f4f416..e32342d`: "With fixes" (2 Important, 4 Minor + 1 deferred). Ruling: Important #1 (Pi coerces a non-string `question` to a string before `execute`) accepted per spec ("after Pi's argument validation and coercion", as `structured-result`'s "Coerced argument stored"); plan Review Focus corrected. Everything else fixed in `6379ea3`, `d3a72fd`, `1409bc2`.

## Evidence

- Parent re-run at `1409bc2`: `bun run check` clean, `bun run lint` clean, `bun run test` 140 files / 3287 tests pass, `bun run verify:public-types` OK, `openspec validate --all` 15 passed.
- E2E through real Pi (`pi -ne -e pi-claude-code -e <worktree>/src/index.ts -e /tmp/qs-e2e/probe.ts --model claude-code/claude-haiku-4-5 -p …`), with a probe extension calling the service:
  - spawn refused `{ type: "string" }`, `properties.question` and `required: ["question"]` with `questionSchema /type:`, `/properties/question:`, `/required:` messages;
  - a real child with the reference schema asked; `wait()` resolved `completed` with `pendingQuestion` and `structuredQuestion` `{ topic: "other" }`, and `subagents:asked` carried the same fields;
  - a launch without `questionSchema` completed with no `structuredQuestion` key.
  - Limitation: the child model chose its own call (`topic: "other"` instead of the scripted invalid-then-`scope` pair), so the invalid-call refusal is verified by `test/seams/structured-question-flow.test.ts` (real adapter, manager, session factory and installed tool; SDK session faked), not by the live run.
- Known unrelated: `bun run lint:md` fails on `docs/superpowers/plans/2026-11-19-prune-upstream-artefacts.md` (pre-existing on `main`); one herdr viewer test flaked once under full-suite load and passed alone and on every later run.

---

## Next step

Run `/opsx-verify`.
