## Why

The current sandbox uses `quickjs-emscripten` which provides no control over non-determinism sources (`Date.now()`, `Math.random()`, `crypto.getRandomValues()`). Reproducible replay requires the ability to control all sources of non-determinism at the engine level. `quickjs-wasi` (vercel-labs) provides WASI-level overrides for clock and randomness, built-in memory limits and interrupt handlers, and VM snapshotting — all missing from the current implementation.

## What Changes

- **Replace `quickjs-emscripten` + `@jitl/quickjs-wasmfile-release-sync` with `quickjs-wasi`** as the QuickJS WASM binding in `@workflow-engine/sandbox`. **BREAKING**: dependency swap.
- **Add WASM extensions** (url, encoding, base64, structured-clone, headers, crypto) to run standard Web APIs natively inside the sandbox instead of bridging or polyfilling them.
- **Remove the `@workflow-engine/sandbox-globals` polyfill chain** (whatwg-fetch, blob-polyfill, MockXhr, etc.) — the WASM extensions and a thin JS shim replace them.
- **Add caller-provided WASI overrides** for `clock_time_get` and `random_get` to the sandbox factory API, following the same pattern as existing caller-provided methods (fetch, host actions). The sandbox is agnostic about real vs. deterministic values.
- **Switch vite-plugin Rollup output from `format: "es"` to `format: "iife"`** — quickjs-wasi does not expose the ES module namespace from `evalCode`, so exports are accessed via a global namespace object instead.
- **Add a JS shim inside the sandbox** that wraps `crypto.subtle` methods in `Promise.resolve()` to match the standard WebCrypto API (the WASM crypto extension returns synchronously).
- **Remove the host-bridged crypto implementation** (`crypto.ts`) — replaced by the WASM crypto extension. The opaque CryptoKey reference store is no longer needed since keys live entirely inside the WASM linear memory.
- **Remove the host-bridged `performance.now()`** — replaced by the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall (automatically controlled by the caller's clock override).
- **Add built-in `memoryLimit` and `interruptHandler`** configuration to the sandbox factory, exposing quickjs-wasi's native resource limits.
- **Adapt the bridge factory** to quickjs-wasi's handle API (`h.setProp()` / `h.getProp()` / `h.toString()` / `h.toNumber()` / `h.dump()` instead of `vm.setProp(h, ...)` / `vm.getString(h)` / etc.).

## Capabilities

### New Capabilities

(none — determinism features are added as new requirements within the existing `sandbox` capability)

### Modified Capabilities

- `sandbox`: Engine swap from quickjs-emscripten to quickjs-wasi. Changes to: VM creation (one-level `QuickJS.create()` vs. two-level runtime/context), module evaluation (IIFE + globalThis instead of module namespace), crypto implementation (WASM extension instead of host bridge), performance.now (intrinsic instead of bridge), handle API surface. New requirements: caller-provided WASI overrides for clock and randomness, memory limits, interrupt handler. Worker-thread architecture and RPC protocol unchanged.
- `vite-plugin`: Rollup output format change from `"es"` to `"iife"`. Removal of `sandbox-globals` polyfill injection (replaced by WASM extensions).

## Impact

- **`packages/sandbox`**: Full rewrite of engine layer (`worker.ts`, `bridge-factory.ts`, `globals.ts`, `crypto.ts`, `bridge.ts`). Public API (`sandbox()`, `Sandbox`, `RunResult`, `SandboxFactory`) stays the same shape but gains new options.
- **`packages/vite-plugin`**: Rollup output format change, removal of sandbox-globals import injection.
- **`packages/sandbox/package.json`**: Replace `quickjs-emscripten` + `@jitl/quickjs-wasmfile-release-sync` with `quickjs-wasi`.
- **Tests**: All sandbox tests need updating for the new engine, but test semantics (isolation, lifecycle, bridging) remain the same.
- **Security boundary**: The set of globals exposed to guest code changes (WASM extensions add url/encoding/base64/structured-clone/headers/crypto natively; polyfill-provided globals are removed). `/SECURITY.md §2` must be updated.
- **Known gap**: `crypto.subtle.exportKey("jwk", ...)` is not supported by the WASM crypto extension. JWK import works. JWK export can be added later via a host bridge when needed.
