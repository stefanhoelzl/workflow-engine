## Context

Today's sandbox (`packages/sandbox`) carries workflow-engine-specific assumptions that the core should not own:

- Four distinct host-bridge patterns: `__*` shims (fetch, emit, hostCallAction, reportError) with per-shim capture-and-delete, a generic `methods` option for caller-provided RPC, direct-bound natives via `vm.newFunction` (timers, console), and a dedicated WASI `{type: "log"}` worker protocol.
- Factory options for runtime-engine concerns: `onEvent`, `logger`, `fetch` (defaulting to `hardenedFetch`).
- `RunContext` (tenant/workflow/workflowSha/invocationId) threaded through every event via `bridge.setRunContext`.
- Runtime-appended `packages/runtime/src/action-dispatcher.js` source blob that installs a locked `__dispatchAction` global around a captured `__hostCallAction` + `__emitEvent`.
- Two-pass method install (`worker.ts:301`) — `__*`-prefixed first so polyfills can capture them, non-`__*` after so tests can override polyfill globals.
- WASI clock/random host overrides that call `bridge.emitSystemCall(...)` to produce `system.call` telemetry events.
- SECURITY.md §2 enumerates ~10 per-shim invariants (one per bridge + method/handler rules).

Each addition has required touching ≥ 5 files (polyfill source, SECURITY.md, sandbox spec, install-host-methods, worker protocol). The surface grew organically, not through a unifying abstraction.

We want the sandbox core to be a generic QuickJS host: WASM instantiation, event stamping (seq/ref/ts), plugin composition, run lifecycle, WASI dispatch. Everything else — bridges, polyfills, event emission semantics, runtime-engine metadata — moves into plugins.

## Goals / Non-Goals

**Goals:**

- Sandbox core owns: WASM hosting, `SandboxContext` (ctx.emit / ctx.request), event stamping on the worker, run lifecycle primitive (`sb.run`), WASI override routing, plugin composition with topo-sort + collision detection.
- Sandbox core emits **zero** application or engine events. All emission flows through plugins' `ctx.emit`/`ctx.request`.
- Worker protocol collapses to three shapes (init, event, ready/init-error/run-result). No `log`, no method RPC, no runtime metadata.
- SECURITY.md §2 collapses to plugin-discipline rules (eight total), not N per-shim invariants.
- Adding a new host-callable surface is a single plugin file.
- Tenant isolation becomes a runtime-layer invariant (runtime stamps metadata post-hoc on every event); sandbox has no tenant concept.
- Web-platform APIs (fetch, setTimeout, console.*) remain writable/configurable per WebIDL; WPT suite still passes.
- Hardened outbound fetch remains structural by default (plugin factory closes over `hardenedFetch`; test override is the only opt-out).
- Flamegraph remains visually identical minus the `system` bar layer (which today often shows redundant inner bars around fetch/hostCallAction).

**Non-Goals:**

- No new run-model support beyond trigger invocations (REPL, batch, replay mode — deferred; the plugin architecture supports them later without core changes).
- No dynamic plugin registration at runtime (all plugins declared at sandbox construction; collisions are construction errors).
- No cross-thread plugin methods. Plugins run entirely worker-side; configuration passed to the worker must be JSON-serializable.
- No formal engine-swap abstraction (the context API is designed to hide QuickJS internals, but no alternative engine is being built in this change).
- No change to `InvocationEvent` shape as seen by downstream consumers (bus, persistence, dashboard). Only the emission path changes.
- No refactor of event-store or bus internals.
- No deletion of `pending/`/`archive/` prefixes. Event shape stays stable.

## Decisions

### 1. Plugin shape with declarative `PluginSetup`

