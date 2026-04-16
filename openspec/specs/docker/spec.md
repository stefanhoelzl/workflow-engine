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
