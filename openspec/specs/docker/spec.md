### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at `infrastructure/Dockerfile` that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies (including the `workflows` workspace package), run the Vite build (which compiles both the runtime bundle and workflow bundles), and deploy production dependencies via `pnpm deploy --prod` into the build output directory. The build stage SHALL copy the compiled workflow bundles to `/workflows`. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain the bundled JS output alongside a `node_modules/` directory with native dependencies and the compiled workflow bundles at `/workflows`.

The image SHALL be built by `podman build` via the `image/local` OpenTofu module, with the repo root as build context and `infrastructure/Dockerfile` as the Dockerfile path. The built image SHALL be loaded into the kind cluster via `podman save` piped to `ctr images import` inside the kind node container.

#### Scenario: Build produces a working image

- **WHEN** `tofu apply` is run
- **THEN** the image SHALL be built successfully via podman
- **AND** the resulting image SHALL be loaded into the kind cluster
- **AND** the image SHALL contain the bundled JS file, `node_modules/` with production dependencies, compiled workflow bundles at `/workflows`, and the Node.js runtime

#### Scenario: Image runs the runtime

- **WHEN** the built image is started with the required environment variables set
- **THEN** the container SHALL start the Node.js process with the bundled entry point
- **AND** native dependencies (DuckDB) SHALL be resolvable from `node_modules/`
- **AND** the runtime SHALL accept HTTP requests on the configured port

#### Scenario: Workflow bundles are included

- **WHEN** the built image is inspected
- **THEN** `/workflows` SHALL contain the compiled workflow JavaScript bundles
- **AND** the `WORKFLOW_DIR` environment variable SHALL be set to `/workflows`

### Requirement: Dockerfile USER directive

The Dockerfile SHALL use `USER 65532` (numeric UID) instead of `USER nonroot`. This is the same UID (distroless "nonroot" user) but in numeric form, which PodSecurity admission can validate statically without inspecting the image's `/etc/passwd`.

#### Scenario: Numeric UID in Dockerfile

- **WHEN** the Dockerfile is inspected
- **THEN** the `USER` directive SHALL be `65532`

#### Scenario: Container runs as non-root

- **WHEN** the container starts
- **THEN** the process SHALL run as UID 65532
- **AND** the behavior SHALL be identical to the previous `USER nonroot` directive

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
