## Why

The EventStore introduces DuckDB native bindings (`@duckdb/node-api`) which cannot be bundled by Vite into a single JS file. The current Dockerfile and vite-build specs assume a single self-contained `dist/main.js` with no `node_modules` — this breaks at runtime because `main.js` now has external `require("@duckdb/node-api")` calls with no modules to resolve.

## What Changes

- Add `@duckdb/node-api` and `@duckdb/node-bindings` to Vite SSR externals so the build succeeds
- Use `pnpm deploy --prod` in the Dockerfile build stage to create a production `node_modules` in `dist/`
- Copy `dist/` (containing both `main.js` and `node_modules/`) to the distroless runtime image
- Update specs to reflect that the build output now includes external native dependencies alongside the bundle

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `vite-build`: Build output is no longer a single self-contained file — native dependencies (`@duckdb/*`) are external and require `node_modules` at runtime
- `docker`: Production image now includes `node_modules/` for native dependencies alongside the bundled JS

## Impact

- **vite.config.ts**: Add `@duckdb/node-api` and `@duckdb/node-bindings` to `ssr.external`
- **Dockerfile**: Add `pnpm deploy --prod` step, update COPY to include `node_modules`
