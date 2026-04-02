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
