## Context

The sandbox layers four `__*`-prefixed globals on the QuickJS `globalThis`:

| Name | Installed by | Consumed by |
|---|---|---|
| `__hostFetch` | `bridgeHostFetch()` in `packages/sandbox/src/bridge.ts` | `FETCH_SHIM` in `packages/sandbox/src/globals.ts` |
| `__emitEvent` | `installEmitEvent()` in `packages/sandbox/src/worker.ts` | `__dispatchAction` (runtime-appended) |
| `__reportError` | Runtime via `methods` at construction (optional) | `REPORT_ERROR_SHIM` in `packages/sandbox/src/globals.ts` |
| `__hostCallAction` | Runtime via `methods` at construction | `__dispatchAction` (runtime-appended) |

Additionally, the runtime appends JS source to every workflow bundle that installs `globalThis.__dispatchAction`, read on every action call by the SDK's `core.dispatchAction()` helper.

Each of these globals is currently **read/writable by guest code**. Guest code can:

1. Read the raw bridge (e.g., `__hostFetch(method, url, headers, body)`) directly, bypassing the shim layer that validates inputs or wraps error handling.
2. Overwrite the bridge (`globalThis.__hostFetch = myFn`) to install a rogue implementation consumed by every subsequent `fetch()` call in the same run.
3. Overwrite the dispatcher (`globalThis.__dispatchAction = myFn`) to bypass host-side input validation and audit logging for every subsequent action call.

Each vector violates defense-in-depth for the sandbox — the single strongest isolation boundary in the system (see `SECURITY.md` §2). This change closes (1) and (2) for the four `__*` bridge names and (3) for the dispatcher (at least against the replace vector; calling it directly remains possible and is an accepted residual).

**Constraints inherited from the engine:**

- `quickjs-wasi` evaluates source as an IIFE script; ES-module rebinding tricks are not available. Any "replace this function" trick must go through mutable slots owned by the module itself, not by namespace mutation.
- Rollup's IIFE output captures internal `var` bindings in trigger-handler closures at IIFE eval time. Swapping `__wfe_exports__.actionName` does not affect internal references — see `packages/sdk/src/plugin/index.ts:490-492` for the bundle shape.
- The SDK callable reads `globalThis.__dispatchAction` per-call via `core.dispatchAction()` (`packages/core/src/index.ts:86-99`). That lookup must continue to find the dispatcher.

**Stakeholders:**

- Workflow authors: unaffected — all guest-facing surfaces (`fetch`, `reportError`, action callables) continue to work identically.
- Runtime / sandbox maintainers: spec and threat-model contracts update.
- Test code: several direct-call tests need reframing; the per-run `__reportError` override path is deprecated.

## Goals / Non-Goals

**Goals:**

