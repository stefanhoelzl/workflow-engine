## ADDED Requirements

### Requirement: Build-only subcommand

The `wfe` binary SHALL expose a `build` subcommand that performs the same build pipeline as `wfe upload` (`packages/sdk/src/cli/build.ts`'s `build({ cwd })`) without performing any network I/O, authentication, or target-URL resolution.

The `build` subcommand SHALL share a single `build()` implementation with the `upload` subcommand. The build phase of `wfe upload` and the entire operation of `wfe build` SHALL invoke the same function; there SHALL be no parallel implementations of the bundle build.

The `build` subcommand SHALL exit with status `0` when the bundle at `<cwd>/dist/bundle.tar.gz` is produced successfully and with status `1` on any build error. On build failure, stderr SHALL include the same `no workflows found in src/` message as `wfe upload` when no workflow entry files are present.

The `build` subcommand SHALL NOT accept or require `--url`, `--tenant`, `--user`, `--token`, or read `GITHUB_TOKEN`. Passing any authentication-related flag or environment variable SHALL have no effect on its behaviour.

#### Scenario: Build subcommand produces bundle

- **WHEN** `wfe build` is invoked in a directory containing `src/foo.ts`
- **THEN** the CLI SHALL produce `<cwd>/dist/bundle.tar.gz` containing `manifest.json` and `foo.js` at the tarball root
- **AND** exit with status `0`
- **AND** SHALL NOT issue any HTTP request

#### Scenario: Build subcommand performs no authentication

- **GIVEN** `GITHUB_TOKEN=ghp_xxx` is set in the environment
- **WHEN** `wfe build` is invoked
- **THEN** no HTTP request SHALL be issued (the token is ignored by design)

#### Scenario: Build subcommand fails on missing workflows

- **WHEN** `wfe build` is invoked in a directory where `src/` does not exist or contains no top-level `.ts` files
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include `no workflows found in src/`

#### Scenario: Build subcommand and upload share build implementation

- **WHEN** inspecting the CLI source
- **THEN** both the `build` subcommand and the build phase of the `upload` subcommand SHALL invoke the single exported `build()` function from `packages/sdk/src/cli/build.ts`
- **AND** neither path SHALL duplicate the vite-plugin invocation

#### Scenario: pnpm -r build exercises the workflow bundle build

- **GIVEN** `workflows/package.json` declares `"build": "wfe build"`
- **WHEN** `pnpm -r build` is invoked from the monorepo root
- **THEN** pnpm SHALL build `@workflow-engine/sdk` before the `workflows` package
- **AND** the `workflows` build SHALL invoke `wfe build`
- **AND** a broken `workflows/src/demo.ts` or regressed SDK surface SHALL cause `pnpm -r build` to exit non-zero
