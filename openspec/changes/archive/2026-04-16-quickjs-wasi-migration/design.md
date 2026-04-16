## Context

The sandbox package (`packages/sandbox`) executes workflow action code inside a QuickJS WASM context. It currently uses `quickjs-emscripten` v0.32.0 with the `@jitl/quickjs-wasmfile-release-sync` variant. The architecture is a Node.js `worker_threads` Worker that hosts the QuickJS runtime, communicating with the main thread via a structured-clone RPC protocol.

The engine provides no control over non-determinism sources. `Date.now()`, `Math.random()`, `crypto.getRandomValues()`, and `performance.now()` all read from real host sources. Web API polyfills (`fetch`, `Blob`, `URL`, `TextEncoder`, etc.) are injected into the bundle by the vite-plugin via `@workflow-engine/sandbox-globals`, which depends on `whatwg-fetch`, `blob-polyfill`, and `mock-xmlhttprequest`.

`quickjs-wasi` (vercel-labs) is a QuickJS-ng binding compiled to WASI (wasm32-wasip1) instead of Emscripten. It provides WASI-level syscall overrides, built-in resource limits, VM snapshotting, and a WASM extension system that includes standard Web APIs implemented natively in C/WASM.

## Goals / Non-Goals

**Goals:**
- Replace the QuickJS engine binding with `quickjs-wasi` while preserving the existing public API shape (`sandbox()`, `Sandbox`, `RunResult`, `SandboxFactory`)
- Enable caller-provided clock and randomness control via WASI overrides
- Replace polyfill-based Web APIs with native WASM extensions
- Add memory limits and execution interrupt support
- Maintain all existing isolation and security guarantees

**Non-Goals:**
- Replay infrastructure (journal storage, replay triggers, event recording) — separate concern
- VM snapshotting integration — future capability, not wired in this change
- JWK export support — known gap, deferred
- Changing the worker_threads RPC architecture or message protocol
- Multi-context-per-runtime support — one VM per sandbox, same as today

## Decisions

### D1: WASI overrides as caller-provided methods

**Decision:** The sandbox factory accepts optional `clock` and `random` override functions in the same options bag where `fetch` and `filename` already live. The sandbox passes them to `QuickJS.create({ wasi: ... })`. When not provided, default WASI behavior applies (real clock, real randomness).

**Rationale:** This follows the existing pattern — the sandbox is a configurable execution environment, not a policy owner. The runtime layer above decides whether to use real or deterministic values. Alternatives considered:
- Hardwired deterministic: Forces every caller to provide seeds, even when not replaying. Rejected — unnecessary coupling.
- Hardwired real: Defers determinism entirely. Rejected — the migration exists specifically to enable this.

### D2: WASM extensions for Web APIs

**Decision:** Load all six available WASM extensions at VM creation: url, encoding, base64, structured-clone, headers, crypto.

**Rationale:** These replace the polyfill chain (`@workflow-engine/sandbox-globals`) with native implementations that run inside the WASM linear memory. Benefits: smaller bundles, no polyfill maintenance, standard-compliant APIs, and — critically — the crypto extension's randomness flows through the WASI `random_get` syscall, making it controllable via the override.

**Known gaps (accepted):**
- `URLSearchParams` constructor only accepts string init (no record/iterable)
- `TextDecoder` supports only UTF-8, UTF-16LE, UTF-16BE (no legacy encodings)
- `structuredClone` does not support the `transfer` option
- `crypto.subtle.exportKey("jwk", ...)` not supported (raw/pkcs8/spki only)

### D3: JS shim for crypto.subtle Promise wrapping

**Decision:** Inject a small JS module at sandbox init that wraps each `crypto.subtle` method: `const orig = crypto.subtle.digest; crypto.subtle.digest = (...args) => Promise.resolve(orig.call(crypto.subtle, ...args))`. This runs inside the QuickJS context, not as a host bridge.

