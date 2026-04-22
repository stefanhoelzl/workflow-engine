> **Implementation note.** The shipped shape deviates from this proposal in two places: (1) `PluginDescriptor.workerModule: string` is replaced by `source: string` — plugin files are pre-bundled by the `sandboxPlugins()` vite transform and loaded in the worker via `data:` URI (see `tasks.md` §3.0). (2) The `createXxxPlugin()` factory pattern is dropped; each plugin file exports `{ name, dependsOn?, worker }` as top-level named exports directly (see `tasks.md` §3.0.5 + `openspec/docs/sandbox-plugin-authoring.md` §10). The proposal text below is aspirational; `tasks.md` and the authoring guide are the canonical references for the final shape.

## Why

Today's sandbox mixes four ad-hoc bridge mechanisms (per-method `__*` globals with individual capture-and-delete shims, generic `methods` option, direct-bound natives via `vm.newFunction`, separate `{type: "log"}` worker protocol), plus factory-option callbacks (`onEvent`, `logger`, future `wasi`). Each addition has added its own SECURITY.md §2 invariant and its own worker-protocol shape. The sandbox package knows workflow-engine-specific concepts (fetch/hardenedFetch, timers, console, action dispatch, event emission, tenant/workflow/invocation metadata) that shouldn't live inside a generic QuickJS host. Adding a new host-callable surface requires touching ≥ 5 files (polyfill, SECURITY.md, sandbox spec, install-host-methods, worker protocol).

This change collapses the surface to a plugin architecture where the sandbox core is a pure mechanism (WASM hosting, event stamping, WASI routing, run lifecycle, plugin composition). Every existing bridge becomes a plugin; runtime-engine metadata moves out of the sandbox entirely; SECURITY.md §2 shrinks from ~10 per-shim invariants to ~8 plugin-discipline rules. Adding a new bridge becomes a single plugin file.

## What Changes

- **BREAKING** `sandbox()` factory signature: remove `methods`, `onEvent`, `logger`, `fetch` (production); add `plugins: Plugin[]`. Single test-injection override is `createFetchPlugin({fetch: mockFetch})`.
- **BREAKING** `__hostFetch`, `__emitEvent`, `__hostCallAction`, `__reportError` raw bridges deleted. All host-callable surface installed via plugin descriptors.
- **BREAKING** Runtime no longer appends `action-dispatcher.js` to tenant bundles. `createSdkSupportPlugin` installs a locked `__sdk.dispatchAction` global during plugin boot. Existing tenant bundles MUST be re-uploaded after deploy.
- **BREAKING** `RunContext` (tenant/workflow/workflowSha/invocationId) removed from sandbox core. Runtime stamps these fields on events in its `sb.onEvent` receiver before forwarding to the bus.
- **BREAKING** Worker protocol shapes collapse: remove `{type: "log"}`, remove runtime-metadata fields from `{type: "event"}`, remove method-RPC `{type: "request"}`/`{type: "response"}`. Plugin code runs worker-side; no cross-thread method calls.
- **BREAKING** `system.request`/`system.response`/`system.error` auto-emission around host methods retired. Plugins wrap their own lifecycle via `ctx.request(prefix, name, extra, fn)` or via per-descriptor `log` config.
- **BREAKING** WASI clock/random no longer emit `system.call` events in core. WASI events flow through the sandbox-owned `createWasiPlugin(setup?)` plugin; the caller's setup function decides what to emit.
- **BREAKING** Pass-1/pass-2 method install ordering removed. Method-name collisions between plugins throw at sandbox construction.
- Add new package `@workflow-engine/sandbox-stdlib` shipping `createWebPlatformPlugin`, `createFetchPlugin`, `createTimersPlugin`, `createConsolePlugin`, `hardenedFetch` export, and the WPT suite (moved from `packages/sandbox`).
- Add `createTriggerPlugin` (runtime-owned): emits `trigger.request/response/error` around guest-export invocation via `onBeforeRunStarted` / `onRunFinished` hooks.
- Add `createSdkSupportPlugin` (SDK-owned): installs locked `__sdk.dispatchAction` that wraps guest-side handler with `action.*` lifecycle.
- Add `createHostCallActionPlugin` (runtime-owned): Ajv validation, exports `validateAction` to dependents via `deps`.
- Add `createWasiPlugin(setup?)` (sandbox-owned): inert by default; caller supplies hook implementations for telemetry or replay.
- Dashboard: `flamegraph.ts` `BarKind` union simplifies from `"trigger" | "action" | "system" | "timer"` to `"trigger" | "action" | "rest"`. Marker kinds stay open-ended (timer.set, timer.clear, console.log, wasi.*, etc.). `system.call` marker renames to `wasi.clock_time_get` / `wasi.random_get`.
- Plugin descriptors support declarative event emission via `log?: {event: string} | {request: string}` (default `{request: name}`) and visibility gating via `public?: boolean` (default `false` → auto-deleted after phase 2).
- Run-lifecycle semantics: events emitted during `onRunFinished` run INSIDE the run context; plugins route cleanup through the same code paths as guest-initiated teardown so audit events fire.

