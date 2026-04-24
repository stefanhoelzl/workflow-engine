# runtime-build Specification

## Purpose
TBD - created by archiving change cleanup-specs-structure. Update Purpose after archive.
## Requirements
### Requirement: Runtime Vite SSR build

The runtime workspace (`packages/runtime/`) SHALL provide a `vite.config.ts` that configures an SSR build taking `src/main.ts` as the entry point and emitting a bundle to `dist/`. The config SHALL target Node (`ssr.target = "node"`) and SHALL inline every non-external dependency (`ssr.noExternal = true`). The config SHALL compose the sandbox vite plugins via `sandboxPlugins()` from `@workflow-engine/sandbox/vite` so per-plugin `?sandbox-plugin` transforms produce their dual worker/guest bundles as part of the runtime build.

#### Scenario: Runtime build emits dist/main.js

- **WHEN** `pnpm build` is run in the repository root (triggering `pnpm -r build`)
- **THEN** `packages/runtime/dist/main.js` SHALL be produced
- **AND** the file SHALL be executable by Node.js with a `node_modules/` tree containing the externalized native dependencies

#### Scenario: Pure JS dependencies are inlined

- **WHEN** the built `packages/runtime/dist/main.js` is inspected
- **THEN** it SHALL NOT contain `require(...)` or ESM `import` statements for pure-JS npm packages such as `hono` or `@hono/node-server`

### Requirement: Native-binding externalization

The runtime Vite config SHALL list every package whose distribution carries a native binding in `ssr.external` so those packages remain as external references in the output bundle rather than being inlined. The current external list SHALL include `@duckdb/node-bindings` (the binding under `@duckdb/node-api`) and `@jitl/quickjs-wasmfile-release-sync` (the WASI artifact bundled behind `quickjs-wasi`). Adding a new dependency with a native binding SHALL require extending this list; failing to externalize a native binding SHALL cause the runtime to fail at boot with a missing-binding error.

#### Scenario: DuckDB native binding stays external

- **WHEN** `packages/runtime/dist/main.js` is inspected
- **THEN** it SHALL contain an external reference to `@duckdb/node-bindings`
- **AND** it SHALL NOT inline the binding's JS wrapper

#### Scenario: QuickJS WASI artifact stays external

- **WHEN** `packages/runtime/dist/main.js` is inspected
- **THEN** it SHALL contain an external reference to `@jitl/quickjs-wasmfile-release-sync`

### Requirement: fetch-blob pnpm patch for top-level-await strip

The root `package.json` SHALL declare a pnpm patch of `fetch-blob@4.0.0` under `pnpm.patchedDependencies`, and the patch file SHALL live at `patches/fetch-blob@4.0.0.patch`. The patch SHALL remove the module-level top-level-await block that would otherwise prevent the sandbox-stdlib web-platform plugin from bundling `fetch-blob` into the guest IIFE (per `unify-sandbox-plugin-transform`). Upgrading `fetch-blob`'s major or minor version SHALL require regenerating the patch.

#### Scenario: Patch applies on install

- **WHEN** `pnpm install` is run
- **THEN** pnpm SHALL apply `patches/fetch-blob@4.0.0.patch` to `node_modules/fetch-blob`
- **AND** the patched module SHALL have no top-level `await` at module scope

### Requirement: Per-workspace build composition

The repository root's `pnpm build` script SHALL execute `pnpm -r build`, running the per-workspace `build` script in every workspace that declares one. The runtime workspace's `build` script SHALL be `vite build`; the sandbox workspace's SHALL be `vite build`; the sdk workspace's SHALL be `tsc --build`. Workspace-build ordering SHALL follow pnpm's topological dependency order so downstream workspaces see fresh outputs from their upstream workspaces.

#### Scenario: Root build is recursive

- **WHEN** `pnpm build` is run at the repository root
- **THEN** every workspace package that declares a `build` script SHALL run its build
- **AND** outputs SHALL land in each workspace's `dist/`

### Requirement: Runtime start script

The runtime workspace's `package.json` SHALL declare a `start` script running `vite-node src/main.ts`. The `start` script SHALL NOT depend on any `WORKFLOW_DIR` environment variable (removed by `multi-tenant-workflows`); the runtime resolves tenant bundles from the configured storage backend at startup.

#### Scenario: Runtime starts via vite-node

- **WHEN** `pnpm --filter @workflow-engine/runtime start` is run
- **THEN** `vite-node` SHALL evaluate `src/main.ts`
- **AND** the Hono server SHALL begin listening on the configured `PORT`

### Requirement: Vite + Rolldown as the bundler baseline

The repository SHALL use Vite 8.x (with Rolldown as Vite's default bundler in v8) as the shared root devDependency for every workspace build. The root `package.json` `devDependencies` SHALL list `vite` at version 8.x.

#### Scenario: Vite version baseline

- **WHEN** `pnpm vite --version` is run from the repository root
- **THEN** the reported version SHALL be >= 8.0.0
- **AND** root `package.json` SHALL list `vite` in `devDependencies`

### Requirement: SDK package builds via tsc

The SDK workspace's `package.json` SHALL declare a `build` script running `tsc --build`. The build output SHALL populate the SDK's `dist/` directory, which is listed in the SDK's `files` array so the published package carries both the TypeScript source (for downstream typechecking) and the compiled JS. No shebang step is required because the SDK's `wfe` CLI is declared via `bin` and the entry is a `.js` file in `dist/`.

#### Scenario: SDK build produces dist

- **WHEN** `pnpm --filter @workflow-engine/sdk build` is run
- **THEN** `packages/sdk/dist/` SHALL be populated with compiled JS files
- **AND** the SDK's declared `bin.wfe` entry SHALL resolve to a file under `dist/`

