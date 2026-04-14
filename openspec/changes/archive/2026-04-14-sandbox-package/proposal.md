## Why

The sandbox today is entangled with runtime-internal types (`ActionContext`, `RuntimeEvent`) and exposes a Bridge primitive that leaks QuickJS handle machinery into its public surface. The `spawn(source, ctx, options)` API mixes workflow semantics (ctx.emit, ctx.event, ctx.env) with the generic concern of "execute JS in an isolated VM." Extracting the sandbox into its own package and narrowing its public API to a generic `source + host-methods` contract removes coupling, makes the sandbox reusable outside the workflow runtime, and reduces the spec's public surface from ~844 lines to a small, defensible contract.

## What Changes

- **BREAKING** New package `@workflow-engine/sandbox` at `packages/sandbox`. Pure TS source, no build step. QuickJS + host bridges (console, timers, performance, crypto, `__hostFetch`) live here.
- **BREAKING** New public API replaces `createSandbox()` + `Sandbox.spawn(source, ctx, options)`:
  - `sandbox(source, methods, options?) → Promise<Sandbox>` — construction evaluates the source module once; `methods` is `Record<string, (...args) => Promise<unknown>>`; `options.filename` only.
  - `Sandbox.run(name, ctx, extraMethods?) → Promise<RunResult>` — invokes a named export from the source with `ctx` as the sole JSON argument; `extraMethods` extends (does not shadow) the construction-time methods for this call only.
  - `RunResult = { ok: true; result: unknown; logs: LogEntry[] } | { ok: false; error; logs: LogEntry[] }`.
- **BREAKING** Host↔sandbox boundary is JSON-only for consumer-provided methods. Bridge primitive (`sync`, `async`, `arg`, `marshal`, `storeOpaque`) becomes sandbox-internal; consumers cannot reach it.
- **BREAKING** Runtime's `ActionContext` drops `emit`. Runtime installs `emit` as a per-run `extraMethods` entry that closes over the current event. Workflow authors continue to call `ctx.emit(type, payload)` with per-action narrowing: SDK's `workflow.action({...})` wraps the handler at authoring time to inject a typed `ctx.emit` that proxies to the per-run `emit` global. The bare `emit(type, payload)` global remains available as an untyped escape hatch.
- **BREAKING** VM lifecycle posture changes: one sandbox per workflow, reused across all events for that workflow. Fresh VM per invocation is replaced by fresh VM per workflow load; disposal happens on workflow unload/reload. Module-level state and the opaque-ref store persist across `run()`s within a workflow.
- Crypto stays as a built-in host bridge but collapses from 12 per-operation spec requirements to one "WebCrypto surface" requirement plus one security rule ("key material does not cross the boundary").
- Vite-plugin is **unchanged** — it continues to bundle npm polyfills (whatwg-fetch, url-polyfill, blob-polyfill, etc.) into workflow `actions.js` via the `@workflow-engine/sandbox-globals` virtual module. `__hostFetch` is still installed by the sandbox per-VM; MockXhr inside the workflow bundle calls it at fetch time.
- Capability `action-sandbox` is renamed to `sandbox`. The current `sandbox` spec (a 5-line tombstone pointing at `action-sandbox`) is removed.

## Capabilities

### New Capabilities
(none — `sandbox` already exists as a tombstone capability and is being repurposed, see Modified)

### Modified Capabilities
- `sandbox`: Full rewrite. Replaces the tombstone with the post-rename, post-redesign contract. Consumes the prior `action-sandbox` spec's content, narrowed: Bridge primitive details, per-operation crypto requirements, and the ctx bridging requirements are removed; `sandbox()` / `run()` API, JSON-only boundary, workflow-scoped VM lifecycle, consolidated security guarantees, and collapsed WebCrypto surface are added. The sandbox spec becomes the single source of truth for lifecycle and security invariants about the sandbox (other specs stop codifying them).
- `action-sandbox`: Removed. Content migrates to the renamed `sandbox` capability.
- `context`: `ActionContext.emit()` requirement removed. `ActionContext` is now `{ event, env }`; `emit` is no longer a method on it. Prose references to the sandbox boundary are trimmed (those guarantees move to the sandbox spec).
- `scheduler`: `sandbox.spawn(action.source, ctx)` replaced with per-workflow sandbox instances (`Map<workflowName, Sandbox>`) and `sb.run(actionName, ctx, { emit })` per event. The "QuickJS context is disposed after every action" requirement is removed (contradicts new lifecycle); disposal is now on workflow unload/reload and is owned by the sandbox capability, not the scheduler.
- `sdk`: SDK's `ActionContext.emit` preserved with per-action narrowed generics. SDK's `workflow.action({...})` builder wraps user handlers at authoring time to inject `ctx.emit` (closing over the per-run `emit` global). SDK additionally declares an ambient global `emit(type: string, payload: unknown): Promise<void>` as an untyped escape hatch.
- `workflow-loading`: The line stating the scheduler passes `action.source` and `action.exportName` to `sandbox.spawn()` is rewritten for the new API (workflow loading constructs a sandbox per workflow; action invocation is `sb.run(actionName, ctx)`).
- `monorepo-structure`: Adds `packages/sandbox` to the enumerated package list.

## Impact

- **Affected code**
  - `packages/runtime/src/sandbox/*` → refactored in Phase 1 to the new API, then moved to `packages/sandbox/src/*` in Phase 2.
  - `packages/runtime/src/context/index.ts` — `ActionContext` loses `emit` and the `#emit` closure; `createActionContext` factory no longer needs `EventSource`.
  - `packages/runtime/src/services/scheduler.ts` — owns `Map<string, Sandbox>`; constructs sandboxes lazily per workflow; passes per-run `{ emit }` closure.
  - `packages/runtime/src/main.ts` — no longer creates a single sandbox at startup; scheduler owns sandbox construction.
  - `packages/runtime/src/event-source.ts` — unchanged consumer of `LogEntry`; import path changes when sandbox moves.
  - `packages/runtime/src/event-bus/recovery.test.ts`, `packages/runtime/src/integration.test.ts`, `packages/runtime/src/services/scheduler.test.ts` — update imports and test fixtures to new API.
  - `packages/sdk/src/*` — `ActionContext` type loses `emit`; ambient `emit` declaration added.
- **Affected APIs**
  - Workflow authors: `ctx.emit(...)` remains the typed path (narrowing preserved via the SDK wrapper). An ambient `emit(...)` global is additionally available as an untyped escape hatch. `ctx.event` and `ctx.env` unchanged.
  - Runtime consumers: `createSandbox()` / `spawn()` → `sandbox(source, methods)` / `sb.run(name, ctx, extras)`.
- **Affected deps**
  - `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync` move from `packages/runtime/package.json` to `packages/sandbox/package.json`.
  - Polyfill deps (whatwg-fetch, url-polyfill, blob-polyfill, etc.) stay in `packages/vite-plugin/package.json`.
- **Affected docs**
  - `SECURITY.md §2` — entry points, mitigations, rule #4 for AI agents, and file references must be updated to reflect new API and workflow-scoped VM lifecycle. Posture change is explicitly argued (same-workflow state sharing is intra-tenant; cross-workflow isolation stays strict).
- **Not affected**
  - `@workflow-engine/vite-plugin` — polyfill injection, virtual modules, and tree-shaking behavior unchanged.
  - Infrastructure (OpenTofu, kind, Traefik, oauth2-proxy) — unchanged.
  - Event schema, persistence, DuckDB event store — unchanged.