```ts
type Plugin = {
  name: string;
  dependsOn?: string[];
  worker: (ctx: SandboxContext, deps: DepsMap, config: SerializableConfig) => PluginSetup | void;
};

type PluginSetup = {
  source?: string;
  exports?: Record<string, unknown>;
  guestFunctions?: GuestFunctionDescription<any, any>[];
  wasiHooks?: WasiHooks;
  onBeforeRunStarted?: (runInput: { name: string; input: unknown }) => boolean | void;
  onRunFinished?: (result: RunResult, runInput: { name: string; input: unknown }) => void;
};
```

**Alternative considered**: separate `host?` / `worker?` halves (main-thread vs worker-thread). Rejected — nothing fundamentally requires main-thread plugin code (Ajv, hardenedFetch, Node timers all work in workers). Worker-only plugins eliminate RPC machinery, closures, and a whole class of thread-crossing bugs.

**Alternative considered**: imperative `ctx.installGuestFunction(descriptor)` inside `worker()`. Rejected — declarative returns let the sandbox introspect plugins (for testing, docs), move phase-2 deletion of private bindings into core, and avoid ordering bugs inside `worker()`.

### 2. Secure-by-default descriptor visibility

Every `GuestFunctionDescription` defaults to `public: false`, meaning the sandbox auto-deletes `globalThis[name]` after phase-2 plugin-source evaluation completes. Only explicit `public: true` keeps a binding user-visible.

**Rationale**: matches "capture-and-delete" discipline structurally. Reviewers see `public: true` and can scrutinize what's being exposed. Forgetting to `delete globalThis.__X` in plugin source doesn't accidentally leak.

**Alternative considered**: `private: true` opt-in. Rejected — defaults to insecure. Internal bindings are the common case (4 of 5 descriptor sites in the catalog).

### 3. Context API: `emit` + `request` only

```ts
type SandboxContext = {
  emit: (kind: EventKind, name: string, extra: EventExtra, options?: EmitOptions) => void;
  request: <T>(prefix: string, name: string, extra: { input?: unknown }, fn: () => T | Promise<T>) => T | Promise<T>;
};

type EmitOptions = {
  createsFrame?: boolean;   // emit + push event's seq onto refStack
  closesFrame?: boolean;    // emit (ref = current top) + pop refStack
};
```

Seq/ref/ts are stamped internally on the worker and NEVER exposed to plugin code. `createsFrame`/`closesFrame` give explicit control at emit sites, subsuming the pushRef/popRef primitives that current code uses internally.

**Alternative considered**: kind-suffix auto-push (emit(`x.request`) pushes, emit(`x.response`) pops). Rejected — implicit magic. Plugin authors must infer behavior from the literal kind string.

**Alternative considered**: `ctx.pushRef`/`ctx.popRef` primitives on the context. Rejected — footgun-prone (easy to forget pop on error path); current code at `globals.ts:109-112` uses a `finally` to protect the pop.

**Alternative considered**: `runWrapper: (runInput, continueRun) => Promise<unknown>` for trigger plugin. Rejected — function-composition shape is unusual for plugin authors; `onBeforeRunStarted`+`onRunFinished` symmetric pair is more familiar.

### 4. Event stamping stays worker-side; runtime metadata stamped on main

Every event is stamped with `id/seq/ref/ts/at/kind/name/input?/output?/error?` by the bridge on the worker thread (same counter as today). The sandbox does NOT know tenant/workflow/workflowSha/invocationId. Runtime stamps these on every event received via `sb.onEvent` before forwarding to the bus.

**Rationale**: seq monotonicity requires single-authority stamping on the thread where emissions happen (worker). Tenant/workflow/etc. are not needed for stamping or ordering — they're labels attached after the fact. Moving them out of the sandbox makes core reusable (REPL, tests, hypothetical non-workflow-engine uses) and simplifies the sandbox API.

**Alternative considered**: opaque `runMetadata: Record<string, unknown>` passed into `sandbox.run()`, spread into events. Rejected — still requires sandbox core to know there's metadata to spread. Cleaner to stamp entirely post-hoc on main.

### 5. Trigger is a plugin via `onBeforeRunStarted` + `onRunFinished`

