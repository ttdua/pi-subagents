# Upstream

This repository is a fork of `@gotgenes/pi-subagents`. It started as a vendored copy inside `ttdua/pi-jev-pilot` (`packages/pi-subagents`) and was split out with `git subtree split`, so upstream's history is kept. Behavior is unchanged from upstream apart from the changes listed below.

## Upstream

- Repository: `gotgenes/pi-packages` (<https://github.com/gotgenes/pi-packages>)
- Path: `packages/pi-subagents`
- Tag: `pi-subagents-v25.0.5`
- Commit: `a4dd5f7611a2d7687a50899e99be7bd727ddc2b0`
- Upstream split commit: `e6b408e8c5a1036c00a8b5f233549cedcb83f77c` (in this repository's history; `git diff e6b408e HEAD` shows every local change)
- License: MIT, see `LICENSE` (unchanged)

"Upstream split commit" is the `git subtree split --prefix packages/pi-subagents` commit of the tag. To sync a newer upstream release, run `scripts/sync-upstream.sh <version>` (see the README's "Syncing upstream").

Outside the table below, the fork also changes repository files that upstream kept at the monorepo root: `biome.json` (standalone config), `.gitignore`, `bun.lock`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md` (fork notes, install from git), `AGENTS.md`, `CONTRIBUTING.md` (release steps), `CHANGELOG.md` (fork entries, upstream history heading), `NOTICE.md` and `UPSTREAM.md`. `.prettierignore` drops the monorepo wording. `.rumdl.toml` scopes markdown lint to the docs this fork maintains (upstream's lived at the monorepo root). Upstream development artefacts are pruned on purpose: `docs/plans/`, `docs/retro/`, `docs/architecture/history/`, `docs/fallow-snapshot.json` and `.pi/agents/auditor.md` (an upstream sync that brings them back as modify/delete conflicts resolves by deleting them again). `docs/` is rewritten for the fork and `openspec/` (the fork's OpenSpec specs and `superspec` schema) is fork-only; neither is listed per file. `test/upstream.test.ts` fails when a changed path under `src/`, `test/`, `agents/`, `scripts/`, `dist/`, or `package.json`/`tsconfig.json`/`rollup.dts.config.mjs`, has no row in the table, or another changed file outside `docs/` and `openspec/` is missing from this paragraph. Imports in upstream `src/` and `test/` files are sorted by biome's `organizeImports` (formatting only, not listed per file).

## Local changes

| File | Kind | Reason |
|---|---|---|
| `package.json` | edit | Rename to private `@ttdua/pi-subagents`; drop `publishConfig`; replace `catalog:` versions with the exact versions from upstream `pnpm-workspace.yaml` at the tag; pin the `@earendil-works/*` dev dependencies to `1.5.0` to match the root; `lint` without markdown lint; `prepack` through `bun`. Declare `pi.subagents.agents` (`./agents`) and ship `agents` in `files`. Pin `@biomejs/biome` to `2.6.8`. `files` ships `docs/architecture/*.md` (not the pruned phase history); `lint:md` checks the scope set in `.rumdl.toml`. |
| `scripts/verify-public-types.sh` | edit | Pack, install and type-check through `bun` instead of `pnpm`; the consumer probe imports the package name read from `package.json` (`@ttdua/pi-subagents`), not the upstream name. |
| `tsconfig.json` | edit | Inline upstream's `tsconfig.base.json` compiler options, since the base file lives outside the subtree; `allowImportingTsExtensions` lets `viewer.ts` import `./frame-protocol.ts`. |
| `test/ui/widget-viewport.test.ts` | edit | `fakeTerminal` gains `setProgramStatus`, required by the `Terminal` type in pi-tui 1.5.0. Registry fixture holds `general`. |
| `test/ui/session-navigator.test.ts` | edit | Bind top/bottom to `home`/`end` in the test keybindings; pi-tui 1.5.0 defaults them to `ctrl+home`/`ctrl+end`. Cover `openTranscript`. Labels show the recorded type. `paneOf` asserts the last `custom` call with `!` (biome `noUnsafeOptionalChaining`). Cover the `herdr` option: open in Herdr, fallback, unchanged command. |
| `src/ui/session-navigation.ts` | edit | Add `navigationEntryFor`, the per-record live/snapshot entry, shared by `listNavigableAgents` and the fleet list. |
| `src/ui/session-navigator.ts` | edit | Add `openTranscript`, the source/mount step of the session pane, shared by the picker handler and the fleet list. Rename the local `fit` helper to `fitToWidth` (biome `noFocusedTests` false positive). `SessionNavigatorParams.herdr`: a pick opens in a Herdr viewer first, then falls back to the pane. |
| `test/ui/session-navigation.test.ts` | edit | Cover `navigationEntryFor`. Legacy types shown as recorded, with `general` present, missing and disabled. |
| `src/settings.ts` | edit | Add the `fleetView` setting (default on, boolean-only load, always in the snapshot, `toggleFleetView`) for the below-editor fleet list. |
| `src/ui/subagents-settings.ts` | edit | Add the `Fleet view` toggle row after the mid-run updates row. |
| `src/seams/identity.ts` | seam | Launch identity (`agentId`, `agentType`, `toolCallId`) and effective model/thinking facts. Add `ToolFacts` (tool count and blocked tool count). `LaunchIdentity.metadata`; `launchFields` replaces `toolCallIdField`. |
| `src/seams/service-identity.ts` | seam | Publish the service at load unless this implementation's service already holds the slot; remove only one's own. |
| `src/index.ts` | edit | Publish the service at load through `ServicePublication` (not over an existing vendored service); bind the session id at `session_start`; unpublish only the instance's own service. Hand the service an `AgentTypeCatalog` over the registry. Give the manager the launch context (parent `getAllTools()`, `excludedExtensionPackages`). Construct the `FleetList`, add it as an observer, hand it the UI at `session_start`, refresh on `subagents:settings_changed`, dispose at `session_shutdown`. Seed project trust at load and record the session's answer first at `session_start`. Build the launch's excluded package list and loader settings per launch (`excludedPackageUnion`); note unknown excluded packages. Herdr viewers: slot observer, `HerdrActivation` at `session_start`/`session_shutdown` (after lifecycle), `herdr` passed to `/subagents:sessions`. |
| `src/service/service.ts` | edit | Add `implementation`, `sessionId` to `SubagentsService` and `effectiveModel`, `effectiveThinking` to `SubagentRecord`. Add `AgentTypeSnapshot`, `listAgentTypes`, `getAgentType`; re-export `LockableField`. Add `LaunchPolicy`, `LaunchRequest`, `LaunchAdjustment`, `LaunchOrigin` and `registerLaunchPolicy`. Add optional `toolCount` and `blockedToolCount` to `SubagentRecord`. `AgentTypeSnapshot.source` gains `package`. Add `LaunchMetadata`, `ChildSessionInfo`, `SpawnOptions.metadata`, `SubagentRecord.metadata`, `LaunchRequest.metadata` and `childSession`; re-export `PublishedLaunchIdentity`. Add `LaunchSkills` and the `SpawnOptions` fields `skills`, `excludeExtensionPackages`, `cwd` and `contextFiles`; `AgentTypeSnapshot.inheritSkills`. Add `WaitOptions` and `SubagentsService.wait`; `SUBAGENT_EVENTS` gains `UPDATE` and `ASKED`. |
| `src/service/service-adapter.ts` | edit | Carry `implementation` and `sessionId` (bound at first `session_start`); map the effective facts into the record snapshot. Serve `listAgentTypes`/`getAgentType` through the injected catalog. Forward `registerLaunchPolicy`; service spawns carry `origin: service`. Copy the tool facts into the record snapshot. `spawn` validates `metadata` first; `childSession` over the registry; the snapshot copies `metadata`. Parse the launch resources at `spawn` (`parseLaunchResources`) and carry them on the request. Add `wait`, a claim-based carrier over `Subagent.waitForRunEnd`; `toWaitedRecord` builds the waited run's snapshot. |
| `src/lifecycle/child-lifecycle.ts` | edit | Child events carry `agentId`, `agentType`, `toolCallId`; `session-created` carries the effective facts; `bound` carries `grantedTools`. Child events carry the launch's `metadata`; the child session is entered in the registry before `session-created` and left after `disposed`. `session-created` carries `cwd` and, for a launch with resources or a pin, the effective skill, exclusion and context facts. |
| `src/lifecycle/create-subagent-session.ts` | edit | Take `agentId`; publish launch identity and effective facts on child events. Apply `disallowed_tools` through `finalToolNames` before the recursion denylist. Take the launch policy's tool plan; check grants after bind and report `grantedTools` on `bound`; dispose the child if not even the pre-grant tool set can be restored. Report tool count and blocked tool count (`onToolFacts`) after the grant check; carry `tools.removed`. Pass `metadata` to the child events. Build the child loader from the effective skill choice (`skillLoaderOptions`, `assertNoCatalogCollision`) and report `resourceFacts`. |
| `src/lifecycle/subagent.ts` | edit | Pass `agentId` to the session factory, store effective facts, track the resume's tool call id. Consult the launch policy after dequeue and before session creation (new launches only); a launch cancelled meanwhile ends `stopped`. With a policy registered, the gate's model/thinking (locks and adjustment applied) are authoritative. Store the tool facts (`toolFacts`), kept across `releaseSession()`. Carry the launch's `metadata` on the execution and the record; pass it to the launch request. Carry the launch's `resources` on the execution and re-check them before the workspace provider runs. Notify `onQuestionAsked` when a question is recorded; add `waitForRunEnd`. |
| `src/lifecycle/subagent-manager.ts` | edit | Forward the resume's `toolCallId` to the record. Own the launch policy slot; `AgentSpawnConfig.origin`; hand each record the launch gate. `resolveSpawn` falls back to `general` and refuses the launch when it is missing or disabled. Forward `metadata` from the spawn config to the execution. Supply the `LaunchResourcesIO` and forward the launch resources to the execution. Relay `onSubagentQuestion` to the observer chain. |
| `src/tools/agent-tool.ts` | edit | Pass the `subagent` call's tool call id to `startResume`; launches carry `origin: tool`. |
| `src/observation/subagent-events-observer.ts` | edit | Record events carry `toolCallId` when launched or resumed from a tool call. Record events carry `metadata` through `launchFields`. Emit `subagents:asked` from `onSubagentQuestion`; `subagents:update` carries `toolCallId` and `metadata`. |
| `test/lifecycle/child-lifecycle.test.ts` | edit | Child event payloads now include launch identity fields. |
| `test/lifecycle/create-subagent-session.test.ts` | edit | Pass the required `agentId`; event expectations use `objectContaining` for the added identity fields. Tool facts tests; `tools` carries `removed`. Verifier fresh offers `bash` and neither `edit` nor `write`. Loader stubs return the new `getSkills` shape; `createLoaderSettingsManager` returns `excludedExtensionPackages`. |
| `test/composition-root.test.ts` | edit | Clear the published service after each test; a later load no longer replaces an earlier vendored service. The recording UI gains `onTerminalInput`/`getEditorText`, and `agents` widget assertions check the last call for that key. Session-start context carries `isProjectTrusted`; trust wiring and activation-time description. Drop unused `node:fs` imports. Herdr wiring tests (outside, background detection, shutdown before detection). |
| `test/tools/agent-tool.test.ts` | edit | Resume now forwards `toolCallId`; expectations include it. Fixtures carry `toolsDeclared`/`disallowedTools`. Built-in names in the description and guidelines. |
| `dist/public.d.ts` | seam | Regenerated by `build:types`; exports the extended service, record and event types. Includes `AgentTypeSnapshot` and the registry methods, and the launch policy types and `registerLaunchPolicy`. `SubagentRecord` gains optional `toolCount` and `blockedToolCount`. |
| `dist/settings.d.ts` | seam | Generated alongside `public.d.ts` by `build:types`. |
| `test/seams/identity.test.ts` | seam | Tests for launch identity and effective facts (spawn fixtures carry `origin`). Tool facts on the record snapshot. Registry fixture holds `general`. |
| `test/seams/service-identity.test.ts` | seam | Tests for service ownership across main and child sessions. |
| `test/seams/fleet-wiring.test.ts` | seam | Fleet list wiring through the real `index.ts`: widget placement, settings switch, input listener, shutdown. Session-start context carries `isProjectTrusted`. Fleet Enter unchanged inside Herdr; UI stub gains `custom`/`select`/`notify`. |
| `test/seams/service-wiring.test.ts` | seam | Service publication at load and session binding through the real `index.ts` wiring. The UI stub gains `onTerminalInput`/`getEditorText`. Session-start context carries `isProjectTrusted`. |
| `test/print-mode.test.ts` | edit | The headless UI stub gains `onTerminalInput`/`getEditorText`, which the fleet list needs at `session_start`. Session-start context carries `isProjectTrusted`. |
| `src/seams/registry.ts` | seam | Agent registry query (`AgentTypeCatalog`, deep-frozen `AgentTypeSnapshot`) and `finalToolNames`, the single place `disallowed_tools` applies. Add `blockedToolCount`. Fallback is `general`; a missing or disabled `general` returns nothing; snapshot `source` passes `package` through. The snapshot carries `inheritSkills` only when the agent pins it. |
| `src/types.ts` | edit | `AgentConfig` gains `toolsDeclared` and `disallowedTools`. `AgentConfig.source` is `builtin`, `package`, `global` or `project`; `isDefault` and `toolGuideline` removed. `AgentConfig.inheritSkills` for the `inherit_skills: false` pin. |
| `src/config/custom-agents.ts` | edit | Parse `disallowed_tools` with `listField`, record `toolsDeclared`, debug-note tools both declared and disallowed. One loader for builtin, package, global and project sources; frontmatter `name:`; case-insensitive replacement; package files canonicalised inside the package root. Parse `inherit_skills` (`inheritSkillsField`); a non-boolean writes a debug note. |
| `src/config/agent-types.ts` | edit | Absolute fallback config sets `toolsDeclared`/`disallowedTools`. `FALLBACK_AGENT` and `MissingFallbackAgentError`; no seeded defaults; `general-purpose` alias; `findAgentConfig`; built-ins listed by `source`. |
| `src/config/default-agents.ts` | delete | The TypeScript built-in agents (`general-purpose`, `Explore`, `Plan`) are gone; built-ins are markdown files in `agents/`. |
| `test/seams/registry.test.ts` | seam | Tests for the registry query, snapshot fields, `disallowed_tools` parsing and the child allowlist. Blocked tool count and `BUILTIN_EXTENSION_TOOL_NAMES` tests. Built-in `explore`, name resolution, missing fallback. Tests for the `inherit_skills` pin, package source and non-boolean note. |
| `test/settings.test.ts` | edit | Tests for the `fleetView` setting; existing snapshot and written-file expectations include `fleetView: true`. |
| `test/ui/subagents-settings.test.ts` | edit | Tests for the `Fleet view` toggle row; the settings fixture carries `fleetView` and `toggleFleetView`. |
| `test/display.test.ts` | edit | `AgentConfig` fixtures carry the new required fields. `getDisplayName` falls back to the recorded type. |
| `test/helpers/make-agent-config.ts` | edit | Fixture builder sets `toolsDeclared`/`disallowedTools`. |
| `test/helpers/make-agent-config.test.ts` | edit | Expected default fixture includes the new fields. |
| `test/helpers/mock-session.ts` | edit | The mock extension runner lists registered tools, which a fork reads after bind. |
| `test/helpers/make-deps.ts` | edit | Disabled-agent fixture carries the new required fields. Registry fixtures hold `general`; disabled built-ins use `source: builtin`. |
| `test/helpers/subagent-session-io.ts` | edit | Default lookup config carries the new required fields. Agent lookup stub gains `findAgentConfig`. Loader stub `getSkills` returns the empty catalog; `createLoaderSettingsManager` returns `excludedExtensionPackages`. |
| `test/service/service-adapter.test.ts` | edit | Construct the adapter with a no-op agent-type catalog; the manager stub has `registerLaunchPolicy`. |
| `test/session/session-config.test.ts` | edit | `AgentConfig` fixtures carry the new required fields; inheritance tests removed with the portable plumbing. Lookup stub gains `findAgentConfig`. |
| `src/session/session-config.ts` | edit | Drops the parent system prompt, the portable prompt and the inheritance resolver; `buildAgentPrompt` returns the header only. |
| `test/lifecycle/fresh-prompt.test.ts` | seam | Real `createAgentSession` turn against a loopback provider: project instructions, append file once, `<agent>` section last, no parent identity, task as first user message. |
| `src/session/project-context.ts` | delete | Rendered the parent-side `<project_context>` for the portable prompt; Pi now builds the child's own prompt. |
| `test/session/project-context.test.ts` | delete | Tests of the deleted `project-context.ts`. |
| `src/session/fresh-prompt-extension.ts` | seam | Internal child extension: `before_agent_start` sets `sections.agent` (header + body). |
| `test/tools/spawn-config.test.ts` | edit | `AgentConfig` fixtures carry the new required fields. Thinking and mode label on `detailBase`, not in tags; `agentTags` keeps mode label, thinking, invocation tags. Built-in names, fallback note text, missing `general`. |
| `src/seams/launch-policy.ts` | seam | `LaunchPolicySlot` (one policy, fail-open consult with watchdog and run signal) and `validAdjustment`. |
| `src/seams/launch-request.ts` | seam | Build the frozen `LaunchRequest`; grantable parent tools (minus orchestration tools and excluded packages' tools). The frozen request carries `metadata` when present. |
| `src/seams/locked-launch.ts` | seam | `lockedFields`/`applyLocks`: one lock precedence for the tool and service doors, applied by the launch gate only while a policy is registered. |
| `src/seams/launch-plan.ts` | seam | `applyAdjustment`: precedence rules for model, thinking, grants and removals. `LaunchPlan.removed` lists accepted removals of defaults. |
| `src/seams/launch-gate.ts` | seam | `LaunchPolicyGate`: apply locks, request, consult, apply and resolve the policy model for one launch. Pass `removed` on `LaunchOverrides.tools`. Pass `metadata` into the launch request. Pass `excludeExtensionPackages` into the launch's excluded packages. |
| `src/seams/grant-check.ts` | seam | `checkGrants`/`enforceGrants`: keep grants the child registered with a model-callable exposure. |
| `src/tools/background-spawner.ts` | edit | Pass the launch `origin` to the manager. |
| `src/tools/foreground-runner.ts` | edit | Pass the launch `origin` to the manager. |
| `test/seams/launch-policy.test.ts` | seam | Tests for the launch policy slot, request, adjustment rules (incl. effective facts after a rewrite), fail-open and cancellation. Accepted removals and policy-changed thinking tests. Registry fixture holds `general`. |
| `test/seams/grant-check.test.ts` | seam | Tests for the in-child grant check and `grantedTools`. Tool plan carries `removed`. |
| `test/helpers/make-deps.test.ts` | edit | Spawn fixtures carry the now-required `origin`. |
| `test/lifecycle/subagent-manager.test.ts` | edit | Spawn fixtures carry the now-required `origin`. Registry fixture holds `general`; fallback launches resolve to `general`. |
| `test/tools/background-spawner.test.ts` | edit | Params carry the launch `origin`. Fallback note text names `general`. |
| `test/tools/foreground-runner.test.ts` | edit | Params carry the launch `origin`. Fallback note text names `general`. |
| `src/ui/fleet-roster.ts` | seam | Pure fleet roster and renderer: row filter, ordering, windowing and width-clamped lines. List behavior ported from tintinweb/pi-subagents 0.23.2. |
| `test/ui/fleet-roster.test.ts` | seam | Tests for the fleet roster filter, ordering, formats, layout, overflow windowing and width clamping. Registry stub gains `findAgentConfig`. |
| `src/ui/fleet-list.ts` | seam | Pi adapter for the below-editor fleet list: active and selection state, 1 s refresh timer, `fleet` widget, terminal-input listener with focus guard, and Enter opening the session pane. Key mechanics ported from tintinweb/pi-subagents 0.23.2. |
| `test/ui/fleet-list.test.ts` | seam | Tests for the fleet list's visibility, activation, navigation, focus guard, open and reselect, observer hooks, and lifecycle with a fake UI and TUI. Registry stub gains `findAgentConfig`. |
| `docs/decisions/0014-subagent-context-is-fresh-or-fork.md` | seam | ADR for `context: fresh \| fork`: supersedes ADR 0008 and amends ADRs 0006, 0009, 0010 and 0011 (status lines edited). |
| `README.md` | edit | Document `context`, the fork's tools, model and fallback rules, the cache conditions and known gaps, and the deprecated names. Launch resources, `inherit_skills`, the `session-created` fields and the `requestedCwd` worktree note in the spawn contract and Events. |
| `docs/configuration.md` | edit | `context` fields, the fresh and fork chapters and the deprecated names replace the inherited-prompt chapters. The `inherit_skills` frontmatter row and the per-launch `excludeExtensionPackages` paragraph. |
| `CHANGELOG.md` | edit | Migration section mapping each deprecated name to its replacement. |
| `docs/decisions/0006-inherited-prompt-is-identity-only.md` | edit | Status line points to ADR 0014. |
| `docs/decisions/0008-inherited-region-is-shared-parts.md` | edit | Status line points to ADR 0014. |
| `docs/decisions/0009-portable-inheritance-is-provider-scoped.md` | edit | Status line points to ADR 0014. |
| `docs/decisions/0010-project-context-is-directory-resolved.md` | edit | Status line points to ADR 0014. |
| `docs/decisions/0011-tool-surface-sections-are-session-resolved.md` | edit | Status line points to ADR 0014. |
| `docs/architecture/architecture.md` | edit | The `SpawnOptions` listing names `context` instead of the old fork flag. Current-structure diagram and layout show the markdown built-ins (`agents/`), `package-agents.ts`, and no `default-agents.ts`. History is unchanged. |
| `docs/decisions/0013-fleet-list-opens-the-session-pane.md` | seam | ADR for the fleet list: it opens the read-only session pane and lists foreground runs; the ported behavior is credited to tintinweb/pi-subagents 0.23.2. |
| `README.md` | edit | Fleet list feature bullet, the `Fleet view` row in the settings description, and a `Fleet list` section with its keys. Run facts paragraph and examples: widget bracket, inline status table and fleet rows show model, thinking and tool counts. |
| `docs/configuration.md` | edit | `fleetView` in persistent settings, its default, and the example JSON. |
| `src/ui/run-facts.ts` | seam | Pure run-facts formatter (model, thinking, tool counts) shared by every subagent row surface. |
| `test/ui/run-facts.test.ts` | seam | Tests for the run-facts formatter. |
| `src/ui/glyphs.ts` | edit | Add the `tools` and `blocked` glyphs for the run-facts parts. |
| `src/ui/agent-widget.ts` | edit | `toWidgetAgent` carries the record's `thinkingLevel` and `toolFacts` into the widget snapshot. |
| `src/ui/widget-renderer.ts` | edit | The `[provider/id]` tag becomes the shared run-facts tag (model, thinking, tools, blocked) after the name and mode label. |
| `test/ui/agent-widget.test.ts` | edit | Tests that the widget snapshot carries thinking and tool facts into the rendered tag. Registry fixture holds `general`. |
| `test/widget-renderer.test.ts` | edit | Tests for the run-facts tag on running and finished lines, and omission of unknown facts. Names show the recorded type; legacy types without `general`. |
| `src/session/builtin-extensions.ts` | edit | Export `BUILTIN_EXTENSION_TOOL_NAMES`, the fixed tool names the built-in extensions supply; the `supplies` predicates reuse it. Selection behavior unchanged. |
| `src/ui/display.ts` | edit | `AgentDetails` gains `modeLabel`, `thinking`, `toolCount`, `blockedToolCount`; `buildInvocationTags` no longer emits the thinking tag. `getContextLabel` replaces `getPromptModeLabel`: the label is read from the run (`fork`, `fork → fresh`), not the agent type. `getDisplayName` uses `findAgentConfig` and shows the recorded type when it does not resolve. |
| `src/tools/spawn-config.ts` | edit | `detailBase` carries `thinking`; its `tags` hold invocation tags only. The context label is set from the run, not here. Fallback to `general`; the note names it; a missing `general` returns the launch error. |
| `src/tools/helpers.ts` | edit | `buildDetails` copies the live thinking and tool facts and labels the run from its context. Guideline lines derive from the built-in agents (`- Use <name> for <description>`). |
| `src/tools/progress-stream.ts` | edit | The streamed details label the run from its context, read from the record. |
| `src/tools/background-spawner.ts` | edit | A background launch labels the run from its record's context and fallback, and reports a missing record as an error. |
| `src/persisted-record.ts` | edit | The `subagents:record` entry gains optional `context` and `contextFallback`, written only when set; an entry without them reads as fresh. |
| `test/persisted-record.test.ts` | edit | Tests the writer's context fields and the reader's fresh default for older entries. |
| `src/tools/agent-tool.ts` | edit | A background resume passes the resumed run's context to the launch report. |
| `src/ui/agent-widget.ts` | edit | `toWidgetAgent` carries the record's `context` and `contextFallback` into the widget snapshot. |
| `src/ui/session-navigation.ts` | edit | The navigator heading takes its context label from the live record. Persisted runs carry no context, so their heading shows none. |
| `test/helpers/make-navigable.ts` | edit | Fixture carries `context` and `contextFallback`. |
| `src/tools/progress-stream.ts` | edit | Streamed updates carry the record's live thinking and tool facts. |
| `src/tools/result-renderer.ts` | edit | `renderStats` places mode label, thinking and tool parts in the existing order. |
| `test/tools/result-renderer.test.ts` | edit | Run-facts order tests; thinking comes from `details.thinking`. |
| `test/tools/helpers.test.ts` | edit | `buildDetails` copies thinking and tool facts. Derived guideline lines and effective-agent lists. |
| `test/tools/progress-stream.test.ts` | edit | Streamed update uses the record's live thinking. |
| `src/config/deprecations.ts` | seam | One-shot deprecation warnings (once per session, once per file per load) for the `context` aliases. |
| `src/config/invocation-config.ts` | edit | `context: fresh \| fork` replaces the boolean fork flag; the old `locked` entry and caller parameter read as `context` (deprecated aliases). |
| `src/lifecycle/parent-snapshot.ts` | edit | Snapshot carries the parent session id, live branch (fork only), active tool names and thinking; the text parent context and portable prompt are removed. |
| `src/runtime.ts` | edit | `buildSnapshot(context)` with the parent's active tools; no prompt-options capture. |
| `src/session/prompts.ts` | edit | Fresh prompt: `composeAgentSection(header, body)` and the `<active_agent>`/env header; the inherited-identity machinery is removed. |
| `test/config/agent-types.test.ts` | edit | Follows the `promptMode` removal. Registry semantics: no seeded defaults, alias, `findAgentConfig`, missing fallback. |
| `test/config/custom-agents.test.ts` | edit | Cover `context`, the deprecated aliases and their warnings. Sources, case-insensitive overrides, frontmatter names, package containment. |
| `test/config/invocation-config.test.ts` | edit | Cover `context` resolution and the deprecated aliases. |
| `test/config/deprecations.test.ts` | edit | Cover visible deprecation warnings and their dedup scopes. |
| `test/helpers/make-spawn-config.test.ts` | edit | Fixture carries `context`/`contextSource`. Fallback note text names `general`. |
| `test/helpers/make-spawn-config.ts` | edit | Fixture carries `context`/`contextSource`. |
| `test/helpers/make-subagent.ts` | edit | Fixture carries `context`/`contextSource`. |
| `test/helpers/subagent-session-io.test.ts` | edit | Follows the `promptMode` removal. |
| `test/lifecycle/parent-snapshot.test.ts` | edit | Session id, live branch, tool names and thinking; no text parent context. |
| `test/lifecycle/subagent.test.ts` | edit | Execution carries `context`/`contextSource`. Adds the `waitForRunEnd` and `onQuestionAsked` tests. |
| `test/runtime.test.ts` | edit | `buildSnapshot(context)` passes the parent's active tools. |
| `test/session/prompts.test.ts` | edit | Follows the `promptMode` removal. |
| `test/types/public-context.test.ts` | seam | Type check that the public entry exports `ContextMode` and the `context` fields. |
| `src/lifecycle/fork-guard.ts` | seam | Fork child extension: forces the parent's system prompt each run, refuses calls outside the callable set, sets the session headers and payload cache keys to the parent id; the callable-set rule. |
| `src/lifecycle/fork-session.ts` | seam | Pure fork plan: parent branch, synthetic results for pending calls, the `<subagent_instructions>` message. |
| `src/lifecycle/fork-stubs.ts` | seam | Refusing stubs that declare the parent tools the fork's own registry cannot build. |
| `src/session/fork-session-manager.ts` | seam | Create a fork's session file with its own header and the copied parent entries. |
| `src/lifecycle/subagent-session.ts` | edit | `firstMessage` replaces the first run's prompt (was the text parent-context prefix); keeps the fork guard state. |
| `src/session/context.ts` | edit | `buildParentContext` removed; `extractText` kept. |
| `src/session/model-resolver.ts` | edit | Fork branch in `resolveInvocationModel`; `resolveForkThinking`. |
| `test/helpers/stub-ctx.ts` | edit | Snapshot fixture carries `sessionId`, `branch`, `toolNames`. |
| `test/lifecycle/fork-prompt.test.ts` | seam | Real SDK fork against a loopback provider: byte-identical system message and tools, prefix extended, prompt kept on a second turn, own session id, parent id in headers. |
| `test/lifecycle/fork-session.test.ts` | seam | Tests for the pure fork plan. |
| `test/session/fork-session-manager.test.ts` | seam | Tests for the fork's session file: ids, files, compaction replay. |
| `test/lifecycle/fork-tools.test.ts` | seam | Fork callable set, guard handlers, fork grants, the factory's fork path and fork model/thinking. Verifier fork refuses edits. |
| `test/lifecycle/subagent-session.test.ts` | edit | `firstMessage` replaces the parent-context prefix tests. |
| `test/session/context.test.ts` | edit | `buildParentContext` tests removed. |
| `test/session/model-resolver.test.ts` | edit | Fork model and thinking precedence. |
| `agents/general.md` | add | The built-in `general` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `agents/implementer.md` | add | The built-in `implementer` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `agents/explore.md` | add | The built-in `explore` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `agents/scout.md` | add | The built-in `scout` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `agents/reviewer.md` | add | The built-in `reviewer` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `agents/verifier.md` | add | The built-in `verifier` role agent, loaded as `builtin` from the manifest; role-only body, no skill, slash command or workflow. |
| `src/config/package-agents.ts` | add | Reduced port of tintinweb/pi-subagents 0.26.1 `package-resources.ts` (commit `9a1b37dff9c6626a48912d23efabfa13e3c53ddb`): configured-package listing, canonical containment, project-trust seeding. |
| `test/config/package-agents.test.ts` | add | Package discovery through an injected lister and the real `SettingsManager`/`DefaultPackageManager`, with trust seeding. |
| `test/config/builtin-agents.test.ts` | add | Built-in roster, tool boundaries, body scan and packed file list. |
| `test/helpers/builtin-config.ts` | add | Fixture: the real built-in agent config. |
| `test/helpers/make-registry.ts` | add | Fixture: a registry that always holds an enabled `general`. |
| `test/tools/get-result-tool.test.ts` | edit | Registry fixture holds `general`. |
| `docs/comparison-with-upstream.md` | edit | Role agents and the `pi.subagents.agents` package manifest listed as fork features, not common ground. |
| `README.md` (role agents) | edit | Case-insensitive bullet and custom-agent bullet name role agents and the package manifest; `spawn` contract documents the `general` fallback and the missing or disabled `general` refusal. |
| `src/tools/get-result-renderer.ts` | edit | Comment sample uses the `explore` agent name. |
| `src/config/custom-agents.ts` (malformed frontmatter) | edit | A file whose frontmatter fails to parse is logged and skipped instead of throwing. |
| `src/config/package-agents.ts` (header) | edit | Header comment describes the per-session package listing cache. |
| `src/service/service.ts` (comments) | edit | Examples use `general` / `explore`. |
| `docs/configuration.md` (package entries) | edit | Documents that `agents` entries must be sub-directories of the package. |
| `test/config/custom-agents.test.ts` (malformed frontmatter) | edit | Malformed package and global files are skipped. |
| `test/helpers/builtin-config.ts` (hermetic) | edit | Global agent dir pinned to an empty path. |
| `src/seams/launch-metadata.ts` | seam | `parseLaunchMetadata` and `METADATA_LIMITS`: validate and freeze the caller's metadata map. Error text escapes DEL and C1 control characters that `JSON.stringify` leaves raw. |
| `src/seams/child-sessions.ts` | seam | Process-wide child-session registry on `globalThis` (`enterChildSession`, `leaveChildSession`, `lookupChildSession`). |
| `test/seams/launch-metadata.test.ts` | seam | Tests for metadata validation, limits and freezing. |
| `test/seams/child-sessions.test.ts` | seam | Tests for the child-session registry, shared across module instances. |
| `test/seams/public-types.test.ts` | seam | Type-level check that `PublishedLaunchIdentity` is exported by name with optional `metadata`. Adds the `SUBAGENT_EVENTS` test. |
| `test/seams/launch-metadata-flow.test.ts` | seam | Metadata through the real service: events, records, requests, persistence, child-session lookup lifetime. Adds the asked and update tests through real tools. |
| `test/readme-contract.test.ts` | seam | The README states metadata visibility and has the `childSession` contract. Launch resources, `requestedCwd` and the `inherit_skills` pin. |
| `src/lifecycle/workspace.ts` | edit | `WorkspacePrepareContext` carries `requestedCwd` and `metadata` when the launch has them. |
| `src/session/package-exclusions.ts` | edit | `excludedPackageUnion` (setting entries, then launch entries) and `noteUnknownPackages` for entries matching no package. |
| `src/seams/launch-resources.ts` | seam | Per-launch resources: parse and validate, freeze, effective skill choice, fresh-only refusal, run-start re-check. |
| `src/session/launch-skills.ts` | seam | Skill loader options, catalog collision check and the child's resource facts. |
| `test/lifecycle/launch-resources-prompt.test.ts` | seam | Child prompt and skill catalog per launch resource: cwd, context files, pins, late discovery. |
| `test/seams/launch-resources-extensions.test.ts` | seam | Per-launch extension exclusion and the unknown-package note. |
| `test/seams/launch-resources-flow.test.ts` | seam | Launch resources through the real service: refusals, fresh-only fallback, run-start re-check, policy cannot change them. |
| `test/seams/launch-resources.test.ts` | seam | Tests for launch resource parsing, refusals, freezing and the run-start re-check. |
| `test/session/launch-skills.test.ts` | seam | Tests for skill loader options, the collision check and the resource facts. |
| `src/lifecycle/subagent-run.ts` | edit | `RunOutcome.question` keeps the recorded question after `replaced`; `finished` promise and idempotent `markFinished`, resolved at every terminal transition. Per-run `structuredResult`; `structuredResultError` is derived from the run's stored value, its own pending question and submission attempts. |
| `src/observation/composite-subagent-observer.ts` | edit | Dispatch `onSubagentQuestion` to every observer. |
| `test/lifecycle/subagent-run.test.ts` | edit | Tests for `RunOutcome.question` and `finished`/`markFinished`. Tests for per-run structured outcome and error kinds. |
| `test/observation/composite-subagent-observer.test.ts` | edit | Tests that `onSubagentQuestion` dispatches to every observer. |
| `test/observation/subagent-events-observer.test.ts` | edit | Tests for `subagents:asked`, the update's `toolCallId`/`metadata`, and the absent-field omission. Tests that no structured keys are emitted without a schema. |
| `test/service/service-wait.test.ts` | add | Tests for `SubagentsService.wait`: outcomes, queue, abort, claims, concurrent waiters and resume races. |
| `src/seams/result-schema.ts` | add | Structured results: parse and freeze the `resultSchema` subset (refusals name the keyword and JSON Pointer) and `validateResult`, the executor's own validator. |
| `src/session/submit-result-tool.ts` | add | The `submit_result` child protocol tool: validates `result` (after asking the sink whether the run already holds one), stores the first valid value on the run through the `StructuredResultSink` object (`hasResult`/`submit`), returns `terminate` for a valid submission. |
| `src/lifecycle/subagent.ts` | edit | Carries the launch's `resultSchema` into each run; ends a run on a valid submission after the current turn; `complete()` settles a stored value as `completed` even on the turn limit. |
| `src/lifecycle/subagent-session.ts` | edit | Counts `submit_result` attempts from tool events; installs one `finishTurn` wrapper per run (restored in `finally`) that ends the turn loop and aborts the session run (not the run's lever) when a result is held or the turn budget's ceiling turn completed, so no queued steer or follow-up starts another turn and no provider request is aborted by the budget stop (the turn-budget decision moves from `turn_end` to that hook). A turn forced past the ceiling still aborts at `turn_start`. `endRunAtTurnBoundary` drops its unused `tracker` parameter. |
| `src/lifecycle/create-subagent-session.ts` | edit | Installs `submit_result` beside `ask_parent` and `notify_parent` when the launch has a schema; With a schema, `disallowed_tools` and policy removals cannot remove it (without one the name is an ordinary tool); counted as the child's own tool. |
| `src/lifecycle/subagent-manager.ts` | edit | Forwards the launch's `resultSchema` to the execution. |
| `src/observation/notification.ts` | edit | Carries `structuredResult` and `structuredResultError` on the completed, failed and resumed payloads when set. |
| `src/seams/launch-request.ts` | seam | `submit_result` is owned, so it never appears in `toolSet.parentTools`. |
| `src/service/service.ts` | edit | `SpawnOptions.resultSchema`; `SubagentRecord.structuredResult` and `structuredResultError`. |
| `src/service/service-adapter.ts` | edit | `spawn` parses the schema before the session check and throws on a `fork` context before the policy; the snapshot carries the structured fields. |
| `test/seams/result-schema.test.ts` | add | Tests for the schema subset, refusals, annotations, frozen copy and validator. |
| `test/session/submit-result-tool.test.ts` | add | Tests for `submit_result` validation, coercion, first-valid-wins and the error result. |
| `test/lifecycle/structured-result-loop.test.ts` | add | Tests for the turn loop: submit alone, submit beside other tools, one model request after a valid submission. |
| `test/seams/structured-result-flow.test.ts` | add | Structured results through the real service: refusals, events, invalid-then-valid, missing, persistence. |
| `test/lifecycle/create-subagent-session.test.ts` | edit | Tests for the schema-installed `submit_result`, tool count and protected removal. |
| `test/lifecycle/fork-tools.test.ts` | edit | A launch with a schema installs `submit_result` through the factory; a fork child is not given it. |
| `test/lifecycle/subagent-session.test.ts` | edit | Tests for per-call submit attempt counting and the `finishTurn` wrapper restore. |
| `test/lifecycle/subagent.test.ts` | edit | Tests for settlement with a stored value, the turn limit, external stops and resumes. |
| `test/observation/notification.test.ts` | edit | Tests that structured fields appear on the payloads only when set. |
| `test/persisted-record.test.ts` | edit | Tests that structured fields are not persisted. |
| `test/seams/launch-policy.test.ts` | edit | `submit_result` excluded from `parentTools` and protected from `removeTools`. |
| `scripts/sync-upstream.sh` | add | Split an upstream tag with `git subtree split`, merge it, list conflicts and print the `UPSTREAM.md` values to update. |
| `test/upstream.test.ts` | add | Guard: every path changed since the upstream split commit has a row here (`rollup.dts.config.mjs` included), other changed files outside `docs/` and `openspec/` are named in the fork-files paragraph; `LICENSE` is upstream's; `NOTICE.md` credits; `verify:public-types` probes the `package.json` name. |
| `test/service/service-adapter.test.ts` | edit | Tests for schema refusals before session and policy, and the record snapshot fields. |
| `src/service/service.ts` (package name) | edit | Usage comment imports `@ttdua/pi-subagents`; `SERVICE_KEY` keeps the upstream name, with a comment on why (the shared slot consumers look up). |
| `src/index.ts` (package name) | edit | Usage comment imports `@ttdua/pi-subagents`. |
| `src/layered-settings.ts` | edit | Doc comment names pi extensions in general and imports `@ttdua/pi-subagents/settings`. |
| `rollup.dts.config.mjs` | edit | Comment no longer names `@gotgenes/pi-*` extensions. |
| `dist/public.d.ts`, `dist/settings.d.ts` (package name) | edit | Regenerated by `build:types` after the comment renames. |
| `test/release.test.ts` | add | Release check: `package.json` `version` is the newest fork `CHANGELOG.md` entry, README install commands pin `@v<version>`, bun is pinned once in `packageManager` (matching `engines.bun`) and workflows read it from there. |
| `package.json` (release) | edit | Pin bun in `packageManager` and add `engines.bun`. |
| `src/service/service.ts` (turn limit) | seam | `LaunchRequest.requested.maxTurns` and `LaunchAdjustment.maxTurns` for the launch policy's raise. |
| `src/seams/launch-request.ts` (turn limit) | seam | Freezes `requested.maxTurns` from the caller, the agent, `defaultMaxTurns` or a service launch. |
| `src/seams/launch-policy.ts` (turn limit) | seam | `validAdjustment` accepts a positive safe integer `maxTurns`; other values are refused. |
| `src/seams/launch-plan.ts` | seam | Raise-only `maxTurns`: applied only above `requested.maxTurns`, never for an unlimited launch or a locked `max_turns`. |
| `src/seams/launch-gate.ts` (turn limit) | seam | `requested.maxTurns` via `resolveTurnLimits`; `LaunchOverrides.maxTurns` carries the applied limit. |
| `src/lifecycle/subagent.ts` (turn limit) | edit | `turnLimits` uses the launch's `maxTurns` override. |
| `test/seams/launch-policy.test.ts` (turn limit) | seam | Tests for the raise-only limit: raises, refusals, locks, resumes, malformed values. |
| `README.md` (launch policy turn limit) | edit | Launch policy line names the turn limit; turn budget section states the raise-only rule and `turnBudget.maxTurns`. |
| `dist/public.d.ts` (turn limit) | seam | Regenerated by `build:types`; `LaunchRequest.requested.maxTurns` and `LaunchAdjustment.maxTurns`. |
| `docs/configuration.md` (max_turns precedence) | edit | Precedence of `max_turns` includes the launch policy raise and the locked-field block. |
| `src/herdr/cli.ts` | add | Herdr command port: `HerdrCli` over `pi.exec` with 2 s timeout, and the serial `HerdrQueue`. |
| `src/herdr/json.ts` | add | Defensive JSON narrowing helpers for `hc` and `herdr-app` output. |
| `src/herdr/detect.ts` | add | `detectHerdr`: decides whether the session runs in a Herdr terminal shown by Herdr. |
| `test/herdr/cli.test.ts` | add | Tests for the exec port result mapping and `HerdrQueue` ordering, failure and close. |
| `test/herdr/detect.test.ts` | add | Tests for Herdr detection scenarios and malformed output. |
| `test/herdr/fake-cli.ts` | add | `FakeHerdrCli` test double recording calls and scripting replies. |
| `src/herdr/viewer.ts` | add | Standalone read-only transcript viewer Herdr runs per subagent (node: built-ins only). |
| `src/herdr/frame-protocol.ts` | add | Viewer ↔ Pi NDJSON message types and parsers, input framer and frame sanitizer (node: built-ins only). |
| `test/herdr/frame-protocol.test.ts` | add | Tests for frame round-trips, bounds, split chunks, input framing and sanitizing. |
| `test/herdr/viewer.test.ts` | add | Tests for viewer argument parsing, JSONL line splitting and entry rendering. |
| `test/herdr/viewer.integration.test.ts` | add | Runs the real viewer file under the runtime: follow, rewrite, status, input discard, parent exit. |
| `src/herdr/column.ts` | add | `ViewerColumn`: viewer placement in a right-hand column with waiting FIFO, via `herdr-app`. |
| `test/herdr/column.test.ts` | add | Tests for column placement, focus restore, overflow, park and peek retry. |
| `test/herdr/fake-herdr-app.ts` | add | `FakeHerdrCli` preset following a mutable pane model of `herdr-app`. |
| `src/herdr/runtime.ts` | add | `viewerRuntime`: picks the program that runs `viewer.ts` directly (Bun, Node ≥ 22.18, else `node`). |
| `src/herdr/status-files.ts` | add | `ViewerStatusFiles`: atomic per-viewer running/done status files under the tmp dir. |
| `src/herdr/viewer-process.ts` | add | `ViewerProcesses`: start, liveness and end of viewer terminals through `hc`. |
| `src/herdr/viewer-registry.ts` | add | `ViewerRegistry`: known viewers by key and by transcript path. |
| `src/herdr/output-file-poller.ts` | add | `OutputFilePoller`: reports when a record first has an `outputFile`. |
| `src/herdr/herdr-observer.ts` | add | `HerdrViewers` lifecycle observer (sole queue owner) and `HerdrViewersSlot`. |
| `test/herdr/runtime.test.ts` | add | Tests for viewer runtime selection across Bun, Node versions and single binaries. |
| `test/herdr/status-files.test.ts` | add | Tests for atomic status writes and status dir removal. |
| `test/herdr/viewer-process.test.ts` | add | Tests for `hc run` argv, name sanitizing, retry, liveness and end order. |
| `test/herdr/output-file-poller.test.ts` | add | Tests for output file polling, unwatch and timer lifetime. |
| `test/herdr/herdr-observer.test.ts` | add | Scenario tests for viewer lifecycle, sessions `open`, ordering, failures and dispose. |
| `src/herdr/activate.ts` | add | `activateHerdrViewers` and `HerdrActivation`: build the Herdr observer after detection and own its per-session lifetime. |
| `test/herdr/activate.test.ts` | add | Tests for activation, viewer path and the session generation guard. |
| `docs/decisions/0015-subagent-viewers-in-a-herdr-column.md` | seam | ADR for the Herdr viewer column; `/subagents:sessions` may open a Herdr viewer, the fleet list is unchanged. |
| `docs/decisions/0013-fleet-list-opens-the-session-pane.md` | edit | Status line points to ADR 0015. |
| `README.md` (Herdr) | edit | `Herdr` section: the viewer column, detection rule, `/subagents:sessions` inside Herdr and runtime limits. |
| `CHANGELOG.md` (Herdr) | edit | Unreleased entry for the Herdr viewer column. |
| `docs/comparison-with-upstream.md` (Herdr) | edit | Herdr viewer column listed among fork features. |
