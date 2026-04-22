# sandbox-plugin Specification

## Purpose
TBD - created by archiving change sandbox-plugin-architecture. Update Purpose after archive.
## Requirements
### Requirement: Plugin type

The sandbox package SHALL export a `Plugin` type describing a composable extension to the sandbox.

```ts
type Plugin = {
  name: string;
  dependsOn?: string[];
  worker: (ctx: SandboxContext, deps: DepsMap, config: SerializableConfig) => PluginSetup | void;
};
```

The `name` field SHALL be a unique identifier across the plugin composition. `dependsOn` SHALL list other plugin names whose `exports` are available via the `deps` parameter. `worker` SHALL be an async-capable function that runs on the worker thread at sandbox init time, receives a `SandboxContext` and the exports of its dependencies, and returns a `PluginSetup` describing the plugin's contribution.

#### Scenario: Plugin name collision throws

- **GIVEN** two plugins in a composition both declaring `name: "timers"`
- **WHEN** the sandbox is constructed
- **THEN** sandbox construction SHALL throw with an error naming the colliding plugins

#### Scenario: Unsatisfied dependsOn throws

- **GIVEN** a plugin with `dependsOn: ["web-platform"]` but no plugin named `"web-platform"` in the composition
- **WHEN** the sandbox is constructed
- **THEN** sandbox construction SHALL throw with an error naming the missing dependency

### Requirement: PluginSetup shape

The sandbox package SHALL define a `PluginSetup` type that a plugin's `worker()` function returns.

```ts
type PluginSetup = {
  source?: string;
  exports?: Record<string, unknown>;
  guestFunctions?: GuestFunctionDescription<any, any>[];
  wasiHooks?: WasiHooks;
  onBeforeRunStarted?: (runInput: { name: string; input: unknown }) => boolean | void;
  onRunFinished?: (result: RunResult, runInput: { name: string; input: unknown }) => void;
};
```

- `source`: guest-side classic-script source evaluated in phase 2 (after guest functions installed, before user source runs).
- `exports`: arbitrary values available to dependent plugins via `deps[pluginName][exportKey]`.
- `guestFunctions`: host-callable bindings installed via `vm.newFunction`.
- `wasiHooks`: hook implementations for WASI overrides (clock, random, fd_write).
- `onBeforeRunStarted`: called before every run. Returns truthy to preserve refStack state through the run.
- `onRunFinished`: called after every run, in reverse topo order. Receives the run outcome and the original run input.

#### Scenario: Plugin returning void provides nothing

- **GIVEN** a plugin whose `worker()` returns `undefined`
- **WHEN** the sandbox is constructed
- **THEN** the plugin SHALL be registered with no guest functions, no source, no hooks, no exports

### Requirement: SandboxContext

The sandbox package SHALL pass a `SandboxContext` to every plugin's `worker()` function with exactly two methods for event emission.

```ts
type SandboxContext = {
  emit: (kind: EventKind, name: string, extra: EventExtra, options?: EmitOptions) => void;
  request: <T>(prefix: string, name: string, extra: { input?: unknown }, fn: () => T | Promise<T>) => T | Promise<T>;
};

type EmitOptions = {
  createsFrame?: boolean;
  closesFrame?: boolean;
};
```

`ctx.emit` SHALL emit a single event. With no options or both options false, it emits a leaf with `ref = current refStack top`. With `createsFrame: true`, it emits and pushes the event's seq onto the refStack (new frame). With `closesFrame: true`, it emits with `ref = current refStack top` and pops the refStack. Both flags true SHALL be treated as a leaf emit with no stack change.

`ctx.request` SHALL be syntactic sugar: emit `${prefix}.request` with `createsFrame: true`, run `fn`, emit `${prefix}.response` (success) or `${prefix}.error` (throw) with `closesFrame: true`. For async `fn`, the pushed seq SHALL be captured locally so the response/error emission uses it explicitly as `ref` even if the refStack has been mutated by interleaving emissions after await.

The sandbox SHALL NOT expose seq, ref, or any refStack primitives to plugin code.

#### Scenario: Leaf emit uses current refStack top as ref

- **GIVEN** a refStack with seq N on top
- **WHEN** a plugin calls `ctx.emit("timer.set", "setTimeout", { input })`
- **THEN** the emitted event's `ref` SHALL equal N

#### Scenario: createsFrame pushes after emit

- **GIVEN** a refStack with seq M on top
- **WHEN** a plugin calls `ctx.emit("trigger.request", name, extra, { createsFrame: true })`
- **THEN** the emitted event's `ref` SHALL equal M
- **AND** after the call, the refStack SHALL have the new event's seq on top