```ts
createTriggerPlugin: {
  onBeforeRunStarted: (runInput) => {
    ctx.emit("trigger.request", runInput.name, { input: runInput.input }, { createsFrame: true });
    return true;
  }
  onRunFinished: (result, runInput) => {
    const extra = { input: runInput.input };
    if (result.ok) ctx.emit("trigger.response", runInput.name, { ...extra, output: result.output }, { closesFrame: true });
    else ctx.emit("trigger.error", runInput.name, { ...extra, error: result.error }, { closesFrame: true });
  }
}
```

Truthy return from `onBeforeRunStarted` signals "keep my stack pushes for the run duration." Sandbox auto-balances refStack after the hook if it returns falsy/void; otherwise preserves the state through the run and onRunFinished.

**Rationale**: moves the last core-emitted event category (`trigger.*`) out of core. Sandbox emits zero events, period. Runtime can swap out the trigger plugin for alternatives (e.g., a replay plugin that emits differently).

**Alternative considered**: trigger stays in core. Rejected — "core emits zero events" is a cleaner invariant; the plugin mechanism is expressive enough.

### 6. WASI as sandbox-owned plugin with inert default

`@workflow-engine/sandbox` exports `createWasiPlugin(setup?: (ctx) => WasiHooks): Plugin`. Default (no setup) registers no hooks — WASI calls compute real values, no events emitted. Caller supplies setup for telemetry, replay, deterministic testing, etc.

Hook signatures accept a `default*` argument (defaultNs, defaultBytes) and return optional overrides: `{ ns?: number } | void` for clock, `{ bytes?: Uint8Array } | void` for random. v1 uses observe-only (return void); future replay plugins return override values.

**Rationale**: sandbox package owns the plugin because WASI override dispatch is sandbox-internal machinery (mutable callback slots wired to WASM imports). Making it a plugin preserves the "core emits no events" invariant and opens the door to replay/mocking without core changes.

