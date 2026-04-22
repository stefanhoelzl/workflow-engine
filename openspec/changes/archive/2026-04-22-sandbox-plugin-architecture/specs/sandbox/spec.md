## MODIFIED Requirements

### Requirement: Public API — sandbox() factory

The sandbox package SHALL export a `sandbox(opts)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(opts: {
  source: string;
  plugins: Plugin[];
  filename?: string;
  memoryLimit?: number;
  interruptHandler?: () => boolean;
}): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint.
2. Serialize each plugin into a descriptor `{ name, source, config?, dependsOn? }` where `source` is a pre-bundled ESM source string (loaded inside the worker via `data:text/javascript;base64,<...>` import) produced by the `sandboxPlugins()` vite transform at build time, and `config` is JSON-serializable data.
3. Send the worker an `init` message carrying `source`, `pluginDescriptors`, `filename`, `memoryLimit`, and `interruptHandler` (if any).
4. Inside the worker: topo-sort plugins by `dependsOn`, instantiate QuickJS WASM with WASI imports routed to mutable hook slots, invoke each plugin's `worker(ctx, deps, config)` in topo order to collect `PluginSetup`s, install `guestFunctions` as `vm.newFunction` bindings, populate `wasiHooks` slots, then run boot phases 2 (plugin sources), 3 (delete private descriptor globals), 4 (user source).
5. Wait for the worker to reply with `ready` confirming all phases completed.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onEvent()` calls are routed to the worker.

The factory SHALL NOT accept `methods`, `onEvent`, `logger`, or `fetch` top-level options. All of these are plugin-level concerns.

The returned promise SHALL NOT resolve until the worker has reported `ready`. Any failure in phases 0-4 SHALL cause the worker to post `init-error`, dispose the VM, and `process.exit(0)`; the promise SHALL reject with the serialized error.

#### Scenario: Factory signature

- **GIVEN** a valid source string and a plugin list
- **WHEN** `sandbox({ source, plugins: [createWebPlatformPlugin(), createFetchPlugin(), ...] })` is called
- **THEN** the returned promise SHALL resolve with a `Sandbox` exposing `run`, `dispose`, and `onEvent`

#### Scenario: Construction rejects on plugin collision

- **GIVEN** two plugins in the composition both declaring `name: "timers"`
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject before any worker init completes
- **AND** the error SHALL identify the colliding plugin name

#### Scenario: Construction rejects on unsatisfied dependsOn

- **GIVEN** a plugin with `dependsOn: ["nonexistent"]` in the composition
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject
- **AND** the error SHALL identify the missing dependency

#### Scenario: Non-serializable plugin config rejected

- **GIVEN** a plugin descriptor whose `config` contains a function or class instance
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject with a serialization error identifying the offending config path

### Requirement: Public API — Sandbox.run()

The `Sandbox.run(exportName, input)` method SHALL execute a guest export inside the VM and return a promise resolving to a `RunResult`: `{ ok: true, output: unknown } | { ok: false, error: SerializedError }`. The run primitive SHALL NOT accept or interpret runtime-engine metadata (tenant, workflow, workflowSha, invocationId). Metadata stamping is the caller's responsibility via `sb.onEvent` interception.

The run primitive SHALL execute:
1. Invoke each plugin's `onBeforeRunStarted({ name: exportName, input })` in topo order. Preserve refStack state if the plugin returns truthy; truncate the plugin's pushes if falsy/void.
2. `await vm.callFunction(exportHandle, undefined, input)`.
3. Build the `RunResult`.
4. Invoke each plugin's `onRunFinished(result, runInput)` in reverse topo order. Events emitted here SHALL stamp with the refStack state from step 1.
5. Truncate refStack back to pre-run depth.
6. Return the `RunResult`.

Events emitted during the run SHALL flow to the main thread via `{type: "event", event}` worker messages. The event SHALL carry `id, seq, ref, ts, at, kind, name, input?, output?, error?` but SHALL NOT carry tenant/workflow/workflowSha/invocationId (the caller adds these in `onEvent`).

#### Scenario: Run stamping excludes runtime metadata

- **GIVEN** any event emitted during a run
- **WHEN** the main thread receives the `{type: "event"}` message
- **THEN** the event SHALL have `id, seq, ref, ts, at, kind, name, input?, output?, error?` fields
- **AND** the event SHALL NOT have `tenant`, `workflow`, `workflowSha`, or `invocationId` fields

### Requirement: Safe globals — timers

Timers (setTimeout, setInterval, clearTimeout, clearInterval) SHALL be installed by the `createTimersPlugin()` from `@workflow-engine/sandbox-stdlib`. Each SHALL be a public guest function descriptor (writable, configurable per WebIDL). `setTimeout` and `setInterval` SHALL emit a `timer.set` leaf event at scheduling time. `clearTimeout` and `clearInterval` SHALL emit a `timer.clear` leaf event. When a scheduled timer fires host-side, the plugin SHALL wrap the captured callable invocation in `ctx.request("timer", name, { input: { timerId } }, () => callable())`, producing `timer.request`/`timer.response`/`timer.error` around the callback. Unfired timers still live at run end SHALL be cleared by the plugin's `onRunFinished` hook via the same code path as guest-initiated `clearTimeout`, emitting a `timer.clear` event for each.