#### Scenario: closesFrame pops after emit

- **GIVEN** a refStack with seq P on top (representing an open frame)
- **WHEN** a plugin calls `ctx.emit("trigger.response", name, extra, { closesFrame: true })`
- **THEN** the emitted event's `ref` SHALL equal P
- **AND** after the call, the refStack SHALL have had its top popped

#### Scenario: ctx.request emits request/response pair

- **GIVEN** `ctx.request("fetch", "GET /api", { input }, async () => response)`
- **WHEN** `fn` resolves successfully
- **THEN** a `fetch.request` event SHALL be emitted with `createsFrame: true` first
- **AND** `fn` SHALL run while the pushed seq is on the refStack top
- **AND** a `fetch.response` event SHALL be emitted with `closesFrame: true` after `fn` resolves
- **AND** the response event's `ref` SHALL equal the request event's `seq`

#### Scenario: ctx.request emits error on throw

- **GIVEN** `ctx.request("fetch", ..., async () => { throw new Error("boom") })`
- **WHEN** `fn` rejects
- **THEN** a `fetch.error` event SHALL be emitted with `closesFrame: true`
- **AND** the error event's `ref` SHALL equal the request event's `seq`
- **AND** the original error SHALL propagate (rethrown to the caller)

### Requirement: GuestFunctionDescription

The sandbox package SHALL define a descriptor type for host-callable guest functions.

```ts
type GuestFunctionDescription<Args, Result> = {
  name: string;
  args: Args;
  result: Result;
  handler: (...args: ArgTypes<Args>) => ResultType<Result> | Promise<ResultType<Result>>;
  log?: { event: string } | { request: string };
  public?: boolean;
};
```

The sandbox SHALL install each descriptor as `globalThis[name]` via `vm.newFunction` wrapping. Args are marshaled per the `args` spec; result is marshaled per the `result` spec. The sandbox SHALL provide a `Guest` vocabulary with at minimum: `Guest.string()`, `Guest.number()`, `Guest.boolean()`, `Guest.object<T>()`, `Guest.array<T>(item)`, `Guest.callable()` (captures guest function into a managed Callable host handle), `Guest.raw()` (passes through unmarshaled guest value), `Guest.void()`.

`log` default when omitted SHALL be `{ request: name }` — the sandbox auto-wraps every handler invocation with `ctx.request(<log.request>, name, { input: args }, () => handler(...args))`. Override via `log: { event: kind }` emits a single leaf event of that kind before handler runs. Override via `log: { request: prefix }` uses a different prefix than the descriptor's name.

`public` default is `false`. When `false`, the sandbox SHALL delete `globalThis[name]` after phase-2 plugin-source evaluation completes. When `true`, the global SHALL remain accessible to user source.

#### Scenario: Default log wraps with descriptor name

- **GIVEN** a descriptor `{ name: "validateSchema", handler: ... }` with no `log` field
- **WHEN** guest calls `validateSchema(...)`
- **THEN** a `validateSchema.request` event SHALL be emitted before handler runs
- **AND** a `validateSchema.response` or `validateSchema.error` event SHALL be emitted after

#### Scenario: log.event emits leaf

- **GIVEN** a descriptor `{ name: "setTimeout", log: { event: "timer.set" }, handler: ... }`
- **WHEN** guest calls `setTimeout(cb, 100)`
- **THEN** exactly one leaf event with kind `timer.set` SHALL be emitted
- **AND** no request/response pair SHALL be emitted for this call

#### Scenario: public: false auto-deleted after phase 2

- **GIVEN** a descriptor with `name: "__sdkDispatchAction"` and no `public` field (defaults false)
- **WHEN** phase-2 plugin-source evaluation completes
- **THEN** `globalThis.__sdkDispatchAction` SHALL be deleted
- **AND** user source (phase 4) SHALL see `typeof globalThis.__sdkDispatchAction === "undefined"`

#### Scenario: public: true preserved for user source

- **GIVEN** a descriptor with `name: "setTimeout"` and `public: true`
- **WHEN** phase-2 evaluation completes
- **THEN** `globalThis.setTimeout` SHALL remain accessible to user source
- **AND** its property descriptor SHALL have `writable: true, configurable: true`

#### Scenario: Callable arg auto-captured