**Alternative considered**: WASI as a factory option `wasi: { clockTimeGet?, ... }`. Rejected — factory callbacks run on main thread (can't produce worker-stamped events). Keeping telemetry worker-side requires in-worker dispatch to a registered callback.

**Alternative considered**: core emits `wasi.*` events directly. Rejected — carves out an exception to "core emits zero events"; also forecloses the replay use case.

### 7. `log` field on descriptor for declarative lifecycle emission

```ts
guestFunctions: [
  { name: "setTimeout",    log: { event: "timer.set"   }, handler: ..., public: true }
  { name: "clearTimeout",  log: { event: "timer.clear" }, handler: ..., public: true }
  { name: "console.log",   log: { event: "console.log" }, handler: ..., public: true }
  { name: "$fetch/do",           log: { request: "fetch"  }, handler: ... }
  { name: "__sdkDispatchAction", log: { request: "action" }, handler: ... }
  { name: "validateSchema", handler: ... }  // default: log: { request: "validateSchema" }
]
```

Default (no `log`) = `{ request: <descriptor.name> }`, auto-wrapping with request/response/error pair. Override with `log: { event: "..." }` for single-leaf events or `log: { request: "..." }` for differently-named wraps.

**Rationale**: preserves "audit-by-default" without the implicit magic of kind-suffix detection. Plugin authors see the declaration at the descriptor site.

### 8. No `system.*` auto-wrap

Removes `system.request`/`system.response`/`system.error` entirely. Plugins use domain-specific prefixes (`fetch`, `timer`, `action`, `trigger`) via `log` or manual `ctx.request`.

**Rationale**: today's `system.*` auto-wrap around every `install-host-methods.ts` method duplicates information that domain-specific prefixes already carry. Removing it declutters the flamegraph and SECURITY.md.

**Alternative considered**: keep system.* but make it opt-out per descriptor. Rejected — every descriptor would opt out; the feature has no consumer.

### 9. Staged landing (3 PRs)

1. **Core refactor + stdlib creation**: Replace `methods` with `plugins` in sandbox; create `@workflow-engine/sandbox-stdlib`; port polyfills + fetch + timers + console + report-error. Ship with backward-compat adapter accepting legacy `methods` / `onEvent` / `logger` options. Zero consumer changes required.
2. **SDK rewrite**: Move action dispatch from runtime-appended `action-dispatcher.js` into `createSdkSupportPlugin`. `__dispatchAction` → locked `__sdk.dispatchAction`. **BREAKING** — forces tenant bundle re-upload.
3. **Runtime plugin composition**: Drop adapter from step 1; runtime passes explicit plugins; delete `RunContext` from sandbox; runtime stamps metadata in `onEvent`; trigger becomes a plugin.

Step 2 is the only BREAKING one (bundle re-upload). Step 1 is zero-consumer-churn. Step 3 is internal plumbing.

**Alternative considered**: single atomic PR. Rejected — too large; too many moving parts; no clean rollback point.

### 10. Plugin file shape and build-time bundling

A plugin is a TypeScript module with a fixed set of named exports:

```ts
export const name: string;                       // required, static
export const dependsOn?: readonly string[];      // static
export type Config = ...;                        // type-only (erased at build)
export function worker(
  ctx: SandboxContext,
  deps: DepsMap,
  config: Config,
): PluginSetup | Promise<PluginSetup>;
```

No `prepare` / factory / class abstraction. The file contains exactly the worker-side contract; anything else (Ajv schema compilation, serializable-config construction) lives in ordinary consumer code.

**Build-time bundling.** `@workflow-engine/sandbox` ships a vite plugin `sandboxPlugins()` alongside the existing `sandboxPolyfills()`. It resolves `<path>?sandbox-plugin` imports by rollup-bundling the target file with a synthetic entry that re-exports only `worker`:

```ts
// Synthetic rollup entry:
export { worker as default } from "<path>";
```

Standard ESM tree-shaking retains `worker`'s reachable graph and drops everything else — including main-thread-only imports like Ajv, provided those imports are referenced only by consumer-facing helpers in the same file (or not at all). Output is emitted as a single ESM module string.

The virtual module seen by the consumer:

```ts
import plugin from "./plugins/host-call-action?sandbox-plugin";
// plugin = { name: string, dependsOn?: readonly string[], source: string }
```

Composition in runtime is a straightforward spread:

```ts
const descriptors: PluginDescriptor[] = [
  { ...plugin, config: buildConfig(rawInput) },
  // ...
];
```

**Worker-side loading.** `PluginDescriptor.source` is a self-contained ESM module string. The worker's default loader imports it via a `data:` URI:

```ts
const url = `data:text/javascript;base64,` +
            Buffer.from(descriptor.source).toString("base64");
const mod = await import(url);
// mod.default is the `worker` function.
```

The worker constructs a synthetic `Plugin` value from `{ name, dependsOn?, worker: mod.default }` and feeds it into the existing plugin-boot pipeline unchanged.

**Rationale**:
- Worker artifact is sealed — no module resolution against the outer filesystem, no `node_modules` assumptions inside the worker.
- No `"exports"` surgery on `runtime`, `sdk`, or `sandbox-stdlib` — the vite plugin doesn't care about package resolution.
- No package-level dependency cycles — `@workflow-engine/sandbox` stays free of runtime/sdk imports; bundling happens in the consumer's build.
- Heavy main-thread-only deps (Ajv ~200 KB) don't enter worker bundles because they aren't reachable from `worker`. The split of "who compiles schemas" is a consumer-code concern, not a plugin-file concern.
- Plugin authoring is a single file with obvious named exports — no factory indirection, no main/worker duality to explain.

**Alternative considered**: per-package TS→JS build step with `"exports"` pointing at compiled JS (option "a" in PR 2's deferred-task note). Rejected — requires edits to three `package.json` files, creates a parallel `dist/` layout that competes with runtime's existing vite bundle, and makes the runtime (private, never published) carry `"exports"` it doesn't otherwise need. The vite-plugin route keeps the build story inside vite where it already lives.

**Alternative considered**: register a TS ESM loader (tsx) in the worker via `execArgv`. Rejected — moves `tsx` into production dependencies, couples the sealed worker artifact to an outer `node_modules` layout for plugin resolution, and pays TS-loader boot cost per worker spawn.

**Alternative considered**: dedicated `prepare` named export on the plugin file for main-thread config preparation. Rejected — only one plugin in the current catalog (`host-call-action`) has non-trivial preparation; the convention costs ceremony across seven plugins for a benefit (co-location of Ajv code with its consumer) that an ordinary helper in `sandbox-store.ts` provides just as well. If future plugins demand shared preparation logic, a named export can be added without breaking the contract.

**Alternative considered**: bundle Ajv into the `host-call-action` worker bundle and compile schemas inside `worker()`. Rejected — worker bundle grows by ~200 KB per sandbox construction; the `standaloneCode` path generates per-schema validator functions with no Ajv runtime dependency, shipping a few KB of validator source per action instead.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Plugin discipline ("don't leak private binding via global") is convention-enforced | Private-by-default on descriptors + structural deletion by sandbox after phase 2 turns most of the risk into a construction-time behavior, not a review-only check. Locked `__sdk` uses `Object.defineProperty` for structural lock. Remaining risk is reviewer-enforced per plugin (small catalog, ~8 plugins). |
| Removing `system.*` auto-wrap weakens "structural audit coverage" | Default `log = { request: name }` on every descriptor preserves per-method audit. Skipping the wrap requires explicit `log: { event: ... }` or no `log` field (convention). Current behavior is preserved for ~every handler doing nontrivial work. |
| WPT suite moves to sandbox-stdlib — test ownership shifts | `pnpm test:wpt` script target updates to `packages/sandbox-stdlib/test/wpt/`. Same vendored tests, same runner, same skip list. No semantic regression expected. Migration verified by CI. |
| Plugin-to-plugin communication via `deps` is a new pattern | Only `sdk-support` depends on `host-call-action` in the initial catalog. Pattern is minimal and easy to read. dependsOn + `exports` mirrors dependency injection idioms. |
| Bundle re-upload required (step 2) | Documented in upgrade note. Precedent: `bake-action-names-drop-trigger-shim` required the same. Runbook: `wfe upload --tenant <name>` for every tenant, post-deploy. |
| WASI callback slots are mutable and populated post-WASM-instantiation | WASI calls firing before plugin.worker() (e.g., QuickJS internal entropy reads during VM bootstrap) find null callbacks → real values used, no emission. This is identical to today's `if (bridge.getRunContext())` gating for pre-run emissions. Documented edge. |
| Dashboard `flamegraph.ts` kind-union changes | `BarKind` narrows from 4 to 3; `MarkerKind` opens to open-ended strings. Minor `flamegraph.ts` changes; no other UI file touched. |
| Sandbox dispatcher of `ctx.request` for async fn escapes refStack scope | ctx.request captures reqSeq locally for sync portion; for async fn, response/error emissions use the captured seq explicitly rather than stack top. Same pattern as today's timer callback. Document in SandboxContext spec. |
| Loss of runtime method injection (no pass-2 equivalent) | Overrides handled via plugin composition (`createFetchPlugin({fetch: mockFetch})`). Tests re-compose rather than layer. No legitimate use case for runtime injection in current codebase. |
| Trigger plugin is mandatory for trigger.* events | Runtime's default composition includes it. Tests that want silent runs omit it. Sandbox doesn't enforce presence — absent plugin → no trigger.* events, run proceeds silently. |
| Worker-only plugins lose main-thread state access | No current plugin needs main-thread state. Configuration passed via plugin descriptor's `config` field (JSON-serializable). Future plugins needing long-lived main-thread state (e.g., connection pools) can be added as factory-option callbacks on specific plugins; avoid baking it into the core plugin contract. |
