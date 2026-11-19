# upstream-provenance Specification

## Purpose
The package is a fork of `@gotgenes/pi-subagents` with recorded upstream provenance and credits, and publishes one service per process that consumers can identify.

## Requirements

### Requirement: Upstream provenance
`UPSTREAM.md` SHALL record the upstream repository, the package path in it, the upstream release tag, the upstream commit and the upstream split commit the fork was last synced from. It SHALL list every local change to an upstream file with a one-line reason. A path under `src/`, `test/`, `agents/`, `scripts/` or `dist/`, or `package.json`, `tsconfig.json` or `rollup.dts.config.mjs`, that differs from the upstream split commit without a row in `UPSTREAM.md` MUST fail a repository test. The split commit SHALL be read from `UPSTREAM.md`, not from a constant.

#### Scenario: Initial provenance
- **WHEN** `UPSTREAM.md` is read
- **THEN** it names `gotgenes/pi-packages`, `packages/pi-subagents`, the tag of release `25.0.5`, its commit and the split commit

#### Scenario: Unlisted edit detected
- **WHEN** an upstream file differs from the recorded upstream split commit and `UPSTREAM.md` does not list it
- **THEN** the repository test fails and names that file

### Requirement: Upstream license kept
The package SHALL keep upstream's `LICENSE` file unchanged. `NOTICE.md` SHALL name the package's upstream, its authors as stated in upstream's license and its license (`MIT`). When code is ported from another project, `NOTICE.md` SHALL also name that project, the version ported from, its authors as stated in its license and its license.

#### Scenario: Notice entry
- **WHEN** `NOTICE.md` is read
- **THEN** it has an entry for `packages/pi-subagents` naming `gotgenes/pi-packages` and `MIT`

#### Scenario: Ported fleet list credited
- **WHEN** `NOTICE.md` is read after the fleet list is added
- **THEN** it names `tintinweb/pi-subagents`, version `0.23.2` and `MIT` for the fleet list behavior

### Requirement: Published declarations checked
The `verify:public-types` script SHALL pack the package and type-check an external consumer, which imports the package name read from `package.json`, against its packed declarations. The CI workflow SHALL run it as the final step of the job that runs `bun run test`. The `test` script MUST NOT run it.

#### Scenario: CI checks the published declarations
- **WHEN** the CI workflow is read
- **THEN** the job that runs `bun run test` ends with a step that runs `bun run verify:public-types`

#### Scenario: Public types check passes on the committed tree
- **WHEN** `bun run verify:public-types` runs on the committed tree
- **THEN** it packs `@ttdua/pi-subagents`, type-checks the consumer probe against the packed declarations and exits with code 0

### Requirement: Service identity and ownership
The executor's published service SHALL carry `implementation` `"@ttdua/pi-subagents"` and the `sessionId` of the session whose extension instance published it. An instance SHALL publish its service when it loads, as upstream does, so consumers that read the service at load time (such as `@gotgenes/pi-subagents-worktrees`) keep working, but only when the slot does not already hold a service whose `implementation` is `@ttdua/pi-subagents`. The main session's instance loads before any child's, so children never replace it. Its `sessionId` SHALL be set at the instance's first `session_start`. An instance SHALL remove the service at shutdown only when the published service is still its own.

#### Scenario: Children do not replace the main service
- **WHEN** a main session starts, and two children are created and disposed
- **THEN** the service on `globalThis` is still the main session's, with `implementation` `@ttdua/pi-subagents`

#### Scenario: Load-time consumer finds the service
- **WHEN** a companion extension reads the service while it loads, after the executor loaded
- **THEN** it finds the executor's service and can register its workspace provider

#### Scenario: Published before capture
- **WHEN** a main session starts, and again after a reload
- **THEN** a consumer's `session_start` handler (for example `@ttdua/pi-jev-pilot`) finds the service on `globalThis` and can register its launch policy

#### Scenario: Shutdown removes only its own service
- **WHEN** an instance shuts down while another instance's service is published
- **THEN** the other instance's service stays published