- **GIVEN** a descriptor with `args: [Guest.callable(), Guest.number()]`
- **WHEN** guest calls the function with `(callbackFn, 100)`
- **THEN** the handler SHALL receive a `Callable` object as the first arg, not the raw guest function
- **AND** the Callable SHALL have `.dispose()` and be invocable to fire the guest callback later

### Requirement: WasiHooks

The sandbox package SHALL define a `WasiHooks` type for plugin-provided WASI override implementations.

```ts
type WasiHooks = {
  clockTimeGet?: (args: { label: "REALTIME" | "MONOTONIC"; defaultNs: number }) => { ns?: number } | void;
  randomGet?: (args: { bufLen: number; defaultBytes: Uint8Array }) => { bytes?: Uint8Array } | void;
  fdWrite?: (args: { fd: number; text: string }) => void;
};
```

Each hook receives the `default*` value (what the real WASI implementation would return). Observation-only hooks return void (the sandbox uses the default). Override hooks return `{ ns }` or `{ bytes }` to replace the default. `fdWrite` is observe-only (return value ignored). WASI overrides for unregistered hooks SHALL compute and use the real values with no callback invoked.

Only one plugin across the composition MAY register each hook key; collisions SHALL throw at sandbox construction.

#### Scenario: No plugin registers wasi hooks

- **GIVEN** a sandbox with no wasi plugin in the composition
- **WHEN** guest code triggers a WASI clock call
- **THEN** the real clock value SHALL be used
- **AND** no event SHALL be emitted on that call path

#### Scenario: Observation-only hook preserves default

- **GIVEN** a wasi plugin with `clockTimeGet: ({label, defaultNs}) => { ctx.emit(...); /* no return */ }`
- **WHEN** guest code triggers a WASI clock call
- **THEN** `defaultNs` SHALL be passed to the WASM caller unchanged

#### Scenario: Override hook replaces result

- **GIVEN** a wasi plugin with `clockTimeGet: () => ({ ns: 0n })`
- **WHEN** guest code triggers a WASI clock call
- **THEN** `0n` SHALL be passed to the WASM caller instead of the real value

#### Scenario: Hook-key collision throws

- **GIVEN** two plugins both registering `wasiHooks.clockTimeGet`
- **WHEN** the sandbox is constructed
- **THEN** construction SHALL throw with an error naming the colliding plugins

### Requirement: createWasiPlugin factory

The sandbox package SHALL export a `createWasiPlugin(setup?: (ctx: SandboxContext) => WasiHooks): Plugin` factory. When `setup` is omitted, the plugin SHALL register an empty `wasiHooks` object (no hooks) — WASI calls compute real values and emit nothing. When `setup` is provided, the factory SHALL invoke it in the plugin's `worker()` with the sandbox ctx and use the returned `WasiHooks` as the plugin's registration.

#### Scenario: Inert default

- **GIVEN** `createWasiPlugin()` with no setup
- **WHEN** composed into a sandbox
- **THEN** the plugin's `wasiHooks` SHALL have no hook implementations
- **AND** WASI calls SHALL NOT emit any events

#### Scenario: Caller-provided telemetry

- **GIVEN** `createWasiPlugin((ctx) => ({ clockTimeGet: ({ label, defaultNs }) => { ctx.emit("wasi.clock_time_get", label, { input: { label }, output: { ns: defaultNs } }); } }))`
- **WHEN** guest code triggers a WASI clock call
- **THEN** a `wasi.clock_time_get` leaf event SHALL be emitted
- **AND** the real clock value SHALL be returned to WASM (observation only)

### Requirement: Topo-sorted plugin composition

The sandbox SHALL topologically sort plugins by `dependsOn` before loading their `worker()` functions and SHALL iterate them in topo order for `worker()` invocation, guest-function installation, phase-2 source evaluation, and `onBeforeRunStarted` hooks. Plugins with no dependencies MAY execute in any order relative to their peers. `onRunFinished` hooks SHALL execute in reverse topo order.

#### Scenario: Plugin A dependsOn B — B's worker runs first

- **GIVEN** plugin A with `dependsOn: ["B"]` and plugin B with no dependencies
- **WHEN** the sandbox is constructed
- **THEN** B's `worker()` SHALL be invoked before A's
- **AND** B's `exports` SHALL be available via A's `deps["B"]` parameter

#### Scenario: Circular dependency throws

- **GIVEN** plugin A `dependsOn: ["B"]` and plugin B `dependsOn: ["A"]`
- **WHEN** the sandbox is constructed
- **THEN** construction SHALL throw with an error describing the cycle

### Requirement: Boot phase sequence

The sandbox SHALL execute plugin boot in these phases:

