## REMOVED Requirements

All `vite-plugin` requirements are absorbed into `workflow-build`, which now owns the Vite plugin end-to-end. Each requirement's text + scenarios is preserved verbatim in `workflow-build` under the same heading.

### Requirement: Plugin accepts explicit workflow list

**Reason**: Absorbed into `workflow-build`. The plugin is not a standalone capability; it is the mechanism by which a workflow is built.

**Migration**: See `workflow-build` for the same requirement with identical scenarios.

### Requirement: Vite plugin package

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — the plugin lives at `packages/sdk/src/plugin/` and the former `@workflow-engine/vite-plugin` package is deleted.

### Requirement: Per-workflow bundle

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — one bundle per workflow file, IIFE format, shared `IIFE_NAMESPACE` constant, no polyfill imports in the bundle.

### Requirement: Brand-symbol export discovery

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — discovery via `Symbol.for("@workflow-engine/workflow")`, `/action`, `/http-trigger`, `/cron-trigger`, `/manual-trigger` brands; alias detection with `ERR_ACTION_MULTI_NAME`.

### Requirement: Workflow name derivation

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — name from `defineWorkflow({name})` or filestem fallback.

### Requirement: Action call resolution at build time

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — AST injection of `name: "<exportedIdentifier>"` into `action({...})` call expressions; `export const X = action({...})` is the only recognized form; post-bundle validation fails on untransformed actions.

### Requirement: Build failure on validation errors

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — fails on zero or multiple `defineWorkflow` exports, non-Zod `input` / `output`, or TypeScript errors.

### Requirement: Cron trigger manifest emission from evaluated export

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — evaluation reads `schedule` + `tz` off the branded export; the factory supplies default `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.

### Requirement: HTTP trigger export name is URL-safe

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — identifier regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` applied to HTTP and manual trigger export names.

### Requirement: Manual trigger manifest emission from evaluated export

**Reason**: Absorbed into `workflow-build`.

**Migration**: See `workflow-build` — evaluation reads `inputSchema` + `outputSchema` off the branded export; default `z.object({})` + `z.unknown()` from the factory; same identifier regex as HTTP.
