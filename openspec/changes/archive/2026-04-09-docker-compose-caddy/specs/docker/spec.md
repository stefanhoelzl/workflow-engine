## MODIFIED Requirements

### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at `infrastructure/Dockerfile` that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies (including the `workflows` workspace package), run the Vite build (which compiles both the runtime bundle and workflow bundles), and deploy production dependencies via `pnpm deploy --prod` into the build output directory. The build stage SHALL copy the compiled workflow bundles to `/workflows`. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain the bundled JS output alongside a `node_modules/` directory with native dependencies and the compiled workflow bundles at `/workflows`.

#### Scenario: Build produces a working image

- **WHEN** `docker build -f infrastructure/Dockerfile .` is run from the repository root
- **THEN** the build SHALL complete successfully
- **AND** the resulting image SHALL contain the bundled JS file, `node_modules/` with production dependencies, compiled workflow bundles at `/workflows`, and the Node.js runtime

#### Scenario: Image runs the runtime

- **WHEN** the built image is started with the required environment variables set
- **THEN** the container SHALL start the Node.js process with the bundled entry point
- **AND** native dependencies (DuckDB) SHALL be resolvable from `node_modules/`
- **AND** the runtime SHALL accept HTTP requests on the configured port

#### Scenario: Workflow bundles are included

- **WHEN** the built image is inspected
- **THEN** `/workflows` SHALL contain the compiled workflow JavaScript bundles
- **AND** the `WORKFLOW_DIR` environment variable SHALL be set to `/workflows`

### Requirement: Production image runs as non-root

The production stage SHALL use the distroless `nonroot` user (UID 65532) to run the Node.js process.

#### Scenario: Process runs as non-root
- **WHEN** the container is running
- **THEN** the Node.js process SHALL be running as UID 65532
