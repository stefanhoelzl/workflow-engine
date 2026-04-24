## REMOVED Requirements

### Requirement: Vite config bundles the runtime into a single JS file

**Reason**: `vite-build` is subsumed by `runtime-build`, which owns the Vite SSR build end-to-end (entry point, native-binding externalization, output bundle).

**Migration**: See `runtime-build` — the `packages/runtime/src/main.ts` → `dist/main.js` SSR build with `@duckdb/*` externalization is specced there.

### Requirement: All npm dependencies are bundled

**Reason**: Same absorption. The inline-all-except-native-bindings contract moves to `runtime-build`.

**Migration**: See `runtime-build` — `@duckdb/node-api` + `@duckdb/node-bindings` externalized via `ssr.external`; Node built-ins externalized; everything else inlined. Plus: the patched `fetch-blob@4` TLA strip is captured as a `runtime-build` requirement (previously lived as the `stripFetchBlobTLA` rollup transform in `sandbox/vite/`, now a pnpm patch per `unify-sandbox-plugin-transform`).

### Requirement: Build script is available from the root

**Reason**: Same absorption. `pnpm build` ownership moves to `runtime-build`.

**Migration**: See `runtime-build` — `pnpm build` runs both the runtime SSR build and the workflow build.

### Requirement: Start script builds workflows and starts runtime

**Reason**: Same absorption AND the `WORKFLOW_DIR` env var no longer exists (removed by `multi-tenant-workflows` — runtime loads tenants from storage, not a filesystem directory).

**Migration**: See `runtime-build` — `pnpm start` builds workflows then starts the runtime without `WORKFLOW_DIR`. Tenant bundles are loaded from the configured storage backend at runtime.