1. **Phase 0 — Module load**: load plugin worker modules, topo-sort, instantiate WASM with WASI imports (hook slots initially empty).
2. **Phase 1 — Plugin worker()**: for each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`. Register returned `guestFunctions` as `vm.newFunction` bindings on `globalThis`. Populate `wasiHooks` slots (collision throws). Store `source`, `exports`, `onBeforeRunStarted`, `onRunFinished`.
3. **Phase 2 — Source eval**: for each plugin in topo order, `vm.evalCode(plugin.source, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
4. **Phase 3 — Private delete**: for each `guestFunctions` entry with `public !== true`, `delete globalThis[name]`.
5. **Phase 4 — User source**: `vm.evalCode(userSource, filename)`.

On failure at any phase, the sandbox SHALL dispose the VM, post an `init-error` worker message, and `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private descriptor globals

- **GIVEN** a plugin with guest function descriptor `{ name: "__internal", public: false }`
- **WHEN** phase 3 executes
- **THEN** `globalThis.__internal` SHALL be `undefined`
- **AND** any plugin source that captured `__internal` into an IIFE closure in phase 2 SHALL retain access via the closure

#### Scenario: Failure in phase 2 triggers cleanup

- **GIVEN** plugin[0] and plugin[1] succeed in phase 2, plugin[2] source throws
- **WHEN** phase-2 evaluation encounters the error
- **THEN** the sandbox SHALL dispose the VM
- **AND** post `{ type: "init-error", error: <serialized> }` to main
- **AND** the worker process SHALL exit
- **AND** user source (phase 4) SHALL NOT have been evaluated

### Requirement: Run lifecycle with onBeforeRunStarted and onRunFinished

The sandbox's `run(name, input)` primitive SHALL execute in these steps:

1. Invoke each plugin's `onBeforeRunStarted({ name, input })` in topo order. If a plugin returns truthy, the sandbox SHALL preserve any refStack state the plugin left. If falsy/void, the sandbox SHALL truncate any pushes the plugin made during the hook.
2. Invoke the guest export: `await vm.callFunction(exportHandle, undefined, input)`.
3. Build a `RunResult`: `{ ok: true, output }` on success, `{ ok: false, error }` on throw.
4. Invoke each plugin's `onRunFinished(result, runInput)` in reverse topo order. Events emitted during these hooks SHALL stamp with the refStack state preserved from step 1.
5. Truncate the refStack back to its pre-run depth (pops any dangling frames).
6. Return the `RunResult`.

#### Scenario: Trigger plugin spans the run via refStack

- **GIVEN** a trigger plugin that emits `trigger.request` with `createsFrame: true` in `onBeforeRunStarted` and returns truthy
- **WHEN** the run executes
- **THEN** events emitted by the guest during the run SHALL have `ref = trigger.request.seq`
- **AND** the trigger plugin's `onRunFinished` SHALL emit `trigger.response` or `trigger.error` with `closesFrame: true` whose `ref` equals `trigger.request.seq`

#### Scenario: onRunFinished emits events in run context

- **GIVEN** a plugin with `onRunFinished` that calls `ctx.emit("timer.clear", "runEnd", ...)` to clean up
- **WHEN** `onRunFinished` fires at run end
- **THEN** the emitted event SHALL flow through `sb.onEvent` to the host
- **AND** the event SHALL carry the run's seq/ref/ts stamps

#### Scenario: Dangling frame auto-cleaned

- **GIVEN** a plugin's `onBeforeRunStarted` that returns truthy but never emits a matching `closesFrame` event
- **WHEN** the run completes
- **THEN** the sandbox SHALL log a warning identifying the dangling plugin
- **AND** SHALL truncate the refStack back to pre-run depth

### Requirement: JSON-serializable plugin config

The sandbox SHALL transfer plugin descriptors from the main thread to the worker via `postMessage`. Each descriptor SHALL be JSON-serializable: `{ name, source: string, dependsOn?: readonly string[], config?: unknown }` where `source` is a pre-bundled ESM source string (loaded inside the worker via `data:text/javascript;base64,<...>` import) produced by the `sandboxPlugins()` vite transform at build time, and `config` is JSON-serializable data. Functions, closures, class instances, and non-serializable values in `config` SHALL cause construction to fail.

#### Scenario: Function in config fails

- **GIVEN** a plugin factory passed config `{ logger: () => {} }`
- **WHEN** the plugin descriptor is serialized for the worker
- **THEN** sandbox construction SHALL throw with an error naming the offending config path