## Capabilities

### New Capabilities
- `sandbox-plugin`: Plugin type, `SandboxContext`, `PluginSetup`, `GuestFunctionDescription`, `WasiHooks`. Defines the plugin contract (guest functions, wasi hooks, source, exports, lifecycle hooks), ctx API (`emit`, `request`, frame semantics via `createsFrame`/`closesFrame`), phase-2 private-binding deletion, topo-sort ordering, name-collision rules.
- `sandbox-stdlib`: New package `@workflow-engine/sandbox-stdlib`. Ships `createWebPlatformPlugin` (bundled polyfills: EventTarget, ErrorEvent, Observable, Streams, URLPattern, CompressionStream, reportError, microtask wrapper, fetch WHATWG shape), `createFetchPlugin({fetch?})`, `createTimersPlugin`, `createConsolePlugin`, `hardenedFetch` exported constant.
- `sandbox-sdk-plugin`: SDK package's `createSdkSupportPlugin()`. Installs locked `__sdk.dispatchAction` global via `Object.defineProperty({writable:false, configurable:false})`; wraps guest handler execution with `action.request`/`action.response`/`action.error` lifecycle; depends on `host-call-action` plugin's exported `validateAction`.
- `sandbox-trigger-plugin`: Runtime package's `createTriggerPlugin()`. Uses `onBeforeRunStarted` hook to emit `trigger.request` (createsFrame) and `onRunFinished` to emit `trigger.response` or `trigger.error` (closesFrame) around every run.
- `sandbox-host-call-action-plugin`: Runtime package's `createHostCallActionPlugin({manifest})`. Exports `validateAction(name, input)` (Ajv-compiled validators per tenant manifest) to dependents.
- `wpt-compliance-harness-plugin`: WPT test plugin (`createWptHarnessPlugin({collect})`), ships with sandbox-stdlib tests. Installs private `__wptReport` descriptor.

