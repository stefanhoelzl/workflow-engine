# Docker Specification

## Purpose

Define the production container image for the workflow-engine: a multi-stage Dockerfile at `infrastructure/Dockerfile` built with `podman` during local `tofu apply` and with `docker/build-push-action` in CI. Owns the build-stage / production-stage split (node:24-slim for building, distroless/nodejs24-debian13 for production), the workflow-bundle placement inside the image, and the native-dependency tree required at runtime.

## Requirements

### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at `infrastructure/Dockerfile` that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies, run workspace builds in topological order via `pnpm -r build` (which is equivalent to explicit per-package invocations but self-updates when packages are added), and deploy production dependencies via `pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy`. The runtime's built artefacts (`packages/runtime/dist/*`) SHALL be copied into `/app/deploy/`. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain only `/app/deploy` (with the bundled JS + shamefully-hoisted `node_modules/` with native DuckDB + quickjs-wasi bindings + patched `fetch-blob`).

The image SHALL NOT contain workflow bundles baked into the filesystem. Workflows are uploaded at runtime per tenant via `POST /api/workflows/<tenant>` and persisted through the `StorageBackend` to `workflows/<tenant>.tar.gz` (per `multi-tenant-workflows`). The image SHALL NOT set any `WORKFLOW_DIR` environment variable — that variable no longer exists.

The sandbox workspace's build step SHALL run separately because the sandbox's `dist/src/worker.js` is loaded from disk at runtime via `new Worker(pathToFileURL(...))` (see `resolveWorkerUrl()` in `packages/sandbox/src/sandbox.ts`).

The image SHALL be built by `podman build` via the `image/local` OpenTofu module (local dev) or by `docker/build-push-action` (CI), with the repo root as build context and `infrastructure/Dockerfile` as the Dockerfile path. For local dev, the built image SHALL be loaded into the kind cluster via `podman save` piped to `ctr images import` inside the kind node container.

#### Scenario: Build produces a working image

- **WHEN** `tofu apply` runs against the local environment
- **THEN** the image SHALL be built successfully via podman
- **AND** the resulting image SHALL be loaded into the kind cluster
- **AND** the image SHALL contain the runtime bundle, shamefully-hoisted `node_modules/` (with DuckDB + quickjs-wasi native bindings + patched fetch-blob), and the distroless Node.js runtime

#### Scenario: Image runs the runtime

- **WHEN** the built image is started with required environment variables set
- **THEN** the container SHALL start the Node.js process with the bundled entry point
- **AND** native dependencies (DuckDB, quickjs-wasi) SHALL be resolvable from the hoisted `node_modules/`
- **AND** the runtime SHALL accept HTTP requests on the configured port

#### Scenario: No workflows baked into the image

- **WHEN** the built image is inspected
- **THEN** there SHALL NOT be a `/workflows` directory
- **AND** no `WORKFLOW_DIR` ENV line SHALL be present
- **AND** workflow bundles SHALL be loaded at runtime from the configured `StorageBackend` (FS or S3) rather than the filesystem

#### Scenario: Sandbox worker artifact is built

- **WHEN** the image is built
- **THEN** `packages/sandbox/dist/src/worker.js` SHALL exist inside the build stage
- **AND** the `pnpm deploy` step SHALL include it in `/app/deploy/node_modules/@workflow-engine/sandbox/dist/src/worker.js`
- **AND** the runtime's `resolveWorkerUrl()` SHALL successfully resolve the worker file at startup

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
