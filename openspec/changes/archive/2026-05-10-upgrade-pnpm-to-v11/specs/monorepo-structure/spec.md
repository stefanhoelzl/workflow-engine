## ADDED Requirements

### Requirement: Toolchain version pinning

The root `package.json` SHALL declare a `packageManager` field naming a specific pnpm version (e.g. `"packageManager": "pnpm@11.0.9"`). This pin SHALL be the single source of truth for the pnpm version across all execution environments: corepack inside the production `Dockerfile`, the `pnpm/action-setup` GitHub Action used by CI, and contributor terminals on local development machines.

The pin SHALL name a specific patch (or at minimum a specific minor) version — not a wildcard or major-only range — so that all environments resolve the *same* pnpm release deterministically. Build-tooling configuration (Dockerfile, CI action inputs, contributor docs) SHALL NOT separately declare a pnpm version that could conflict with `package.json#packageManager`; if a version arg is required by a tool that does not auto-detect `packageManager`, that tool's documentation SHALL be updated rather than introducing a parallel pin.

#### Scenario: corepack inside the Dockerfile honours the pin

- **GIVEN** root `package.json` declares `"packageManager": "pnpm@<version>"`
- **AND** `infrastructure/Dockerfile` runs `corepack enable` before invoking `pnpm`
- **WHEN** the Docker image is built
- **THEN** corepack SHALL fetch the pinned pnpm version from the npm registry
- **AND** every `pnpm` invocation in the build stage SHALL run that exact version
- **AND** the build SHALL NOT silently pick up a different version from a corepack default or the npm `latest` tag

#### Scenario: `pnpm/action-setup` reads the pin without a `version` arg

- **GIVEN** root `package.json` declares `"packageManager": "pnpm@<version>"`
- **AND** `.github/actions/setup-pnpm/action.yml` invokes `pnpm/action-setup` (a v11-aware release) without passing a `version` input
- **WHEN** any CI workflow runs the `setup-pnpm` composite action
- **THEN** the action SHALL install the pnpm version named in `packageManager`
- **AND** subsequent `pnpm` steps in the same job SHALL run that exact version

#### Scenario: a contributor terminal resolves the pinned version

- **GIVEN** root `package.json` declares `"packageManager": "pnpm@<version>"`
- **AND** a contributor has run `corepack enable` once on their machine
- **WHEN** the contributor runs any `pnpm` command in the repository
- **THEN** corepack SHALL invoke the pinned pnpm version, not whichever pnpm the contributor's PATH would otherwise resolve

#### Scenario: the pin is a single, specific version

- **WHEN** the root `package.json` is inspected
- **THEN** `packageManager` SHALL be present
- **AND** its value SHALL match the form `pnpm@<exact-version>` (e.g. `pnpm@11.0.9`), not `pnpm@*`, `pnpm@^11`, or any range
- **AND** no other configuration file in the repository (`Dockerfile`, GitHub Actions, `.npmrc`, `pnpm-workspace.yaml`, contributor docs) SHALL declare a different pnpm version
