## Context

The Vite SSR build is configured with `noExternal: true`, bundling all npm dependencies into a single `dist/main.js`. The Dockerfile copies only this file to a distroless runtime image. This worked when all dependencies were pure JS, but the EventStore's DuckDB dependency includes a native `.node` binary (~58MB) that cannot be bundled by Vite/Rolldown.

## Goals / Non-Goals

**Goals:**
- Make the Docker build succeed with DuckDB native bindings
- Keep the distroless runtime image
- Minimize Dockerfile complexity

**Non-Goals:**
- Switching away from DuckDB
- Optimizing image size beyond what pnpm deploy provides

## Decisions

### 1. Externalize DuckDB in Vite config

Add `@duckdb/node-api` and `@duckdb/node-bindings` to `ssr.external`. These are the only packages that contain native binaries. All other npm deps (kysely, @oorabona/kysely-duckdb, hono, etc.) remain bundled.

### 2. Use pnpm deploy for production node_modules

`pnpm deploy --prod --filter @workflow-engine/runtime dist/` creates a flat `node_modules/` with all production dependencies (no symlinks, no `.pnpm/` store) directly in `dist/`. Combined with Vite's output, `dist/` becomes a self-contained deployment directory:

```
dist/
  ├── main.js           (Vite bundle)
  ├── package.json      (from pnpm deploy)
  └── node_modules/     (production deps, flat)
      └── @duckdb/      (native bindings)
```

This duplicates some already-bundled deps in `node_modules/`, but it's simple and correct. Node's module resolution checks `node_modules/` for the external `@duckdb/*` imports.

### 3. Keep distroless runtime

DuckDB's native binary links against standard glibc libraries (`libstdc++`, `libm`, `libc`, `libpthread`) — all present in distroless/nodejs24-debian13. Verified via `ldd`: no `libatomic` dependency.

## Risks / Trade-offs

- **[Image size increase]** Production deps in `node_modules/` add ~70MB (dominated by DuckDB's ~58MB binary). → *Mitigation:* Acceptable for a server image. Docker layer caching minimizes rebuild impact.
- **[Duplicate bundled code]** Some packages exist both in `main.js` and `node_modules/`. → *Mitigation:* Node resolves `@duckdb/*` from `node_modules/` via the external import; duplicated packages are never loaded from `node_modules/` since they're already in the bundle.
