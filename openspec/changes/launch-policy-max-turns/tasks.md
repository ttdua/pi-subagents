## 1. Raise-only turn limit in the launch policy

Blocked by: none

- [ ] 1.1 Add `requested.maxTurns` to `LaunchRequest` and `maxTurns` to `LaunchAdjustment` in `src/service/service.ts`, with doc comments stating the raise-only rule
- [ ] 1.2 Carry the door's `maxTurns` and the run config's `defaultMaxTurns` on `LaunchFacts`; in `src/seams/launch-gate.ts` resolve `requested.maxTurns` through `resolveTurnLimits` with the agent's `maxTurns`, and pass it through `src/seams/launch-request.ts` (omitted when unlimited)
- [ ] 1.3 Validate `maxTurns` as a positive safe integer in `validAdjustment` (`src/seams/launch-policy.ts`); anything else makes the adjustment malformed
- [ ] 1.4 Apply the raise-only rule in `applyAdjustment` (`src/seams/launch-plan.ts`): set `LaunchPlan.maxTurns` only above `requested.maxTurns`, never for an unlimited launch or a locked `max_turns`, with a debug note for each refusal
- [ ] 1.5 Return the applied limit as `LaunchOverrides.maxTurns` from the gate, and in `src/lifecycle/subagent.ts` build `turnLimits.maxTurns` from it before `execution.maxTurns`
- [ ] 1.6 Cover every scenario of the delta spec in `test/seams/launch-policy.test.ts`, including the service door, the lock, the unlimited launch, the malformed value and the resume
- [ ] 1.7 Run `bun run check`, `bun run test`, `bun run lint` and `bun run verify:public-types`

## 2. Docs and upstream record

Blocked by: 1

- [ ] 2.1 `README.md`: extend the launch policy feature line to turn limits, and add a note to the turn-budget section that a launch policy may raise (never lower) the limit and that `turnBudget.maxTurns` is the effective one
- [ ] 2.2 `docs/configuration.md`: state the turn-limit precedence next to `max_turns` (caller, agent, `defaultMaxTurns`, then a launch policy raise; a lock blocks the raise)
- [ ] 2.3 `UPSTREAM.md`: add one row per changed file for this change: `src/service/service.ts`, `src/seams/launch-request.ts`, `src/seams/launch-policy.ts`, `src/seams/launch-plan.ts`, `src/seams/launch-gate.ts`, `src/lifecycle/subagent.ts`, `test/seams/launch-policy.test.ts`, `README.md` and `docs/configuration.md`
- [ ] 2.4 Run `bun run lint:md` and `bun run test` (the upstream guard test reads `UPSTREAM.md`)
