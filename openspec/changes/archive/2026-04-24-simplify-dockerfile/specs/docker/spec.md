## ADDED Requirements

### Requirement: Dependency install layer is keyed to `pnpm-lock.yaml` alone

The `infrastructure/Dockerfile` build stage SHALL install pnpm dependencies using `pnpm fetch` against `pnpm-lock.yaml` followed by `pnpm install --offline --frozen-lockfile`. The step sequence SHALL NOT enumerate individual workspace `package.json` files as separate `COPY` instructions. Adding a new workspace package, a new top-level config file (`tsconfig.*.json`, `*.config.ts`), or renaming a source directory SHALL NOT require edits to `infrastructure/Dockerfile` or `.dockerignore` as long as the new path falls outside the `.dockerignore` denylist.

#### Scenario: Lockfile-only invalidation

- **WHEN** a developer edits source code inside any workspace package without modifying `pnpm-lock.yaml`
- **THEN** the `pnpm fetch` layer SHALL be served from the buildkit cache
- **AND** only the source-copy and install-from-store layer SHALL be re-executed

#### Scenario: New workspace package requires no Dockerfile edit

- **WHEN** a new workspace package is added under `packages/<name>/` with its own `package.json` and source tree
- **AND** `infrastructure/Dockerfile` and `.dockerignore` are left untouched
- **THEN** `podman build -f infrastructure/Dockerfile .` SHALL succeed
- **AND** the new package's workspace dependency graph SHALL be resolvable during `pnpm install --offline`

#### Scenario: Absent workspace directory is tolerated

- **WHEN** `.dockerignore` excludes a workspace member directory (e.g. `workflows/`) whose `package.json` is therefore absent from the build context
- **THEN** `pnpm install --offline --frozen-lockfile` SHALL still succeed for the workspaces that are present
- **AND** the build SHALL proceed to `pnpm -r build`

### Requirement: Workspace build via `pnpm -r build`

The Dockerfile SHALL invoke `pnpm -r build` to produce every workspace package's build output. The step SHALL rely on pnpm's topological ordering so that workspace-to-workspace dependencies (e.g. `@workflow-engine/runtime` depending on `@workflow-engine/sandbox`) are built in the correct order without explicit per-package `vite build` invocations.

#### Scenario: Topological build order

- **WHEN** `pnpm -r build` runs during stage 1
- **THEN** `@workflow-engine/sandbox`'s build SHALL complete before `@workflow-engine/runtime`'s build begins
- **AND** `packages/sandbox/dist/src/worker.js` SHALL exist on disk before `pnpm deploy --prod` runs
