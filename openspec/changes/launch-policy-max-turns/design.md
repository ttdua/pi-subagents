## Context

A launch's turn limit is resolved today in two places with the same precedence, and only at session creation:

- The tool door computes `effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? settings.defaultMaxTurns)` (`src/tools/spawn-config.ts`). Here `resolvedConfig.maxTurns` is the caller's `max_turns` or the agent's own, with the agent's lock already applied by `resolveField`.
- The service door passes the caller's `options.maxTurns` raw (`src/service/service-adapter.ts`).
- Either way it reaches `Subagent.execution.maxTurns`. `createSubagentSession` then calls `resolveTurnLimits({ maxTurns, defaultMaxTurns, wrapUpTurns }, cfg.agentMaxTurns)`, which applies call, then agent, then default, then `normalizeMaxTurns` (`src/lifecycle/turn-limits.ts`).

The launch gate (`src/seams/launch-gate.ts`) runs before session creation. It builds `requested` from the door's model and thinking only, and returns `LaunchOverrides` with `model`, `thinkingLevel` and `tools`. `Subagent.startRun` passes those overrides into the session factory and builds `turnLimits` from `execution.maxTurns`.

## Goals / Non-Goals

**Goals:**
- The policy sees the exact limit the session would run with, from the same resolution the session uses.
- A raised limit reaches the session through the existing `turnLimits` path, so the tracker, warning, record `turnBudget` and resume all follow it with no further change.

**Non-Goals:**
- Changing how the doors resolve `max_turns`, how locks apply at the doors, or how `TurnBudgetTracker` works.

## Decisions

**1. `requested.maxTurns` comes from `resolveTurnLimits`, not a second copy of the precedence.**
The gate gets the door's `maxTurns` and the run config's `defaultMaxTurns` on `LaunchFacts`, plus the agent's `maxTurns` from the resolved `AgentConfig` it already loads. It calls `resolveTurnLimits(...)` and takes `.maxTurns`.
Alternative: recompute `call ?? agent ?? default`. Rejected: two copies of the precedence can drift, and the policy would then compare against a value the session never uses.

**2. The raise-only rule lives in `applyAdjustment` (`launch-plan.ts`), next to the lock and declared-tool rules.**
`LaunchPlan` gains an optional `maxTurns`, set only when the adjustment's value is above `request.requested.maxTurns`, the request has a limit, and `max_turns` is not in `request.locked`. Each refusal writes one `debugNote` in the existing `launch policy: agent <type> ...` form.
Alternative: enforce it in `Subagent`. Rejected: `applyAdjustment` is where every other adjustment rule lives and is tested.

**3. Shape validation in `validAdjustment` (`launch-policy.ts`).**
A present `maxTurns` must be a positive safe integer, or the whole adjustment is malformed. This matches how a bad `thinking` or `model` is handled today. A positive integer at or below the requested limit is well-formed but refused by decision 2. Valid input that does nothing is a debug note, not a failed policy.

**4. The gate returns the raised limit as `LaunchOverrides.maxTurns`; `Subagent` prefers it.**
In `startRun`: `turnLimits.maxTurns = overrides?.maxTurns ?? this.execution.maxTurns`. A raised value is above the resolved limit, so it is also above `execution.maxTurns`, and `resolveTurnLimits` keeps a call-level value first. No other precedence changes.
`baseOverrides` sets no `maxTurns`, so a policy that returns nothing leaves the limit exactly as today.

**5. A lock is read from `request.locked`.**
`locked` already lists `max_turns` when the agent locks it (`lockedFields`). This holds for the service door too, even though a lock does not stop an SDK caller from passing `maxTurns`: the lock is about who may change the agent's limit, and a policy is not the SDK caller.

## Risks / Trade-offs

- [Risk] The tool door's `effectiveMaxTurns` already folds in `defaultMaxTurns`, while the service door does not. → Decision 1 resolves both through `resolveTurnLimits`, which gives the same answer either way because the default is applied last.
- [Risk] A policy raises limits very high, and runaway runs cost more. → Accepted for this change (non-goal in brainstorm). The consumer bounds its raise, and an executor-side ceiling can come later as a setting.
- [Risk] The tool result's `max turns: N` tag is computed at the door, before the gate, so after a raise it shows the caller's limit while the live `turnBudget` shows the raised one. → Accepted: the tag reports what was asked, `turnBudget` is the authoritative limit, and the README note on policy-adjusted limits says so.
- [Trade-off] An unlimited launch can never get a limit from the policy, even a large one. → Intended: the anti-goal is any policy-caused early stop.

## Migration Plan

Additive. Policies that return no `maxTurns` see one new optional request field and nothing else. The published declarations change additively; `bun run verify:public-types` checks them. Rollback is a revert.

## Open Questions

None.