**Rationale:** The WASM crypto extension returns synchronously. The standard WebCrypto API returns Promises. Workflow code should be portable between the sandbox and browser/Node.js without modification. `await` on a non-Promise resolves immediately, so `await crypto.subtle.digest(...)` would work without the shim — but `.then()` chaining and `Promise.all([crypto.subtle.sign(...), ...])` would break. The shim ensures full spec compliance at negligible cost.

### D4: IIFE bundle output format

**Decision:** Change the vite-plugin Rollup output from `format: "es"` to `format: "iife"`. The host reads exports from the IIFE's global namespace object instead of from the ES module namespace handle.

**Rationale:** `quickjs-wasi`'s `evalCode` with `EvalFlags.TYPE_MODULE` does not return a usable module namespace handle — it returns `undefined` or a `Promise`. The underlying `JS_GetModuleNamespace` C API is not exposed in the WASM wrapper. Alternatives considered:
- Append `globalThis.__exports = { ... }` to the ES module bundle: Works but is a workaround for a limitation. Keeps module mode for no practical benefit in a single-file bundled sandbox.
- Evaluate as script mode: Same as IIFE effectively.

IIFE is the cleanest approach — Rollup handles the export wrapping, and the distinction between module and script mode is irrelevant for pre-bundled single-file code (strict mode, scope isolation, top-level await are all non-factors).

### D5: One-level VM architecture

**Decision:** Use `QuickJS.create(options)` which returns a single VM instance (no separate runtime/context split).

**Rationale:** quickjs-wasi uses a one-level model where each `create()` instantiates its own WASM module with dedicated linear memory. The current two-level model (`newRuntime()` → `newContext()`) was never exploited — each sandbox creates one runtime with one context. The one-level model is simpler and provides stronger isolation (no shared memory between VMs).

### D6: Determinism source split

**Decision:** Two categories of non-determinism, handled differently:

1. **Environment reads** (time, randomness) → WASI layer, automatic:
   - `Date.now()` — WASI `clock_time_get`
   - `Math.random()` — seeded from `clock_time_get` at context creation
   - `performance.now()` — QuickJS performance intrinsic via `clock_time_get`
   - `crypto.getRandomValues()`, `crypto.randomUUID()`, key generation — WASI `random_get` via crypto extension

2. **External I/O** → caller-provided bridges, same as today:
   - `fetch` — host bridge (network access)
   - `console` — host bridge (log capture)
   - `setTimeout` / `setInterval` — host bridge (scheduling)
   - Host methods (actions, emit) — host bridge (side effects)

**Rationale:** Clean separation. Everything that "reads from the environment" is controlled at the WASI layer. Everything that "talks to the outside world" is controlled by the caller. The sandbox doesn't decide policy for either.

### D7: Remove opaque CryptoKey reference store

**Decision:** Remove the `storeOpaque` / `derefOpaque` mechanism and the opaque reference store from the bridge factory.

**Rationale:** With the WASM crypto extension, `CryptoKey` objects live entirely inside WASM linear memory as PSA key handles. They never cross the host/guest boundary. The opaque store was necessary because the previous bridge forwarded crypto operations to Node.js, which meant keys had to live on the host side with opaque handles passed into the guest. This indirection is no longer needed.

The residual risk R-S7 (opaque store grows unboundedly) is eliminated. Key memory is managed by the WASM allocator and freed when the VM is disposed.

### D8: Handle API adaptation

**Decision:** Adapt all bridge code from quickjs-emscripten's VM-centric API to quickjs-wasi's handle-centric API.

Mapping:
```
vm.setProp(obj, k, v)     →  obj.setProp(k, v)
vm.getProp(obj, k)        →  obj.getProp(k)
vm.getString(h)           →  h.toString()
vm.getNumber(h)           →  h.toNumber()
vm.dump(h)                →  h.dump()
vm.evalCode(s, f, opts)   →  vm.evalCode(s, f, EvalFlags.*)
runtime.executePendingJobs →  vm.executePendingJobs()
vm.newError({name, msg})  →  vm.newError(msg) + setProp("name", ...)
```

