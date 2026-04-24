## REMOVED Requirements

### Requirement: Vite plugin with Rolldown bundling

**Reason**: `build` as an umbrella capability has been superseded by the symmetric pair `runtime-build` (Vite SSR of the runtime) + `workflow-build` (per-workflow plugin + manifest + typecheck). The original requirement's wording ("action files as Vite entry points") pre-dates direct-call action composition and is factually out of date.

**Migration**: See `runtime-build` for the runtime bundle configuration and `workflow-build` for the `@workflow-engine/sdk/plugin` Vite plugin that emits per-workflow manifest + action bundles.

### Requirement: DSL execution at build time

**Reason**: The wording describes an event-bus-subscription model (`getActionEntries()`, "event → action → file mappings") that has not matched the code since direct action composition landed. The current Vite plugin scans branded SDK exports (`defineWorkflow`, `action`, `httpTrigger`, `cronTrigger`, `manualTrigger`) at build time, not DSL invocation.

**Migration**: See `workflow-build` requirements on export-identifier rules and branded SDK product discovery.

### Requirement: Manifest generation

**Reason**: Same umbrella-capability replacement. Manifest generation is specced under `workflow-build` (emission) and `workflow-manifest` (format).

**Migration**: See `workflow-build` for the `generateBundle` hook contract; `workflow-manifest` for the manifest schema.

### Requirement: Manifest-only wiring

**Reason**: Wording "trigger configs, event-to-action subscriptions, and action emit declarations" is stale. The current manifest carries `name`, `module`, `env`, `actions`, `triggers`; there are no "subscriptions" because actions compose via direct calls, not event subscriptions.

**Migration**: See `workflow-manifest` for the current schema.

### Requirement: No build-time graph validation

**Reason**: Same umbrella-capability replacement. TypeScript typecheck is specced under `workflow-build` (build-time typecheck with fixed strict compiler options).

**Migration**: See `workflow-build` — production builds enforce TypeScript type checking via `buildStart` hook.

### Requirement: Build output structure

**Reason**: Same umbrella-capability replacement. Output structure `dist/manifest.json + dist/actions/...` is specced under `workflow-build`.

**Migration**: See `workflow-build` for the per-workflow bundle output shape.