#### Scenario: setTimeout emits timer.set and wraps callback with timer.request/response

- **GIVEN** guest code calls `setTimeout(cb, 100)` and the timer fires
- **WHEN** observing the event stream
- **THEN** `timer.set` SHALL be emitted at scheduling time (leaf, with `{ delay, timerId }`)
- **AND** `timer.request` SHALL be emitted when the timer fires (createsFrame, with `{ timerId }`)
- **AND** the captured callable SHALL run
- **AND** `timer.response` SHALL be emitted with `closesFrame: true` after callable returns

#### Scenario: Unfired timer cleared at run end

- **GIVEN** `setTimeout(cb, 30000)` scheduled during a run that completes in 1s
- **WHEN** the run ends
- **THEN** the plugin's `onRunFinished` SHALL clear the host timer and emit `timer.clear`
- **AND** the timer's callable SHALL be disposed
- **AND** no callback SHALL fire during subsequent runs against the same sandbox

### Requirement: Safe globals — console

Console (log, info, warn, error, debug) SHALL be installed by the `createConsolePlugin()` from `@workflow-engine/sandbox-stdlib`. Each method SHALL emit a `console.<method>` leaf event with `input: [args...]`. The `console` object SHALL be installed as a writable, configurable global per WebIDL.

#### Scenario: console.log emits a leaf

- **GIVEN** guest code calls `console.log("hello", { x: 1 })`
- **WHEN** the call returns
- **THEN** a leaf event with kind `console.log` and `input: ["hello", { x: 1 }]` SHALL be emitted

### Requirement: Safe globals — reportError

`reportError` SHALL be installed by the `createWebPlatformPlugin()` from `@workflow-engine/sandbox-stdlib`. The polyfill SHALL dispatch a cancelable `ErrorEvent` on `globalThis`; if not default-prevented, it SHALL forward a serialized payload to the plugin's captured private `__reportErrorHost` reference. The `__reportErrorHost` descriptor SHALL emit an `uncaught-error` leaf event. The raw `__reportErrorHost` SHALL NOT be visible to user source (auto-deleted after phase 2).

#### Scenario: Uncaught exception in microtask routes through reportError

- **GIVEN** guest code calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** an `uncaught-error` leaf event SHALL be emitted unless a listener called `preventDefault()` on the dispatched ErrorEvent

### Requirement: Isolation — no Node.js surface

The sandbox SHALL install no Node.js-specific globals. Node core modules (fs, net, http, process, etc.) SHALL NOT be reachable from guest code. All guest-visible globals SHALL come from: (a) web-platform polyfills installed by the web-platform plugin, (b) WASM-native WHATWG APIs (URL, TextEncoder, TextDecoder, crypto, atob, btoa, structuredClone), (c) public-descriptor guest functions registered by plugins (fetch, setTimeout, console.*, reportError). The sandbox core SHALL install nothing directly on `globalThis`.

#### Scenario: Node core modules absent

- **GIVEN** any composition of plugins (including full runtime stack)
- **WHEN** user source evaluates `typeof require, typeof process, typeof Buffer`
- **THEN** all three SHALL be `"undefined"`
- **AND** `import("fs")` or dynamic import of any Node module SHALL fail

## ADDED Requirements

### Requirement: Plugin composition per sandbox

The sandbox SHALL accept a `plugins: Plugin[]` array at construction. Plugins SHALL be topo-sorted by `dependsOn` (cycles throw, unsatisfied dependencies throw). Plugin `worker()` functions SHALL execute in topo order; `onRunFinished` SHALL execute in reverse topo order. Plugin name collisions and guest-function name collisions SHALL throw at construction time. (Detailed plugin contract: see sandbox-plugin capability.)

#### Scenario: Topo order

- **GIVEN** plugins A (dependsOn B), B (no deps), C (dependsOn A)
- **WHEN** the sandbox is constructed
- **THEN** `worker()` calls SHALL happen in order: B, A, C
- **AND** each `deps` parameter SHALL contain the exports of its declared dependencies

### Requirement: Plugin-installed guest functions via descriptors

Guest-callable host bindings SHALL be installed exclusively via plugin-declared `guestFunctions` descriptors, not via a separate `methods` option on the factory. Each descriptor's `handler` runs worker-side. Args are marshaled per descriptor `args` spec (including `Guest.callable()` which produces a `Callable` with `.dispose()`). Result is marshaled per descriptor `result` spec. `log` controls per-call event emission (default `{ request: name }`). `public` (default false) controls visibility after phase 2.

#### Scenario: public: false auto-deleted

- **GIVEN** a descriptor `{ name: "__privateFunc", handler: ... }` with no `public` field
- **WHEN** phase-2 plugin-source evaluation completes
- **THEN** `globalThis.__privateFunc` SHALL be deleted
- **AND** user source SHALL see `typeof globalThis.__privateFunc === "undefined"`

### Requirement: Boot phase sequence

The sandbox SHALL execute boot in phases:

