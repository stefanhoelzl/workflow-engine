## Context

The QuickJS sandbox currently exposes `self` and `navigator` as identity/frozen-object shims, and `reportError` as a guest-side shim that forwards to an `__reportError` host bridge. It does NOT expose `EventTarget`, `Event`, `AbortController`, or `AbortSignal`. The existing `reportError` spec requirement at `openspec/specs/sandbox/spec.md:451-468` explicitly commits to evolving "when EventTarget is shipped in a future round" — this change is that round.

`DOMException` already exists in the guest (provided natively by `quickjs-wasi` 2.2.0's WASM crypto/webidl extensions) and is proven functional by the passing `webidl/ecmascript-binding/es-exceptions/**` WPT subtree. It is, however, absent from `RESERVED_BUILTIN_GLOBALS` in `packages/sandbox/src/index.ts` and from the `SECURITY.md §2` allowlist prose — a pre-existing documentation gap this change closes while it is opening the allowlist anyway.

The sandbox publishes raw TypeScript (`exports: { ".": "./src/index.ts" }`) and is bundled by consumers. `packages/runtime/vite.config.ts` already runs vite with `ssr.noExternal: true`, walking into the sandbox source during its build. Existing inline shims (`TRIVIAL_SHIMS`, `REPORT_ERROR_SHIM`, `FETCH_SHIM`) live as template-string constants in `packages/sandbox/src/globals.ts` and are evaluated via `vm.evalCode()` in `packages/sandbox/src/worker.ts` during `handleInit`.

Verified up-front (probes, now removed):
- QuickJS 2.2.0 accepts `Object.setPrototypeOf(globalThis, proto)` with no restrictions; own-property keys remain clean and existing globals remain reachable.
- `DOMException` constructs with `(message, name)`, exposes `name`/`message`, satisfies `instanceof Error` and `instanceof DOMException`, and reports `[object DOMException]` via `toStringTag`.
- `event-target-shim@6.0.2` UMD (18KB, already IIFE-shaped) parses in QuickJS and delivers events end-to-end: `isTrusted=false`, `target`/`currentTarget` set during dispatch, `once`/`signal` options auto-remove listeners.
- `class AbortSignalLike extends EventTarget` (the shim's subclass path) works with no workaround: constructor chains correctly, instanceof and dispatch all functional.
- Bundle init cost: ~37KB of polyfill IIFE adds no measurable time vs. the empty-handler baseline (both round to ~2ms per invocation).

One compatibility bump discovered: the shim stores instance state in a `WeakMap(this → ...)` inside its constructor. Calling `EventTarget.call(globalThis)` to retrofit globalThis fails via Babel's `_classCallCheck`. Pure `setPrototypeOf(globalThis, EventTarget.prototype)` also fails at method-invocation time because the shim's `this` has no entry in the state WeakMap.

## Goals / Non-Goals

**Goals:**

- Ship the EventTarget/Event/AbortController/AbortSignal cluster as guest-visible globals, backed by a pure-JS polyfill with no host-bridge surface.
- Complete the pre-committed evolution of `reportError` to dispatch an `ErrorEvent` before forwarding to the host bridge.
- Wrap `queueMicrotask` so uncaught microtask exceptions route through the same `ErrorEvent` pathway, satisfying `queue-microtask-exceptions.any.js`.
- Make `globalThis` an `EventTarget` (both `instanceof` and functional method access) so `self.addEventListener("error", ...)` works as WPT / Worker specs expect.
- Bundle via a single Vite virtual-module plugin so `vite build` in `packages/runtime` (the existing single build entry point) produces the complete polyfill with no additional user-facing build steps.
- Migrate the existing inline template-string shims to typed `.ts` files, shared under the same plugin — consolidating the sandbox's guest-side JS surface under one auditable bundle.
- Close the pre-existing `DOMException` documentation gap in `RESERVED_BUILTIN_GLOBALS`, `SECURITY.md §2`, and the sandbox spec.

**Non-Goals:**

- Promise `unhandledrejection` event wiring. Requires a QuickJS promise-rejection-tracker host hook; no WPT tests on the current skip list depend on it.
- Fixing quickjs-wasi's `DOMException` WebIDL descriptor enumerability or `[[ErrorData]]` internal slot. Tracked as upstream quickjs-wasi issues; existing subtest-level skip entries remain.
- Minification of the polyfill bundle. Readability for `§2` audit outweighs the ~20KB saved; measurement shows no perf cost.
- Adding new host-bridge methods. The entire cluster is pure guest-side JS.
- Exposing EventTarget on Workers-style nested globals. The sandbox has one global object (`globalThis`); this change covers that object.

## Decisions

### Decision 1: Use `event-target-shim@6` for the EventTarget/Event core; hand-write AbortController/AbortSignal on top

**Rationale:** The shim provides the spec-heavy 80% — real `Event` class, `isTrusted=false`, `target`/`currentTarget` assignment, once/passive/signal listener options, plain-object-to-Event wrapping. It has no runtime dependencies, is MIT-licensed, and weighs ~18KB UMD / ~37KB ESM.

`abort-controller@3` (the companion package) was considered and rejected:
- Implements the 2019 spec surface only — missing `signal.reason` (2021), `signal.throwIfAborted()` (2022), `AbortSignal.abort(reason?)` (2022), `AbortSignal.timeout(ms)` (2021), and `AbortSignal.any(signals)` (2023). Three of our five `dom/abort/**` target tests depend on these.
- `peerDependencies` declare `event-target-shim@^5` while we want `^6` — a lying peer-dep requiring manual pinning.
- Hand-writing `AbortController` + `AbortSignal` on top of the shim costs ~120 LOC, which we'd be writing as a tail anyway for the missing 2021–2023 statics. Eliminating the 5-year-old dep removes the weakest link without increasing net complexity.

Option C (hand-write everything, no npm deps) was also rejected: EventTarget is where the spec complexity concentrates — listener option normalization, dispatch re-entrancy snapshots, passive preventDefault no-op semantics, signal auto-removal, the full capture/target/bubble state machine. ~400 LOC of carefully spec-conformant code is exactly the kind of thing to avoid reinventing when a well-tested shim exists.

### Decision 2: Install globalThis as an EventTarget via "Hybrid H" — setPrototypeOf + non-enumerable own-property bound methods

**Rationale:** The shim keys its internal listener-state by the `this` passed to `new EventTarget()`, via a module-private `WeakMap`. That WeakMap is not reachable from outside the shim's closure, so `globalThis` cannot be retrofitted into an instance by calling the constructor. Three approaches were considered:

| Approach | `self.addEventListener` works? | `self instanceof EventTarget`? | `Object.keys(globalThis)` polluted? |
|---|---|---|---|
| Pure `setPrototypeOf` | NO (throws via classCallCheck) | — | — |
| Own-property bound methods only | yes | NO | no (enumerable:false) |
| Hybrid: setPrototypeOf + own-property bound methods | yes | YES | no (enumerable:false) |

We pick hybrid. The real-browser Worker global chain is `WorkerGlobalScope → EventTarget → Object`; making `self instanceof EventTarget` true matches spec expectations and likely what WPT `dom/events/event-global.worker.js` probes. The bound methods use `Object.defineProperty(..., { enumerable: false, writable: true, configurable: true })` so `Object.keys(globalThis)` remains unchanged — the existing `Safe globals — self` scenario "keys of self match globalThis" continues to hold literally (self IS globalThis) and informally.

### Decision 3: Build via a Vite virtual-module plugin exported from the sandbox package

**Rationale:** The user's stated shape is: run `vite build` in `packages/runtime` and get the complete runtime including the polyfill IIFE. Options considered:

| Option | Matches stated shape? | Review surface |
|---|---|---|
| Commit a pre-bundled `polyfill.generated.js`, import via Vite `?raw` | yes | reviewers see committed IIFE in every PR — strong for §2 audit |
| Sandbox-local `vite build` producing a physical file, consumed via `?raw` | yes | same as above but requires sandbox to build before runtime — ordering friction |
| Virtual module via Vite plugin, plugin registered in runtime vite config | yes (user-preferred) | no committed IIFE; mitigated by CI-verified `snapshot.js` |

The user asked to inline / consolidate, preferring a virtual module. Plugin coupling cost: the plugin must be registered in 3 configs (`packages/runtime/vite.config.ts`, root `vitest.config.ts`, `packages/sandbox/test/wpt/vitest.config.ts`) — three one-liner imports. In exchange: no committed generated file, no build-order tangles, and `vite build` in runtime is authoritatively complete.

For §2 audit, we commit `packages/sandbox/src/polyfills/snapshot.js` as a reference-only artifact (never imported at runtime) and add a CI step that re-runs the plugin and fails if the committed snapshot diverges. Reviewers get a reliable diff; runtime code stays decoupled.

### Decision 4: Consolidate existing TRIVIAL_SHIMS / REPORT_ERROR_SHIM / FETCH_SHIM into the same plugin entry

**Rationale:** The plugin is going to concatenate multiple shims regardless (event-target-shim output, AbortController tail, ErrorEvent class). Pulling the three existing template-string shims in lets us:

- Migrate from escape-heavy template literals in `.ts` to proper typed `.ts` files in `packages/sandbox/src/polyfills/` — syntax-highlighted, Biome-lintable, refactorable.
- Collapse `worker.ts`'s 3 `vm.evalCode()` calls to 1. Single init step, single sourceURL, one deterministic install order.
- Enforce install order via ES module execution: `entry.ts` imports the shims in dependency order (`trivial` → `event-target` → `report-error` → `microtask` → `fetch`), and rollup's tree-shake + module-ordering guarantee does the rest.
- `__WFE_VERSION__` template interpolation moves from scattered `${PACKAGE_VERSION}` in `.ts` to a single `@rollup/plugin-replace` config in the plugin.

Cost: migration diff is larger. Benefit: one auditable bundle, and adding future polyfills (Streams, FileReader) is one `import` line in `entry.ts`.

### Decision 5: Hand-write AbortController/AbortSignal as subclasses of the shim's EventTarget, using a `WeakMap<AbortSignal, reason>`

**Rationale:** The shim's subclass path (`class AbortSignalLike extends EventTarget { ... }`) was verified to work end-to-end — constructor chains correctly, instanceof propagates, `dispatchEvent` is routed through the shim's machinery. We write:

```ts
class AbortSignal extends EventTarget { ... }
class AbortController { signal = new AbortSignal(); abort(reason?) { ... } }
```

`reason` lives in a module-private `WeakMap<AbortSignal, unknown>` rather than as an instance property, so that `signal.aborted === (reason-has-been-set)` is consistent even when the abort event fires before `reason` is formally assigned.

Default abort reason is `new DOMException("signal is aborted without reason", "AbortError")`; default timeout reason is `new DOMException("signal timed out", "TimeoutError")` — using the native quickjs-wasi DOMException, not a polyfilled one.

### Decision 6: Evolve `reportError` to dispatch-then-forward; wrap `queueMicrotask` to route through `reportError`

**Rationale:** Spec-mandated and simple. `reportError(err)` builds an `ErrorEvent` with `cancelable: true`, dispatches on `globalThis`, and forwards to `__reportError` only if `!event.defaultPrevented`. `queueMicrotask(cb)` is wrapped so `try { cb() } catch (err) { globalThis.reportError(err) }` — a single routing point for microtask errors. Together they flip `queue-microtask-exceptions.any.js`.

Host-side `__reportError` signature is unchanged; this is purely a guest-side evolution.

## Sequence — polyfill bootstrap

```
sandbox() constructor
   │
   ▼
worker.handleInit()
   │
   ├── install host-bridge methods (__reportError, __hostFetch, __emitEvent, …)
   │
   ▼
vm.evalCode(POLYFILLS)      ◀── single call, IIFE from virtual:sandbox-polyfills
   │
   ├── trivial.ts              self = globalThis, Object.freeze(navigator)
   │
   ├── event-target.ts         class EventTarget, Event, ErrorEvent (from shim)
   │                           class AbortSignal extends EventTarget
   │                           class AbortController
   │                           Object.setPrototypeOf(globalThis, ET.prototype)
   │                           Object.defineProperty(globalThis, "addEventListener",
   │                             { value: _et.addEventListener.bind(_et),
   │                               enumerable: false, writable, configurable })
   │                           [same for removeEventListener, dispatchEvent]
   │                           (DOMException already native — just used)
   │
   ├── report-error.ts         reportError = (err) => {
   │                             const ev = new ErrorEvent("error", {...});
   │                             if (globalThis.dispatchEvent(ev))
   │                               __reportError(serialize(err));
   │                           }
   │
   ├── microtask.ts            const orig = globalThis.queueMicrotask;
   │                           globalThis.queueMicrotask = (cb) => orig(() => {
   │                             try { cb(); } catch (e) { globalThis.reportError(e); }
   │                           });
   │
   └── fetch.ts                [existing FETCH_SHIM, migrated verbatim]
```

## Sequence — `reportError` dispatch flow

```
guest calls reportError(err)
   │
   ▼
reportError shim
   │
   ├── const ev = new ErrorEvent("error", { error: err, message, cancelable: true })
   │
   ▼
globalThis.dispatchEvent(ev)
   │
   ├── delivers to listeners registered via self.addEventListener("error", ...)
   │   (routed through the private _et instance)
   │
   └── returns !defaultPrevented
          │
          ├── true  → __reportError(serialize(err)) → host telemetry
          └── false → skipped (listener silenced the report)
```

## Sequence — microtask exception flow (satisfies `queue-microtask-exceptions.any.js`)

```
guest calls queueMicrotask(cb)
   │
   ▼
wrapped queueMicrotask
   │
   ├── origQM(() => { try { cb() } catch (err) { globalThis.reportError(err) } })
   │
   (native QuickJS microtask drain)
   │
   ▼
cb() throws
   │
   ▼
catch → reportError(err) → dispatch(ErrorEvent) → listener fires → WPT passes
```

## Sequence — consumer build flow

```
pnpm build  (runs pnpm -r build; in runtime this invokes vite build)
   │
   ▼
packages/runtime/vite.config.ts
   plugins: [sandboxPolyfills(), …]
   ssr.noExternal: true
   │
   ▼
vite walks runtime source → sandbox source (workspace dep)
   │
   ▼
encounters `import POLYFILLS from "virtual:sandbox-polyfills"` in worker.ts
   │
   ▼
sandboxPolyfills plugin resolveId/load:
   │
   ├── rollup(entry.ts, [replace(__WFE_VERSION__), esbuild(target: es2022), nodeResolve])
   │
   ├── bundle.generate({ format: "iife", name: "__sandboxPolyfills" })
   │
   └── return `export default ${JSON.stringify(iifeString)};`
   │
   ▼
runtime's vite bundle includes POLYFILLS as a module-level string constant
   │
   ▼
at sandbox construction: vm.evalCode(POLYFILLS, "<sandbox-polyfills>")
```

## Risks / Trade-offs

- [Shim spec-bug surfaces at subtest level] → record precise subtest-level skip entries with reasons; open upstream issues on `mysticatea/event-target-shim` if they're spec-fidelity gaps.
- [Plugin must be registered in 3 configs — drift risk if new vitest/vite config is added without the plugin] → document the registration requirement in `packages/sandbox/src/polyfills/README.md`; add a `grep` lint in CI that checks every `vite.config.ts` / `vitest.config.ts` in the repo imports `sandboxPolyfills`.
- [`snapshot.js` CI diff check goes stale if plugin output changes indeterministically] → the plugin is deterministic (pinned deps, no timestamps in IIFE); if any nondeterminism appears, switch to hash-based check.
- [`setPrototypeOf(globalThis, ...)` breaks under a future quickjs-wasi upgrade] → add a sandbox init-assertion: `typeof globalThis.addEventListener === "function" && globalThis instanceof EventTarget`.
- [`AbortSignal.timeout` callback retains closure past signal GC] → bounded by the existing QuickJS memory cap; no observable leak within a single run.
- [Guest code calls `event.preventDefault()` in `reportError` listener to silence `__reportError` telemetry] → documented in §2 residual-risks; grants no new attacker capability (the guest could already elect not to call `reportError`).
- [`event-target-shim@6` is frozen at Jan 2021] → its spec surface is stable (EventTarget / Event core doesn't move much); any fixes we need can be patched locally with a plugin post-transform step without forking.
- [`RESERVED_BUILTIN_GLOBALS` addition is breaking for any consumer passing `EventTarget`/`AbortController`/etc as an `extraMethods` key] → no current consumers do so; this is a correctness fix (guest globals should always win over host overrides).

## Migration Plan

This is an additive change — no data migration. Deploy order:

1. Land the polyfill + plugin + worker wiring in one commit series.
2. Flip WPT spec entries in the same change; CI's `pnpm test:wpt` must still pass (tests move from skip to pass).
3. Amend `SECURITY.md §2` and `openspec/specs/sandbox/spec.md` in the same change (§2-level guardrail in `CLAUDE.md`).
4. Rollback: revert the commit; shim and hand-written code disappear; `globalThis` returns to no-EventTarget state; preamble stubs return.

No staged rollout needed — the sandbox is a single-process component; the polyfill is either installed or it isn't.

## Open Questions

None at propose time. All uncertainties were resolved during the exploration probes (Object.setPrototypeOf compat, DOMException availability, shim UMD execution, subclass path, hybrid install).
