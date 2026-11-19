# AGENTS.md

`@ttdua/pi-subagents`: a fork of `@gotgenes/pi-subagents` (see `UPSTREAM.md`, `NOTICE.md`).

- Tooling: `bun` (`bun install`, `bun run check`, `bun run test`, `bun run verify:public-types`).
- Behavior specs live in `openspec/specs/` (OpenSpec, `superspec` schema); plan changes as `openspec/changes/<name>/` with `/opsx-*`, not ad-hoc plan or design files. `openspec validate --all` must pass.
- Every edit to a file that exists upstream needs a row in `UPSTREAM.md` (file, kind, one-line reason).
- Built-in agents live in `agents/*.md` (declared under `pi.subagents.agents`); no agent is defined in code, and their bodies stay flow-neutral (no skill, slash command or workflow names).
- The published service keeps `implementation: "@ttdua/pi-subagents"`; consumers such as `@ttdua/pi-jev-pilot` detect it by capability (`registerLaunchPolicy`, `listAgentTypes`).
