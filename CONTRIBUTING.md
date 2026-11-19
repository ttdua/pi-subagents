# Contributing

Tooling runs through bun; the version is pinned once in `package.json` `packageManager`, and CI reads it from there.

```bash
bun install
bun run lint && bun run lint:md && bun run check && bun run test && bun run verify:public-types
```

Behavior changes go through OpenSpec (`openspec/changes/<name>/`), and every edit to a file that exists upstream needs a row in `UPSTREAM.md`. See `AGENTS.md`.

## Releasing

`test/release.test.ts` keeps the version, the changelog and the README install command in step; `bun run test` fails when they drift.

1. Bump `version` in `package.json` (semver; this fork restarted at `0.1.0`).
2. Add a `## [<version>](https://github.com/ttdua/pi-subagents/releases/tag/v<version>) (<date>)` entry at the top of `CHANGELOG.md`, above the upstream history heading.
3. Update the install command in `README.md` to `pi install git:github.com/ttdua/pi-subagents@v<version>`.
4. Run the checks above, then merge the release commit to `main`.
5. Tag the merged commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

The `Release` workflow reruns CI on the tag, checks that the tag matches `package.json`, and creates the GitHub release with the changelog entry as its notes.
