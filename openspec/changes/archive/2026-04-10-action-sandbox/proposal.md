## Why

Actions currently execute directly in the Node.js process with full access to the filesystem, network, environment variables, and all Node.js APIs. Since actions will run untrusted user-provided code, they must be sandboxed to prevent unauthorized access to host resources.

## What Changes

- **New sandbox module** in `packages/runtime/src/sandbox/` that executes action source code inside QuickJS (compiled to WASM via `quickjs-emscripten`), providing a hard isolation boundary where only explicitly exposed globals and the `ctx` object are available.
- **BREAKING: Action type changes** from `handler: (ctx) => Promise<void>` to `source: string` — actions carry their JavaScript source code instead of function references.
- **BREAKING: Error field changes** from `error: string` to `error: { message: string; stack: string }` in event transition payloads, preserving both the error message and QuickJS stack trace.
- **Scheduler receives a `Sandbox` object** via `createScheduler()` instead of calling `action.handler(ctx)` directly. Calls `sandbox.spawn(source, ctx, signal?)` which returns `Promise<SandboxResult>`.
- **Loader reads action source as strings** via `readFile` instead of dynamically importing handler functions.
- **Vite plugin emits one file per action** with `export default async (ctx) => { ... }` instead of a single `actions.js` with named exports.
- **Manifest format changes**: each action entry points to its own module file instead of a shared `actions.js`.
- **Fetch response proxy**: `ctx.fetch()` inside the sandbox returns a simplified Response object with `status`, `statusText`, `ok`, `url`, `headers` (as Map), and async `json()`/`text()` methods bridged to the host.

## Capabilities

### New Capabilities

- `action-sandbox`: QuickJS WASM sandbox for executing untrusted action code with controlled globals and host-bridged ctx API

### Modified Capabilities

- `sandbox`: Replaces the isolated-vm based sandbox spec with QuickJS WASM. Changes isolation mechanism, async model, and host API surface.
- `workflow-loading`: Loader reads action source files as strings instead of importing ES modules. Action type changes from function reference to source string.
- `scheduler`: Scheduler receives a `Sandbox` dependency and delegates execution via `sandbox.spawn()` instead of calling `action.handler()` directly. Error field changes from string to object.
- `workflow-manifest`: Manifest `module` field replaced with per-action `module` fields pointing to individual source files.
- `context`: `ctx.fetch()` response changes from native `Response` to a proxied subset. `ctx.emit()` bridged as async deferred promise across WASM boundary.
- `vite-plugin`: Build output changes from single `actions.js` with named exports to one file per action with default export.

## Impact

- **Runtime package**: New `sandbox/` module, modified scheduler, modified loader, modified event-source error type
- **Vite plugin package**: Modified output format (one file per action, default exports)
- **SDK package**: Manifest schema update (per-action module paths)
- **New dependency**: `quickjs-emscripten` added to runtime package
- **Existing workflows**: Must be rebuilt with updated Vite plugin to produce new output format
- **Event store**: Error column must accommodate JSON object instead of plain string (already uses `JSON.stringify`)
- **Dashboard**: Error display must handle `{ message, stack }` object
