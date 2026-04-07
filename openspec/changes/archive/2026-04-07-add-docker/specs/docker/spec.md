## ADDED Requirements

### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at the root that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies and run the Vite build. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain only the bundled JS output.

#### Scenario: Build produces a working image
- **WHEN** `docker build -t workflow-engine .` is run from the repository root
- **THEN** the build SHALL complete successfully
- **AND** the resulting image SHALL contain only the bundled JS file and the Node.js runtime

#### Scenario: Image runs the runtime
- **WHEN** the built image is started with the required environment variables set
- **THEN** the container SHALL start the Node.js process with the bundled entry point
- **AND** the runtime SHALL accept HTTP requests on the configured port

### Requirement: Production image runs as non-root

The production stage SHALL use the distroless `nonroot` user (UID 65532) to run the Node.js process.

#### Scenario: Process runs as non-root
- **WHEN** the container is running
- **THEN** the Node.js process SHALL be running as UID 65532
