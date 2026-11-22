## Why

The launch policy can set a worker's model and thinking but not its turn limit. When the caller passes a `max_turns` too tight for the task, the run is stopped at the ceiling, ends `aborted`, and its work is lost; the policy sees the task but has no field to prevent it. Letting the policy raise, and only raise, the limit closes that gap without giving any policy a way to cut a run short.

## What Changes

**Launch request**
- From: `requested` carries the caller's `model` and `thinking`.
- To: `requested` also carries `maxTurns`, the turn limit the launch runs with if the policy changes nothing; absent for an unlimited launch.
- Reason: a raise-only rule needs the current limit.
- Impact: non-breaking; new optional field.

**Launch adjustment**
- From: the adjustment has `model`, `thinking`, `addTools`, `removeTools`.
- To: it may also carry `maxTurns`. The executor applies it only when it is above `requested.maxTurns`; a value at or below it, a value for an unlimited launch, and a value for an agent that locks `max_turns` are dropped with a debug note. A `maxTurns` that is not a positive integer makes the adjustment malformed, and the launch fails open.
- Reason: lets a policy lengthen a run the caller limited too tightly, while no policy can shorten a run or limit an unlimited one.
- Impact: non-breaking; existing policies return no `maxTurns` and behave as before.

The applied limit is the session's limit, so a resume of the same agent runs under it too.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `executor-launch-policy`: "Launch request given to the policy" gains `requested.maxTurns`; "Applying the policy's adjustment" gains the raise-only `maxTurns` rule. "The policy fails open" keeps its wording and gains a malformed `maxTurns` scenario.

## Impact

- Code: `src/service/service.ts` (`LaunchRequest.requested.maxTurns`, `LaunchAdjustment.maxTurns`), `src/seams/launch-request.ts`, `src/seams/launch-policy.ts` (`validAdjustment`), `src/seams/launch-plan.ts` (`applyAdjustment`), `src/seams/launch-gate.ts` (`LaunchOverrides.maxTurns`), `src/lifecycle/subagent.ts` (pass the gate's limit into `turnLimits`).
- Tests: `test/seams/launch-policy.test.ts`; `bun run verify:public-types` for the published declarations.
- Docs: `README.md` (launch policy feature line and the service-spawn turn-limit note), `docs/configuration.md` (turn-limit precedence next to `max_turns`).
- `UPSTREAM.md`: one new row each for `src/service/service.ts`, `src/seams/launch-request.ts`, `src/seams/launch-policy.ts`, `src/seams/launch-plan.ts`, `src/seams/launch-gate.ts`, `src/lifecycle/subagent.ts`, `test/seams/launch-policy.test.ts`, `README.md` and `docs/configuration.md`.
- Consumers: `@ttdua/pi-jev-pilot` can use the field after this release (its change `worker-turn-floor`). No dependency changes.
