## Design Summary

Let the registered launch policy raise a launch's turn limit, never lower it.

**Why.** A consumer policy (today `@ttdua/pi-jev-pilot`) already picks each worker's model and thinking level from the task. The main model sometimes passes a tight `max_turns` (20 or 40 is common) that does not fit the work it hands over. When that happens the run is cut at the ceiling, its status is `aborted`, and the work done so far is lost. The policy can see that a task is large, but it has no field to act on.

This change is preventive. Local session data shows no run stopped at its turn limit so far: about 99% of launches carry no limit at all, and of the 56 or so that carry one, only two were warned (both at `max_turns` 2). The risk is the cost of a wrong cut (a dead run), not how often it happens.

**What changes, as the policy sees it.**

- `LaunchRequest.requested` gains `maxTurns`: the turn limit the launch would run with if the policy changed nothing. That is the caller's `max_turns`, else the agent's `maxTurns`, else the `defaultMaxTurns` setting, normalized as today. It is absent when the launch has no limit. Without this value a policy cannot tell whether a number would raise or lower the limit.
- `LaunchAdjustment` gains an optional `maxTurns`.
- The executor applies it only when it raises the limit:
  - A value above `requested.maxTurns` replaces it.
  - A value at or below it is dropped with a debug note.
  - A value for a launch with no limit is dropped with a debug note. Raising from unlimited would add a limit, which is the opposite of the intent.
  - A value for an agent that locks `max_turns` is dropped with a debug note, as `model` and `thinking` are today.
  - A value that is not a positive integer makes the adjustment malformed, and the launch runs as if no policy were registered (existing fail-open rule).
- The applied limit becomes the session's limit, so a later resume of the same agent also runs under it, as resumes already run under the session's resolved limits.

**Specified requirements this alters** (living spec `executor-launch-policy`):

- "Launch request given to the policy": `requested` carries `maxTurns` in addition to `model` and `thinking`.
- "Applying the policy's adjustment": the adjustment gains `maxTurns`, with the raise-only rule above. All existing rules for `model`, `thinking`, `addTools` and `removeTools` stay as they are.
- "The policy fails open": unchanged in wording. A malformed `maxTurns` falls under "a value that is not an adjustment".

Other capabilities are not changed. `executor-agent-registry` already exposes `maxTurns` and `locked` on the snapshot.

**Goals**

- A policy can lengthen a run that the caller limited too tightly.
- A policy, correct or not, can never shorten a run or put a limit on an unlimited one.
- Consumers written for the current service keep working. The new fields are optional.

**Non-goals**

- Deciding how many turns a task needs. That belongs to the consumer (`worker-turn-floor` in pi-jev-pilot).
- An executor-side ceiling on how far a policy may raise. Over-raising costs money but loses no work, and the consumer bounds its own raise. It can be added later as a setting if needed.
- Changing `wrapUpTurns`, the warning, or how a run is stopped at its limit.
- Token or cost budgets.

**Anti-goals**

- Any path by which a policy ends a run earlier than it would end with no policy registered.

## Alternatives Considered

### Alternative A: Executor enforces raise-only
- **Approach**: The executor compares the policy's `maxTurns` with `requested.maxTurns` and applies it only when higher.
- **Pros**: Safe for every policy, including third-party ones. A buggy policy cannot kill runs. It follows the existing precedent that the executor refuses to remove a declared tool.
- **Cons**: The executor carries a policy opinion. A future need to tighten limits would need a spec change.

### Alternative B: Executor replaces, consumer keeps the rule
- **Approach**: A returned `maxTurns` replaces the requested one unless the field is locked, like `model` and `thinking`.
- **Pros**: Uniform with the other value fields. The executor stays neutral.
- **Cons**: A wrong value from any policy can cut runs short, and those failures are the costly kind.
- **Why not chosen**: The cost of a wrong lower value (a lost run) is far higher than the flexibility gained.

### Alternative C: Raise the default instead
- **Approach**: No policy field. Users set a larger `defaultMaxTurns`, or none.
- **Pros**: No API change.
- **Cons**: Does nothing for a limit the caller passes explicitly, which is the case that cuts runs.
- **Why not chosen**: It does not reach the problem.

## Agreed Approach

Alternative A, chosen by the user. The raise-only rule lives in the executor, and `requested.maxTurns` is exposed so policies can see the current limit.

## Key Decisions

- Raise-only is enforced by the executor (user's choice).
- `requested.maxTurns` is the resolved limit before the policy; absent means unlimited.
- An unlimited launch stays unlimited; a policy value for it is dropped with a debug note.
- A locked `max_turns` wins over the policy, as for other locked fields.
- No executor-side ceiling in this change (agreed default; non-goal above).
- A non-integer or non-positive `maxTurns` makes the adjustment malformed and the launch fails open.

## Open Questions

None
