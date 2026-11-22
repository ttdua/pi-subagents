# Launch Policy Max Turns Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** The registered launch policy sees a launch's resolved turn limit and may raise it, never lower it.

**Architecture:** The launch gate resolves `requested.maxTurns` through `resolveTurnLimits`, the function the session already uses. `applyAdjustment` holds the raise-only rule beside the existing lock and tool rules. The gate returns the applied limit as `LaunchOverrides.maxTurns`, and `Subagent.startRun` passes it into `turnLimits`, so the tracker, `turnBudget` and resume follow it with no further change.

**Tech Stack:** TypeScript, vitest, biome, Bun scripts.

## Global Constraints

- New service fields are optional; consumers written for the current service keep working.
- A policy can never shorten a run or limit an unlimited one.
- Minimum turn limit stays 2 (`MIN_MAX_TURNS`); `0` still means unlimited.
- Tests need no secrets, paid calls or network beyond loopback.
- Public repository: English only. Every changed upstream file has its `UPSTREAM.md` row updated.

## Review Focus

- A service launch for an agent that locks `max_turns` while the SDK caller passes its own `maxTurns`: `requested.maxTurns` is the caller's value, and the policy cannot raise it (scenario "Locked turn limit kept for a service launch").
- An agent with `max_turns: 0` and a non-zero `defaultMaxTurns`: the launch is unlimited, `requested` has no `maxTurns`, and a policy value is dropped. Test `agent max_turns 0 stays unlimited` in Task 1.
- A policy that returns `maxTurns` together with other fields that are valid: a refused raise does not drop `thinking` or tools (scenario "Raise beside other fields").
- A policy that returns `maxTurns: 1` for a launch whose limit is 2: refused as a lower value, never normalized up into a raise. Test `a raise below the minimum is refused` in Task 1.
- Resume after a raised run: the resumed run keeps the raised limit, and the policy is not called again (scenario "Raised limit survives a resume").

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `LaunchRequest.requested` | modified | `{ model?: string; thinking?: SubagentThinkingLevel; maxTurns?: number }`. `maxTurns` is the resolved limit (at least 2), absent when the launch has no limit | yes |
| `LaunchAdjustment.maxTurns` | new | `maxTurns?: number`, a positive safe integer. Applied only when greater than `requested.maxTurns`, the launch has a limit, and `max_turns` is not in `locked` | yes |
| `LaunchPlan.maxTurns` | new | `maxTurns?: number`, set only when the raise applies | no |
| `LaunchOverrides.maxTurns` | new | `maxTurns?: number`, the applied raise; absent otherwise (also absent from `baseOverrides`) | no |
| `LaunchFacts.maxTurns`, `LaunchFacts.defaultMaxTurns` | new | `maxTurns?: number` (the door's value, as on `Subagent.execution.maxTurns`), `defaultMaxTurns?: number` (from `RunConfig`) | no |
| `LaunchRequestInput.requested` | modified | `{ model?: string; thinking?: ThinkingLevel; maxTurns?: number }` | no |

---

## Task 1: Raise-only turn limit in the launch policy — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/service/service.ts` (`LaunchRequest.requested`, `LaunchAdjustment`)
- Modify: `src/seams/launch-request.ts` (`LaunchRequestInput.requested`, `definedOnly`)
- Modify: `src/seams/launch-policy.ts` (`validAdjustment`, `pickDefined`)
- Modify: `src/seams/launch-plan.ts` (`LaunchPlan`, `applyAdjustment`)
- Modify: `src/seams/launch-gate.ts` (`LaunchFacts`, `LaunchOverrides`, `requestedValues`, `overridesOf`)
- Modify: `src/lifecycle/subagent.ts` (`consultLaunchPolicy`, `turnLimits` in `startRun`)
- Test: `test/seams/launch-policy.test.ts`

**Interfaces:**
- Consumes: `resolveTurnLimits(request, agentMaxTurns)` from `src/lifecycle/turn-limits.ts`; `lockedFields` (already feeds `request.locked`).
- Produces: the Contracts above. Task 2 documents them.

- [ ] **Step 1: Extend the test harness.** In `test/seams/launch-policy.test.ts`, add `defaultMaxTurns?: number` to `Options`. Pass it to the `AgentTool` settings (`{ defaultMaxTurns: options.defaultMaxTurns, maxConcurrent: 4 }`) and to `SubagentManager` as `getRunConfig: () => ({ defaultMaxTurns: options.defaultMaxTurns, wrapUpTurns: 2, midRunUpdates: false })`. Add a helper `limitOf(h, i = 0)` that returns `h.manager.listAgents()[i]!.turnBudget?.maxTurns`. The session meta is private; the record's `turnBudget` is set when the turn loop starts (`enforceTurnBudget` reports the budget even though the mocked `prompt` resolves at once) and has no `maxTurns` for an unlimited run. Read it after `await h.call(...)`, or for a service launch after `await h.manager.getRecord(id)!.promise`.

- [ ] **Step 2: Write the failing request tests** in `describe("launch request")`:
  - `requested.maxTurns is the caller's max_turns`: `call("call_1", { ...explore, max_turns: 20 })`, then `requestOf(policy).requested.maxTurns` is `20`.
  - `requested.maxTurns falls back to defaultMaxTurns`: `harness({ defaultMaxTurns: 30 })`, no `max_turns`, gives `30`.
  - `requested.maxTurns is the agent's max_turns`: `harness({ agent: { maxTurns: 15 } })` gives `15`.
  - `a service launch requests its maxTurns`: `h.service.spawn("Explore", "go", { description: "d", maxTurns: 20 })`, await the consult, gives `20`.
  - `an unlimited launch requests no maxTurns`: `"maxTurns" in requestOf(policy).requested` is `false`.
  - `agent max_turns 0 stays unlimited`: `harness({ agent: { maxTurns: 0 }, defaultMaxTurns: 30 })` has no `maxTurns` in `requested`.

- [ ] **Step 3: Write the failing adjustment tests** in `describe("applying the adjustment")`:
  - `a higher maxTurns raises the limit`: `max_turns: 20`, policy `{ maxTurns: 60 }`, then `limitOf(h)` is `60` and the record's `turnBudget?.maxTurns` is `60`.
  - `a lower maxTurns is refused`: `max_turns: 40`, policy `{ maxTurns: 10 }`, gives `40`, and a warning contains `maxTurns`.
  - `an equal maxTurns is refused`: `40` and `40` gives `40`, with a warning.
  - `a raise below the minimum is refused`: `max_turns: 2`, policy `{ maxTurns: 1 }`, gives `2`, with a warning.
  - `an unlimited launch stays unlimited`: policy `{ maxTurns: 80 }` gives `limitOf(h)` `undefined`, with a warning.
  - `a locked max_turns is kept`: `harness({ agent: { maxTurns: 10, locked: ["max_turns"] } })`, policy `{ maxTurns: 50 }`, gives `10`, with a warning.
  - `a locked max_turns is kept for a service launch`: the same agent, `spawn` with `maxTurns: 5`, gives `requested.maxTurns` `5` and `limitOf(h)` `5` (read after the record's `promise`), with a warning.
  - `a refused raise keeps the other fields`: `max_turns: 40`, policy `{ thinking: "high", maxTurns: 10 }`, gives thinking `high` and limit `40`.
  - `the raised limit survives a resume`: `max_turns: 20`, policy `{ maxTurns: 60 }`, then resume as in `resume does not consult the policy`. The second run's `turnBudget?.maxTurns` is `60`, and `policy` was called once.

- [ ] **Step 4: Write the failing validation tests.**
  - In `describe("validAdjustment")`, add rejections `[{ maxTurns: 2.5 }]`, `[{ maxTurns: 0 }]`, `[{ maxTurns: -3 }]` and `[{ maxTurns: "60" }]`. Add `maxTurns: 60` to the well-formed value.
  - In `describe("the policy fails open")`, add `it.each([2.5, 0])("a malformed maxTurns %s leaves the requested values")`: `max_turns: 20`, policy `{ thinking: "low", maxTurns: value }`, gives thinking equal to the requested one (not `low`) and limit `20`.

- [ ] **Step 5: Run the new tests to verify they fail.**
  Run: `bun run test test/seams/launch-policy.test.ts`
  Expected: the new tests FAIL (`requested.maxTurns` undefined, limit unchanged, `maxTurns` accepted by `validAdjustment`). Existing tests pass.

- [ ] **Step 6: Add the contract types** in `src/service/service.ts` and `src/seams/launch-request.ts`, as in Contracts. Doc comment on `LaunchAdjustment.maxTurns`: "Raises the turn limit; ignored unless greater than `requested.maxTurns`, the launch has a limit and the agent does not lock `max_turns`." `definedOnly` copies `maxTurns` when defined.

- [ ] **Step 7: Validate the shape in `validAdjustment`.** A present `maxTurns` that fails `Number.isSafeInteger(v) && v > 0` returns `undefined`. `pickDefined` carries `maxTurns`.

- [ ] **Step 8: Apply the rule in `applyAdjustment`.** Add a helper `raisedMaxTurns(request, value): number | undefined` in `src/seams/launch-plan.ts`. It returns `undefined` with a `debugNote` (`launch policy: agent <type> ...; maxTurns <value> ignored`) when `max_turns` is locked, when `request.requested.maxTurns` is undefined, or when `value <= requested`. Otherwise it returns `value`.

- [ ] **Step 9: Resolve and pass the limit in the gate.**
  - `LaunchFacts` gains `maxTurns` and `defaultMaxTurns`.
  - `requestedValues` adds `maxTurns: resolveTurnLimits({ maxTurns: facts.maxTurns, defaultMaxTurns: facts.defaultMaxTurns }, config.maxTurns).maxTurns`.
  - `overridesOf` sets `maxTurns: plan.maxTurns` when defined.
  - `baseOverrides` is unchanged.

- [ ] **Step 10: Use the override in `Subagent`.** `consultLaunchPolicy` passes `maxTurns: execution.maxTurns` and `defaultMaxTurns: execution.getRunConfig?.().defaultMaxTurns`. In `startRun`, `turnLimits.maxTurns` becomes `overrides?.maxTurns ?? this.execution.maxTurns`.

- [ ] **Step 11: Run the tests to verify they pass.**
  Run: `bun run test test/seams/launch-policy.test.ts`
  Expected: PASS, all tests.

- [ ] **Step 12: Run the full checks.**
  Run: `bun run check && bun run lint && bun run test && bun run verify:public-types`
  Expected: each exits 0; vitest reports 0 failed.

- [ ] **Step 13: Commit**

```bash
git add src/service/service.ts src/seams/launch-request.ts src/seams/launch-policy.ts src/seams/launch-plan.ts src/seams/launch-gate.ts src/lifecycle/subagent.ts test/seams/launch-policy.test.ts
git commit -m "feat(executor-launch-policy): let the launch policy raise the turn limit"
```

---

## Task 2: Docs and upstream record — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Easy
**Blocked by:** Task 1

**Files:**
- Modify: `README.md` (feature line near line 722; turn-budget section near lines 264-285)
- Modify: `docs/configuration.md` (the `max_turns` row and the precedence line near line 139)
- Modify: `UPSTREAM.md` (the seven files of Task 1 plus `README.md` and `docs/configuration.md`)

**Interfaces:**
- Consumes: the Contracts above.

- [ ] **Step 1: README.**
  - Feature line: `**Launch policy** — registerLaunchPolicy lets one extension adjust model, thinking, tools and turn limit for each launch.`
  - Turn-budget section: add one sentence: "A launch policy may raise `max_turns`, never lower it or limit an unlimited run; `turnBudget.maxTurns` is the effective limit, while the spawn result's `max turns` tag shows what was asked."

- [ ] **Step 2: docs/configuration.md.** After the precedence sentence for `max_turns`, state: caller, then agent, then `defaultMaxTurns`, then a launch policy raise, which a locked `max_turns` blocks.

- [ ] **Step 3: UPSTREAM.md.** Add one new row per changed file (the seven of Task 1, `README.md`, `docs/configuration.md`) in a block for this change, following the existing per-change blocks (for example the `structured-result` rows near line 209); do not edit older rows. Example for `src/seams/launch-plan.ts`: "Raise-only `maxTurns`: applied only above `requested.maxTurns`, never for an unlimited launch or a locked `max_turns`."

- [ ] **Step 4: Verify.**
  Run: `bun run lint:md && bun run test`
  Expected: both exit 0, including the `test/upstream.test.ts` guard.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/configuration.md UPSTREAM.md
git commit -m "docs(executor-launch-policy): document the raise-only turn limit"
```

---

## Scenario → test

New tests are in `test/seams/launch-policy.test.ts`. Existing scenarios keep their current tests, named with their file.

- Tool-call origin → `tool-call origin, agent type and requested model` (existing)
- Orchestration tools never offered → `orchestration tools are never offered` (existing)
- Protocol tools never offered → `submit_result is never offered` (existing)
- Excluded extension's tool not offered → `an excluded extension's tool is not offered` (existing)
- Locked caller value not requested → `a locked caller value is not requested` (existing)
- Fork request → `Fork request: no caller model → …` (existing)
- Locked fork request → `Locked fork request: …` (existing)
- Fallen-back fork → `test/lifecycle/subagent-manager.test.ts`: `Fallen-back fork: the launch policy receives context fresh` (existing)
- Service launch with metadata → `test/seams/launch-metadata-flow.test.ts`: `Service launch with metadata` (existing)
- No metadata in the request → `test/seams/launch-metadata-flow.test.ts`: `No metadata in the request` (existing)
- Launch-excluded extension's tool not offered → `test/seams/launch-resources-flow.test.ts`: `launch-excluded tool not offered` (existing)
- Caller's turn limit requested → `requested.maxTurns is the caller's max_turns`
- Default turn limit requested → `requested.maxTurns falls back to defaultMaxTurns`
- Service launch turn limit requested → `a service launch requests its maxTurns`
- Agent turn limit requested → `requested.maxTurns is the agent's max_turns`
- Unlimited launch requests no turn limit → `an unlimited launch requests no maxTurns`
- Model and thinking applied → `model and thinking are applied` (existing)
- Locked field kept → `a locked field is kept, with a debug note` (existing)
- Extension tool granted → `an extension tool is granted` (existing)
- Declared tool not removable → `a declared tool is not removable` (existing)
- Default tool removed → `a default tool is removed` (existing)
- Grant outside the parent's tools dropped → `a grant outside the parent's tools is dropped` (existing)
- Removal in a fork → `test/lifecycle/fork-tools.test.ts`: `Policy removal refuses: a launch-policy removal (absent from the base tools) is not callable` (existing)
- Turn limit raised → `a higher maxTurns raises the limit`
- Lower turn limit refused → `a lower maxTurns is refused`
- Equal turn limit refused → `an equal maxTurns is refused`
- Unlimited launch stays unlimited → `an unlimited launch stays unlimited`
- Locked turn limit kept → `a locked max_turns is kept`
- Locked turn limit kept for a service launch → `a locked max_turns is kept for a service launch`
- Raised limit survives a resume → `the raised limit survives a resume`
- Raise beside other fields → `a refused raise keeps the other fields`
- Policy throws → `a throwing policy leaves the requested values` (existing)
- Policy too slow → `a slow policy is cut at timeoutMs and its signal aborted` (existing)
- Malformed adjustment → `a malformed adjustment leaves the requested values` (existing)
- Malformed turn limit → `a malformed maxTurns leaves the requested values`, covering `2.5` and `0` end to end, plus the new `validAdjustment` rejections
