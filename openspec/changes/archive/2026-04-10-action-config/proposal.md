## Why

Actions currently receive the entire `process.env` at runtime, which is unsuitable for production deployments. Workflow authors need a way to define configuration values (literals and build-time env captures) that are baked into the compiled workflow artifacts, eliminating runtime env var dependencies for action config.

## What Changes

- **BREAKING**: Replace `env: string[]` (name-only declaration) with `env: Record<string, string | EnvRef>` (key-value pairs with resolved values) on both workflow-level `.env()` and per-action `env` fields
- Add `env()` helper function to SDK that returns a Symbol-branded `EnvRef` marker, resolved eagerly by the builder from `process.env`
- `env()` supports: no-arg (key derived from object key), explicit name, and `{ default }` option
- Workflow-level `.env()` values are available to all actions; action-level `env` merges with workflow env (action wins on conflict)
- `compile()` outputs resolved `env: Record<string, string>` per action (workflow + action merged)
- Manifest `actions[].env` changes from `string[]` to `Record<string, string>` with resolved values
- Runtime loader passes per-action env from the manifest instead of `process.env`
- `createActionContext` no longer receives global `process.env`; gets per-action env from manifest

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `define-workflow`: Add `env()` helper with `EnvRef` marker pattern; add workflow-level `.env()` method; change action `env` from `string[]` to `Record<string, string | EnvRef>`; `compile()` resolves `EnvRef` markers and merges workflow+action env
- `workflow-manifest`: Change `actions[].env` schema from `z.array(z.string())` to `z.record(z.string())`
- `workflow-loading`: Read per-action `env: Record<string, string>` from manifest; pass to action registration
- `context`: Accept per-action env instead of global `process.env`; remove env parameter from `createActionContext` factory

## Impact

- **SDK** (`packages/sdk/src/index.ts`): New `env()` export, `EnvRef` type, `WorkflowBuilder` changes, `CompileOutput`/`CompiledAction` type changes, `ManifestSchema` update
- **Vite plugin** (`packages/vite-plugin/src/index.ts`): Update `ManifestAction.env` type from `string[]` to `Record<string, string>`
- **Runtime loader** (`packages/runtime/src/loader.ts`): Carry per-action env through to action registration
- **Runtime context** (`packages/runtime/src/context/index.ts`): Per-action env injection
- **Runtime main** (`packages/runtime/src/main.ts`): Remove `process.env` passthrough to context factory
- **Workflows** (`workflows/cronitor.ts`): Migrate to new env API
- **Breaking**: Any workflow using the old `env: string[]` pattern must migrate