`handle.dup()` and `handle.dispose()` have identical semantics in both libraries.

## Risks / Trade-offs

**[WASM crypto extension gaps] → Accept and document**
JWK export is not supported. The extension covers raw/pkcs8/spki formats. If JWK export becomes needed, it can be added via a host bridge that exports raw from WASM, reimports in Node.js, and exports as JWK. Low complexity but deferred.

**[quickjs-wasi maturity] → Mitigate with comprehensive tests**
quickjs-wasi is a vercel-labs project, less battle-tested than quickjs-emscripten. Mitigation: the existing sandbox test suite covers isolation, crypto, timers, fetch, lifecycle, and error handling. All tests must pass against the new engine. Any behavioral difference surfaces as a test failure.

**[performance.now() via WASI clock — unverified] → Verify during implementation**
The QuickJS performance intrinsic (`Intrinsics.PERFORMANCE`) is assumed to read time via the WASI `clock_time_get` syscall. If it doesn't, `performance.now()` would need to remain a host bridge. Verify in the first implementation task.

**[Sync crypto.subtle may surprise workflow authors] → Mitigated by Promise shim**
The WASM extension returns synchronously, which is non-standard. The JS shim wrapping in `Promise.resolve()` ensures standard behavior. Risk is that the shim is forgotten or incomplete — mitigate by testing `.then()` chaining patterns, not just `await`.

**[IIFE format loses ES module semantics] → Non-issue for bundled code**
Pre-bundled single-file code in an isolated single-use VM gains nothing from ES module mode. Strict mode, scope isolation, and top-level await are all irrelevant in this context.

**[Extension API gaps may surface in production] → Accept as v1 limitations**
URLSearchParams record init, legacy TextDecoder encodings, and structuredClone transfer are not supported. These are documented and unlikely to affect workflow code. If they do, individual gaps can be shimmed.

## Sequences

### Sandbox initialization (new)

```
Main Thread                    Worker Thread                WASM
─────────────────────────────────────────────────────────────────
sandbox(src, methods, opts)
  │
  ├─ spawn Worker ──────────▶  init message received
  │                             │
  │                             ├─ QuickJS.create({
  │                             │    wasm, memoryLimit,
  │                             │    interruptHandler,
  │                             │    wasi: { clock_time_get,
  │                             │            random_get },
  │                             │    extensions: [url, encoding,
  │                             │      base64, structuredClone,
  │                             │      headers, crypto]
  │                             │  })
  │                             │                          ◀── VM ready
  │                             │
  │                             ├─ inject crypto Promise shim
  │                             ├─ setupGlobals(console, timers)
  │                             ├─ installRpcMethods(methods)
  │                             ├─ vm.evalCode(src, file,
  │                             │    EvalFlags.TYPE_GLOBAL)
  │                             │
  │  ◀──── ready ──────────────┤
  │
  └─ return Sandbox
```

### Sandbox run (unchanged shape)

```
Main Thread                    Worker Thread                WASM
─────────────────────────────────────────────────────────────────
sb.run(name, ctx, extra)
  │
  ├─ run message ──────────▶   install extraMethod globals
  │                             │
  │                             ├─ exports = vm.getProp(
  │                             │    vm.global, "__iife_ns")
  │                             ├─ fn = exports.getProp(name)
  │                             ├─ result = vm.callFunction(
  │                             │    fn, vm.undefined, ctx)
  │                             │
  │  ◀── request(method,args)──┤  (host method RPC)
  │  ── response(result) ────▶ │
  │                             │
  │                             ├─ vm.executePendingJobs()
  │                             ├─ timers.clearActive()
  │                             ├─ abort.abort()
  │                             ├─ uninstall extraMethods
  │                             │
  │  ◀──── done(RunResult) ────┤
  │
  └─ return RunResult
```
