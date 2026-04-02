## Why

The repository is an empty shell — just a README and OpenSpec config. Before any feature work can begin, the monorepo scaffolding, TypeScript configuration, and developer tooling (linting, formatting, testing) must be in place. This establishes the foundation every future change builds on.

## What Changes

- Create pnpm workspace configuration with one package to start: `runtime` (sdk and vite-plugin deferred)
- Configure TypeScript in strict mode with a shared `tsconfig.base.json` and per-package configs using project references
- Add Biome as the linter/formatter with all rules enabled
- Add Vitest with a root-level config for running tests across all packages
- Set up root `package.json` with `devEngines` for Node.js 24 (auto-download via pnpm), shared devDependencies, and workspace scripts (`lint`, `format`, `check`, `test`)
- Create `packages/runtime/src/` directory with placeholder `index.ts`
- Add Vite (latest, with Rolldown) as the build system
- Add shared dev dependencies: `typescript` 6.x, `@biomejs/biome` 2.x, `vitest` 4.x, `vite` 8.x

## Capabilities

### New Capabilities

- `monorepo-structure`: pnpm workspace configuration, package directory layout, and per-package `package.json` files
- `typescript-config`: Shared strict `tsconfig.base.json`, per-package tsconfigs with project references, type-check-only setup (`noEmit`)
- `linting-formatting`: Biome configuration with all rule groups enabled, root scripts for lint and format
- `testing-setup`: Vitest root configuration, test script wiring across the monorepo
- `build-system`: Vite with Rolldown as the build tool, installed at root as shared devDependency

### Modified Capabilities

_None — this is a greenfield setup._

## Impact

- **Dependencies**: Adds `typescript` 6.x, `@biomejs/biome` 2.x, `vitest` 4.x, `vite` 8.x as root devDependencies
- **Project root**: New files — `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- **Packages**: Creates `packages/runtime/` with `package.json`, `tsconfig.json`, and `src/index.ts`. `sdk` and `vite-plugin` deferred to later changes.
- **No runtime code**: This change is purely scaffolding. No application logic, no sandbox config, no queue implementation.
