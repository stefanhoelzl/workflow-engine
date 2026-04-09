## Why

The runtime currently extracts action metadata by executing workflow code — importing `.js` files and reading their `WorkflowConfig` default export. This means you cannot inspect the workflow graph (event chains, fan-out topology, missing handlers) without running untrusted action code. Separating static metadata from executable handlers enables build-time analysis and security isolation.

## What Changes

- **BREAKING**: Remove `workflow()` factory, `.build()` method, `WorkflowConfig` type, and `ActionConfig` type from the SDK
- Introduce `createWorkflow()` factory with a single-phase generic builder that exposes `.action()` (returns typed handler function) and `.compile()` (returns serializable metadata + handler references)
- `.action()` returns the handler for named export; action name derived from export variable name by Vite plugin (optional `name` override)
- Add `ManifestSchema` (Zod object) and `Manifest` type to SDK for validating manifest.json at load time
- **BREAKING**: Build output changes from flat `workflows/dist/<name>.js` to per-workflow directories `workflows/dist/<name>/manifest.json + actions.js`
- Create `packages/vite-plugin` — two-pass Vite plugin: Pass 1 extracts manifest via `.compile()` + `z.toJSONSchema()`. Pass 2 uses a transform hook to strip `.action()` wrappers so tree-shaking removes SDK/Zod from actions.js
- Plugin takes explicit workflow file list (no directory scanning)
- **BREAKING**: Runtime loader reads `manifest.json` + `actions.js` instead of importing `WorkflowConfig` from `.js` files. Reconstructs Zod schemas via `z.fromJSONSchema()` for event payload validation
- Event payload validation (all events, trigger + action-emitted) continues unchanged via `createEventSource()`

## Capabilities

### New Capabilities
- `workflow-manifest`: Static manifest.json format, ManifestSchema validation, and JSON Schema event descriptions
- `vite-plugin`: Vite plugin for compiling workflow source into manifest.json + actions.js with handler extraction transform

### Modified Capabilities
- `define-workflow`: `workflow()` → `createWorkflow()`, `.build()` → `.compile()`, `.action()` returns handler, single-phase builder replaces 4 phased interfaces
- `workflow-loading`: Loader reads manifest.json directories instead of flat .js files, uses `z.fromJSONSchema()` for schema reconstruction
- `workflow-build`: Build output structure changes from flat files to per-workflow directories

## Impact

- **SDK** (`packages/sdk`): Breaking API change — all consumers of `workflow()`, `.build()`, `WorkflowConfig` must update
- **Runtime** (`packages/runtime`): Loader rewrite, main.ts registration refactor, simplified Action type (schema removed)
- **Workflows** (`workflows/`): Authoring format changes — handlers as named exports, builder as default export
- **Build config**: `workflows/vite.config.ts` uses new vite-plugin; root `vite.config.ts` devServer plugin watches for new output structure
- **Tests**: SDK tests (20+ `.build()` calls), loader tests, integration tests, scheduler tests need updates
- **No impact**: event-source.ts, event-bus/*, dashboard/*, context/*, triggers/http.ts, storage/*, server.ts
- **Dependencies**: No new external dependencies — `z.toJSONSchema()` and `z.fromJSONSchema()` are built into Zod v4
- **QueueStore**: Not affected — queue interface is unchanged
