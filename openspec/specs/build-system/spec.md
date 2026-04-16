## ADDED Requirements

### Requirement: Vite with Rolldown as build tool
The project SHALL use Vite 8.x with Rolldown as the default bundler, installed as a shared root devDependency.

#### Scenario: Vite is available
- **WHEN** a developer runs `pnpm install` and then `pnpm vite --version`
- **THEN** Vite SHALL report a version >=8.0.0

#### Scenario: Vite as shared dependency
- **WHEN** inspecting the root `package.json`
- **THEN** `vite` SHALL be listed in `devDependencies` at version 8.x

### Requirement: Per-package build configuration deferred
Individual package build configurations (entry points, output formats, plugins) SHALL NOT be part of this initial setup. Only the Vite dependency is installed.

#### Scenario: No root vite config for building
- **WHEN** inspecting the repository root
- **THEN** there SHALL be no `vite.config.ts` for build purposes (only `vitest.config.ts` for testing)

### Requirement: SDK package has a build step
The SDK package SHALL have a `build` script in `package.json` that compiles the CLI entry point to `dist/cli.js`. This uses `tsc` with a build-specific tsconfig followed by a shebang insertion script. The build output is only the CLI binary; all other SDK source is consumed as TypeScript source via workspace protocol.

#### Scenario: SDK build produces CLI binary
- **WHEN** running `pnpm build` in the SDK package directory
- **THEN** `dist/cli.js` is produced with `#!/usr/bin/env node` shebang
- **THEN** no other compiled output is required

#### Scenario: Root build includes SDK
- **WHEN** running root `pnpm build`
- **THEN** the SDK build step runs (producing `dist/cli.js`)