### Modified Capabilities
- `sandbox`: Replace factory signature; retire `methods`/`onEvent`/`logger` options; define the plugin-boot sequence (phase 0-5); retire `RunContext`; retire `system.*` auto-emission; retire `{type:"log"}` + method-RPC worker protocol shapes; introduce `public`-default-false private-binding auto-deletion. `SECURITY.md §2` collapses to 8 plugin-discipline rules (private-by-default, locked internals, hardened-fetch default, per-run cleanup, ctx-only emission, worker-only execution, reserved prefixes, no runtime metadata in sandbox). WASI override dispatch moves to plugin-owned `wasiHooks` slots.
- `sdk`: `action()` becomes a thin passthrough to `globalThis.__sdk.dispatchAction`. SDK no longer relies on `action-dispatcher.js` being appended by runtime; `createSdkSupportPlugin` owns the dispatcher. SDK exports the plugin factory alongside guest-facing exports.
- `executor`: Sandbox-store composes the plugin list per cached sandbox. Runtime stamps tenant/workflow/workflowSha/invocationId on every event received via `sb.onEvent` before forwarding to the bus. Tenant isolation (§1 I-T2) enforced at runtime layer, not sandbox layer.
- `sandbox-store`: Per-sandbox plugin construction (once per `(tenant, sha)` cache entry); no action-dispatcher source append; WASM init-error handling covers plugin.worker()+phase-2+phase-4 failures uniformly.
- `dashboard-list-view`: `flamegraph.ts` bar-kind union simplifies to `"trigger" | "action" | "rest"`; marker-kind union opens to accept any leaf event kind; system.call rendering replaced by wasi.* markers.
- `wpt-compliance-harness`: Move vendored suite + harness + skip list from `packages/sandbox/test/wpt/` to `packages/sandbox-stdlib/test/wpt/`. `__wptReport` installed via private descriptor in `createWptHarnessPlugin`.
- `workflow-loading`: Tenant bundles drop the runtime-appended `action-dispatcher.js` preamble; workflow source shape otherwise unchanged. Bundle re-upload required post-deploy.
- `monorepo-structure`: Add `packages/sandbox-stdlib` package; update pnpm-workspace.yaml.
- `sandbox-store`, `runtime-config`: Runtime wires `createWasiPlugin(runtimeWasiTelemetry)` setup function; `runtimeWasiTelemetry` lives in runtime (not sandbox).

## Impact

- **Packages modified**: `packages/sandbox` (factory, worker, bridge, WASI, protocol, plugins/wasi), `packages/runtime` (sandbox-store, plugins/trigger, plugins/host-call-action, wasi-telemetry, action-dispatcher.js DELETED, onEvent stamping), `packages/sdk` (sdk-support plugin, action.ts).
- **New package**: `packages/sandbox-stdlib` (web-platform, fetch, timers, console plugins + hardenedFetch + WPT test suite moved in).
- **Worker protocol**: `{type:"log"}` removed, `{type:"event"}` drops runtime-metadata fields, `{type:"request"}`/`{type:"response"}` removed (no method RPC), plugin descriptors serialized through `{type:"init"}`.
- **Dashboard**: `packages/runtime/src/ui/dashboard/flamegraph.ts` — simpler bar-kind discriminator, marker-kind union opens. No other UI code affected.
- **SECURITY.md**: §2 rewritten from N per-shim invariants to 8 plugin-discipline rules. §1 I-T2 (tenant isolation) moves to runtime spec. R-S4 (hardened fetch) strengthened via structural default. R-S10 (locked dispatcher) preserved via `__sdk` lock.
- **Tests**: sandbox tests split between `packages/sandbox/test/` (core mechanism) and `packages/sandbox-stdlib/test/` (plugin behavior + WPT). `pnpm test:wpt` target directory changes.
- **Upgrade path**: BREAKING. Tenant workflow tarballs MUST be re-uploaded after deploy (`wfe upload --tenant <name>`), matching the precedent of `bake-action-names-drop-trigger-shim`. Pending/archive event prefix does NOT need wiping (event shape preserves id/seq/ref/ts/kind/name; runtime-stamped metadata preserved). Workflows/ prefix replaced via re-upload.
- **Staging**: Land in 3 PRs — (1) core+stdlib refactor with legacy `methods` adapter (zero consumer churn), (2) SDK rewrite and `__sdk` global (BREAKING; forces tenant re-upload), (3) runtime plugin composition and drop legacy adapter.
- **openspec/project.md**: Context field mentions "QuickJS WASM sandbox" and ctx.emit/ctx.fetch — accurate descriptions; no update needed. Architectural principle ("4 primitives") unchanged. EventBus consumer pipeline unchanged (runtime stamps metadata post-hoc; downstream sees identical events).
