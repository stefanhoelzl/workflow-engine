## MODIFIED Requirements

### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at `infrastructure/Dockerfile` that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies, run per-package Vite builds for the sandbox and runtime (`pnpm --filter @workflow-engine/sandbox exec vite build`; `pnpm --filter @workflow-engine/runtime exec vite build`), and deploy production dependencies via `pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy`. The runtime's built artefacts (`packages/runtime/dist/*`) SHALL be copied into `/app/deploy/`. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain only `/app/deploy` (with the bundled JS + shamefully-hoisted `node_modules/` with native DuckDB + quickjs-wasi bindings + patched `fetch-blob`).

The image SHALL NOT contain workflow bundles baked into the filesystem. Workflows are uploaded at runtime per tenant via `POST /api/workflows/<tenant>` and persisted through the `StorageBackend` to `workflows/<tenant>.tar.gz` (per `multi-tenant-workflows`). The image SHALL NOT set any `WORKFLOW_DIR` environment variable — that variable no longer exists.

The sandbox workspace's build step SHALL run separately because the sandbox's `dist/src/worker.js` is loaded from disk at runtime via `new Worker(pathToFileURL(...))` (see `resolveWorkerUrl()` in `packages/sandbox/src/index.ts`).

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
