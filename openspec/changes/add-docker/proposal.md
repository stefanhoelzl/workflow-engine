## Why

The runtime has no container packaging. To deploy the workflow engine anywhere beyond a local dev machine, we need a production-ready Docker image. This enables repeatable builds, immutable deployments, and compatibility with container orchestrators.

## What Changes

- Add a Vite build configuration that bundles the runtime into a single self-contained JS file (all dependencies inlined, Node.js built-ins externalized)
- Make the HTTP server port configurable via a `PORT` environment variable (default 8080)
- Add a multi-stage `Dockerfile`: build stage (`node:24-slim` + corepack/pnpm) produces the bundle, production stage (`gcr.io/distroless/nodejs24-debian13`) runs it as non-root
- Add a `.dockerignore` to keep the build context lean
- Add a `build` script to the root `package.json`

## Capabilities

### New Capabilities
- `docker`: Dockerfile, .dockerignore, and multi-stage build pipeline for producing a production container image
- `vite-build`: Vite SSR build configuration that bundles the runtime entry point and all dependencies into a single JS file

### Modified Capabilities
- `http-server`: The server port changes from hardcoded 3000 to configurable via `PORT` env var (default 8080)

## Impact

- **New files**: `Dockerfile`, `.dockerignore`, `vite.config.ts`
- **Modified files**: `packages/runtime/src/main.ts` (port config), root `package.json` (build script)
- **Dependencies**: No new runtime dependencies. Vite (already a devDependency) is used for building.
- **Environment**: Production image requires the 4 Nextcloud env vars (`NEXTCLOUD_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD`, `NEXTCLOUD_TALK_ROOM`) plus optional `PORT`