- Remove `__hostFetch`, `__emitEvent`, `__reportError`, `__hostCallAction` from the post-init `globalThis` so guest code cannot read or overwrite them.
- Prevent guest code from replacing `__dispatchAction` via property assignment.
- Preserve all existing guest-facing semantics: `fetch()`, `reportError()`, action callables, crypto, timers all continue to work without change.
- Keep the sandbox package unaware of manifests and action dispatch (the sandbox merely installs whatever `methods` the runtime provides; the runtime's shim does the capture-and-delete for its own names).
- Align `openspec/specs/sandbox/spec.md`, `sdk/spec.md`, `vite-plugin/spec.md`, and `workflow-loading/spec.md` with reality — both for the changes this proposal introduces and for pre-existing drift that this proposal would leave actively misleading.

**Non-Goals:**

- Hide `__dispatchAction` completely. Making it invisible would require either (a) a new `setDispatcher` indirection in `@workflow-engine/core` or (b) a per-action binder on SDK callables. Both were considered; both add SDK/core surface area; neither closes the underlying threat (guest can still call the live dispatcher) beyond what property locking already achieves. Deferred.
- Hide `__trigger_<name>` and the IIFE namespace `__wfe_exports__`. These live on the guest's own exports namespace; guest code can reach the underlying handlers trivially (`myTrigger.handler(payload)`) without going through the underscore-prefixed wrappers. Hiding adds complexity with no security value.
- Add a URL allowlist to `__hostFetch` (tracked separately as `R-S4`).
- Switch the sandbox evaluation model away from IIFE. That would require engine-level changes to `quickjs-wasi`.

## Decisions

### D1: Capture-and-delete via shim IIFEs

Each shim that consumes a `__*` bridge captures the bridge reference into its IIFE closure at install time, then deletes the global. After the shim returns, the reference lives only inside the closure; the global name is `undefined` from guest code's perspective.

```
        ┌─────────────────────────────────────────────────────────┐
        │   handleInit() — sequential                             │
        ├─────────────────────────────────────────────────────────┤
        │                                                         │
        │  1. bridgeHostFetch() → install globalThis.__hostFetch  │
        │                                                         │
        │  2. eval FETCH_SHIM (IIFE):                             │
        │        var _hostFetch = globalThis.__hostFetch; ← capture
        │        Object.defineProperty(globalThis, 'fetch', {...})│
        │        delete globalThis.__hostFetch;         ← delete  │
        │                                                         │
        │  3. installEmitEvent() → install globalThis.__emitEvent │
        │                                                         │
        │  4. installRpcMethods(methodNames) → install            │
        │     globalThis.__hostCallAction and optionally          │
        │     globalThis.__reportError                            │
        │                                                         │
        │  5. eval TRIVIAL_SHIMS (self, navigator) — unchanged    │
        │                                                         │
        │  6. eval REPORT_ERROR_SHIM (IIFE):                      │
        │        var _report = globalThis.__reportError; ← capture│
        │        globalThis.reportError = function(err) {         │
        │          try { _report(serialize(err)); } catch {} };   │
        │        delete globalThis.__reportError;       ← delete  │
        │                                                         │
        │  7. eval workflow bundle source (IIFE)                  │
        │                                                         │
        │  8. eval ACTION_DISPATCHER_SOURCE (IIFE):               │
        │        var _hostCall = globalThis.__hostCallAction;     │
        │        var _emit = globalThis.__emitEvent;   ← capture  │
        │        Object.defineProperty(globalThis,                │
        │          "__dispatchAction",                            │
        │          { value: dispatch,                             │
        │            writable: false,                             │
        │            configurable: false });        ← lock install│
        │        delete globalThis.__hostCallAction;  ← delete    │
        │        delete globalThis.__emitEvent;                   │
        │                                                         │
        └─────────────────────────────────────────────────────────┘

  POST-INIT globalThis __* SURFACE:
    __dispatchAction (locked, guest-callable)
    __wfe_exports__ (IIFE namespace — not a __* bridge)
    Nothing else.
```

**Why this shape**: each shim already exists as a JS-source IIFE evaluated into the VM. Adding a `var _name = globalThis.__name; ...; delete globalThis.__name` wrapper to the existing IIFE is a local edit. No new module, no new wire format, no indirection in `core` or the SDK. The capture is lexical and QuickJS-supported; deletion is a standard JS operation; neither needs engine changes.

**Alternatives considered:**

- **`Object.defineProperty` with `enumerable: false, configurable: false`**: still readable via `globalThis['__hostFetch']`. Rejected — meets enumeration hiding only, not reachability.
- **Proxy on `globalThis`**: heavy, intercepts all global reads, unknown interaction with WASM extension globals. Rejected — not needed when capture-and-delete works.
- **Random per-VM renaming**: security through obscurity. Rejected.

### D2: Dispatcher remains exposed but locked

`__dispatchAction` stays on `globalThis` because the SDK's `core.dispatchAction()` helper reads it per-call. Two forms of hiding were considered and rejected for this change:

- **Shape A — shared `setDispatcher` in core**: module-scoped `_dispatcher` in `@workflow-engine/core` populated via an exported `setDispatcher(fn)`. SDK unchanged. Bundle must re-export `setDispatcher`. Runtime shim calls it once.
- **Shape B — per-action binder**: SDK callable gains a one-shot `__setDispatcher(fn)` slot. Runtime shim loops actions and binds.

Both add SDK/core API surface and must thread correctly through the two-layer name-binding flow (plugin-time + runtime-append). The security benefit is limited: the accepted residual (guest calling the live dispatcher directly to emit misleading audit events) is present regardless of how the dispatcher is installed. What property-locking closes is the swap vector:

```
Without lock:   globalThis.__dispatchAction = myFn  →  all future action
                                                        calls route through myFn
                                                        (bypasses __hostCallAction
                                                        validation + event emission)

With lock:      globalThis.__dispatchAction = myFn  →  TypeError in strict mode,
                                                        silent no-op in sloppy mode.
                                                        Guest cannot redirect the
                                                        dispatcher.
```

**Residual risk accepted**: guest calls the live (locked) dispatcher with `(validActionName, realInput, fakeHandler, fakeSchema)`. The host-side `__hostCallAction` (called via the dispatcher's captured closure) runs input validation against the real manifest schema and audit-logs the call as the real action name. The dispatcher then runs the guest-supplied `fakeHandler` (already inside the sandbox) and invokes `fakeSchema.parse()` on its return. The final `action.response` event claims the real action ran successfully when in fact the fake handler ran. This is an audit-log integrity concern, not an escape-from-sandbox concern, and is documented as an accepted residual in `SECURITY.md` §2.

### D3: Construction-time-only `__reportError`

The current spec allows per-run `extraMethods.__reportError` to override the construction-time implementation for the duration of a single run. Under the new model:

- `REPORT_ERROR_SHIM` captures `__reportError` **once** at init and deletes it from `globalThis`.
- Per-run `extraMethods.__reportError` would install a fresh global during the run, but the shim does not re-read from `globalThis` on each call — it uses its captured reference from init time. So a per-run override would silently do nothing for the `reportError()` shim path (it would only be callable if a test invokes it by name directly, which is no longer possible for guest code anyway).

Rather than keep a broken override path, the override semantics are removed from the spec and the corresponding test is deleted. Consumers that need a per-run `reportError` capture (none today) can instead construct a fresh sandbox per such run — which is already the lifecycle expectation for non-production test rigs.

### D4: `RESERVED_BUILTIN_GLOBALS` drops `__hostFetch` and `__emitEvent`

The reservation list today prevents `methods` / `extraMethods` from installing names that collide with sandbox built-ins. The list currently contains `__hostFetch` and `__emitEvent` among others.

Under the new model, hiding is enforced by the capture-and-delete shims, not by the reservation list. A host that deliberately passes `extraMethods: { __hostFetch: altFn }` is making a conscious choice to reinstall that name for the duration of one run — the sandbox's built-in was already captured into the shim closure by init, so reinstalling the name has no effect on `fetch()` behavior. It merely makes the name available as a fresh host method the guest can call directly.

Keeping `__hostFetch` and `__emitEvent` in the reservation list would block this pattern unnecessarily. The principle is:

- **Sandbox-internal built-ins** must not leak to guest. Enforced by shims, not by the reservation list.
- **Host's explicit provision** (via `methods` or `extraMethods`) should be honored as the host's conscious choice.

`__hostCallAction` and `__reportError` were never in the reservation list (they are runtime conventions the sandbox package is oblivious to); no change needed for those.

### D5: Delete `__setActionName` after runtime binding

After `buildActionNameBinder` calls `__setActionName(exportName)` on each action callable, the binder shim also `delete`s the property. The SDK's action callable object is no longer marked as configurable for this property after deletion — the next access returns `undefined`, and guest code that somehow retains a reference to the method gets a `TypeError` on invocation. This is hygiene rather than security (the binder is idempotent and one-shot today, so re-invocation throws or no-ops).

### D6: Spec alignment beyond the narrow change

The SDK spec (L76) and vite-plugin spec (L115, L121) describe the SDK action callable body as `(input) => __hostCallAction(<name>, input)` and claim the plugin "fills in `<name>` during the build pass". Both claims are stale pre-proposal:

- The callable body actually calls `core.dispatchAction(name, input, handler, outputSchema)` → `globalThis.__dispatchAction(...)`.
- The plugin does not source-rewrite the callable body; it calls `__setActionName` on a Node-side Action instance during build (for manifest derivation), and the runtime separately appends a `buildActionNameBinder` shim that calls `__setActionName` inside the sandbox at eval time (the VM has a fresh closure distinct from the Node-side instance).

Post-proposal, the first drift point becomes actively false because `__hostCallAction` is no longer reachable at all. Rather than leave a broken description to be fixed in a follow-up change, this proposal rewrites both SDK and vite-plugin requirements to describe the actual two-layer dispatch + two-layer name binding.

The `workflow-loading` spec's `__hostCallAction bound to workflow's manifest` scenario is narrower and continues to describe host-side behavior correctly; only the scenarios that imply guest-side direct visibility are adjusted.

### D7: New `__emitEvent` requirement

The sandbox spec has no existing Requirement block for `__emitEvent` — it is documented only in `SECURITY.md` §2. This is a pre-existing gap. Rather than continue the gap, this proposal adds a new requirement for `__emitEvent` that describes its full lifecycle: installed at init, captured by the dispatcher shim, deleted before guest code can reach it. This matches the shape of the rewritten `__hostFetch` and `__reportError` requirements.

## Risks / Trade-offs

- [**Risk**: A host that constructs a sandbox without passing `__reportError` at construction time cannot later enable `reportError` capture for a specific run] → **Mitigation**: The construction-time binding is the canonical place to enable capture; tests that previously used per-run overrides to toggle capture are rewritten to construct fresh sandboxes. If a real use case emerges (none known today) the spec can be revised.

- [**Risk**: Tests currently calling raw `__hostCallAction` / `__emitEvent` from guest code all break simultaneously] → **Mitigation**: those tests exercise bridge surface inventory and error propagation at the raw level. Rewriting them to exercise via the SDK action callable path is more faithful to the real usage pattern; the bridge itself continues to be testable from the host side by inspecting the `system.request` / `host.validateAction` events on the event stream.

- [**Risk**: Future engine swaps that change IIFE semantics could invalidate the "shim capture before bundle eval" assumption] → **Mitigation**: the capture ordering is explicit in `handleInit` and covered by post-init surface-inventory tests; any engine swap would surface the break immediately.

- [**Trade-off**: The accepted residual on `__dispatchAction` means audit-log integrity is not forensic-grade] → **Documentation**: this is documented in `SECURITY.md` §2 so future reviewers evaluating the audit log's integrity understand the guarantee level.

- [**Risk**: `Object.defineProperty(globalThis, "__dispatchAction", { writable: false, configurable: false })` survives across runs; a future change that needs to swap the dispatcher per-run cannot do so] → **Mitigation**: no such use case exists today; the dispatcher is installed once at init and invariant for the life of the sandbox. If a future change needs per-run dispatcher swaps, the lock can be removed in that proposal.