- **Phase 0**: Load plugin worker modules; topo-sort; instantiate WASM with WASI imports (mutable hook slots).
- **Phase 1**: For each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`; register `guestFunctions` via `vm.newFunction`; populate `wasiHooks` slots; store `source`, `exports`, hooks.
- **Phase 2**: For each plugin in topo order, `vm.evalCode(plugin.source, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
- **Phase 3**: For each guest function descriptor with `public !== true`, `delete globalThis[name]`.
- **Phase 4**: `vm.evalCode(userSource, filename)`.

Any failure at any phase SHALL dispose the VM, post `init-error`, `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private globals

- **GIVEN** a plugin with descriptors `{ name: "fetch", public: true }` and `{ name: "$internal", public: false }`
- **WHEN** phase 3 runs
- **THEN** `globalThis.fetch` SHALL remain accessible
- **AND** `globalThis["$internal"]` SHALL be deleted

### Requirement: WASI override dispatch via plugin hooks

The sandbox SHALL instantiate WASI imports with mutable callback slots for `clockTimeGet`, `randomGet`, and `fdWrite`. Plugin setup SHALL populate these slots via the `wasiHooks` field. Each WASI override SHALL compute the default value (real clock, real random, line-buffered decoded text), invoke the registered hook (if any) with `{ args..., defaultNs | defaultBytes | text }`, and use the hook's return value (`{ ns }` or `{ bytes }`) as override if present, else the default. Hooks run on the worker thread; hook-invoked `ctx.emit` calls produce worker-stamped events. Only one plugin MAY register each hook key; collisions throw at sandbox construction. WASI calls firing before any plugin's `worker()` has populated the slot SHALL use the default value and emit nothing. (Detailed plugin contract: see sandbox-plugin capability.)

#### Scenario: Hook collision throws

- **GIVEN** two plugins each registering `wasiHooks.clockTimeGet`
- **WHEN** sandbox is constructed
- **THEN** construction SHALL throw naming the colliding plugin names

#### Scenario: Observation does not override

- **GIVEN** a plugin with `clockTimeGet: ({ label, defaultNs }) => { ctx.emit(...); /* no return */ }`
- **WHEN** guest triggers a WASI clock call
- **THEN** `defaultNs` SHALL be returned to WASM unchanged
- **AND** a leaf event MAY have been emitted with the plugin's declared kind

#### Scenario: Override replaces result

- **GIVEN** a plugin with `clockTimeGet: () => ({ ns: 0n })`
- **WHEN** guest triggers a WASI clock call
- **THEN** `0n` SHALL be returned to WASM in place of the real clock value

## REMOVED Requirements

### Requirement: __hostFetch bridge

**Reason**: Replaced by the fetch plugin in `@workflow-engine/sandbox-stdlib`, which registers a private `$fetch/do` guest function whose handler closes over `hardenedFetch`. Raw `__hostFetch` is no longer installed on globalThis.

**Migration**: Replace calls to `sandbox({ fetch: customFetch, ... })` with `sandbox({ plugins: [createFetchPlugin({ fetch: customFetch }), ...] })` where the override is strictly for test injection. Production code omits the `fetch` option.

### Requirement: __reportError host bridge

**Reason**: Replaced by the `__reportErrorHost` private guest function registered by the web-platform plugin in `@workflow-engine/sandbox-stdlib`. The web-platform plugin's source captures `__reportErrorHost` into its IIFE, builds a `reportError` global that dispatches ErrorEvent and forwards to the captured reference, and lets the sandbox auto-delete `__reportErrorHost` after phase 2.

**Migration**: Consumers who depended on `__reportError` as a raw bridge SHALL instead subscribe via the web-platform plugin's emitted `uncaught-error` leaf events received through `sb.onEvent`.

### Requirement: __hostCallAction bridge global

**Reason**: Replaced by the `$action/validate` export provided by the `createHostCallActionPlugin` to the sdk-support plugin via `deps["host-call-action"].validateAction`. There is no raw `__hostCallAction` global.

**Migration**: Runtime composes `createHostCallActionPlugin({ manifest })` per sandbox; the sdk-support plugin's handler calls `validateAction(name, input)` directly.

### Requirement: __emitEvent init-time bridge

**Reason**: Event emission is no longer bridged via a guest global. Plugins emit via `ctx.emit` / `ctx.request` from within their host-side handlers (which run on the worker thread); the stamping machinery is sandbox-internal and not exposed to guest code.

**Migration**: Guest-side action dispatch uses `globalThis.__sdk.dispatchAction(...)` installed by the sdk-support plugin; the plugin's host handler emits `action.*` events via `ctx.request`.

### Requirement: __dispatchAction locked guest global

**Reason**: Renamed to `__sdk.dispatchAction`. The lock is now on the `__sdk` object binding (non-writable, non-configurable) AND the object is frozen — so both `globalThis.__sdk = ...` and `globalThis.__sdk.dispatchAction = ...` are rejected.

**Migration**: Guest code (SDK-bundled) calls `globalThis.__sdk.dispatchAction(name, input, handler, completer)`. The SDK's `action()` export is a thin passthrough to this global.

