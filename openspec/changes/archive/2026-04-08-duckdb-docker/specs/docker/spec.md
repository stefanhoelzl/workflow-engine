## MODIFIED Requirements

### Requirement: Multi-stage Dockerfile produces a minimal production image

The repository SHALL contain a `Dockerfile` at the root that uses a multi-stage build. The build stage SHALL use `node:24-slim` with corepack-enabled pnpm to install dependencies, run the Vite build, and deploy production dependencies via `pnpm deploy --prod` into the build output directory. The production stage SHALL use `gcr.io/distroless/nodejs24-debian13` and contain the bundled JS output alongside a `node_modules/` directory with native dependencies.

#### Scenario: Build produces a working image

- **WHEN** `docker build -t workflow-engine .` is run from the repository root
- **THEN** the build SHALL complete successfully
- **AND** the resulting image SHALL contain the bundled JS file, `node_modules/` with production dependencies, and the Node.js runtime

#### Scenario: Image runs the runtime

- **WHEN** the built image is started with the required environment variables set
- **THEN** the container SHALL start the Node.js process with the bundled entry point
- **AND** native dependencies (DuckDB) SHALL be resolvable from `node_modules/`
- **AND** the runtime SHALL accept HTTP requests on the configured port
