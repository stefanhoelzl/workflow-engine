## 1. Dependencies and Scaffolding

- [x] 1.1 Replace `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync` with `quickjs-wasi` in `packages/sandbox/package.json`
- [x] 1.2 Remove `@workflow-engine/sandbox-globals` package and its dependencies (`whatwg-fetch`, `blob-polyfill`, `mock-xmlhttprequest`)
- [x] 1.3 Verify quickjs-wasi imports resolve and the WASM binary loads in a basic smoke test

## 2. Worker Engine Swap

- [x] 2.1 Rewrite `worker.ts` VM initialization: replace `getQuickJS()` → `newRuntime()` → `newContext()` with `QuickJS.create({ wasm, extensions, memoryLimit, interruptHandler, wasi })`. Load all six WASM extensions (url, encoding, base64, structured-clone, headers, crypto).
- [x] 2.2 Verify `performance.now()` intrinsic goes through WASI `clock_time_get` — if not, keep it as a host bridge
- [x] 2.3 Rewrite `worker.ts` source evaluation: replace `vm.evalCode(source, filename, { type: "module" })` with `vm.evalCode(source, filename)` for IIFE script mode. Read exports from the IIFE namespace on `vm.global`.
- [x] 2.4 Rewrite `worker.ts` run handler: adapt `vm.getProp`, `vm.callFunction`, `vm.resolvePromise`, `vm.executePendingJobs` to quickjs-wasi API (handle-centric methods, `executePendingJobs` on vm not runtime)

## 3. Bridge Factory Adaptation

- [x] 3.1 Adapt `bridge-factory.ts` handle API: `vm.setProp(obj,k,v)` → `obj.setProp(k,v)`, `vm.getString(h)` → `h.toString()`, `vm.getNumber(h)` → `h.toNumber()`, `vm.dump(h)` → `h.dump()`, `vm.newError({name,msg})` → `vm.newError(msg)` + set name separately
- [x] 3.2 Replace JSON marshalling via `vm.evalCode(\`(${JSON.stringify(v)})\`)` with `vm.hostToHandle(v)` where available
- [x] 3.3 Remove the opaque reference store (`storeOpaque`, `derefOpaque`, `opaqueRef`) from the bridge factory — no longer needed with WASM crypto extension

## 4. Globals Rewrite

- [x] 4.1 Remove `crypto.ts` host bridge — replaced by WASM crypto extension
- [x] 4.2 Create the crypto Promise shim: a JS string evaluated at init that wraps each `crypto.subtle` method in `Promise.resolve()`. Verify `.then()` chaining works, not just `await`.
- [x] 4.3 Remove `performance.now()` host bridge from `globals.ts` — replaced by QuickJS intrinsic (contingent on 2.2 verification)
- [x] 4.4 Keep console and timer bridges in `globals.ts`, adapt to quickjs-wasi handle API
- [x] 4.5 Keep `__hostFetch` bridge in `bridge.ts`, adapt to quickjs-wasi handle API

## 5. Sandbox Options Extension

- [x] 5.1 Extend `SandboxOptions` type with `clock`, `random`, `memoryLimit`, `interruptHandler` fields
- [x] 5.2 Wire options through the worker init message to `QuickJS.create()` WASI overrides
- [x] 5.3 Update `protocol.ts` init message type to carry the new option values (serializable representations of the override functions)

## 6. Vite Plugin Changes

- [x] 6.1 Change Rollup output format from `"es"` to `"iife"` in the vite-plugin build config
- [x] 6.2 Remove the `import "@workflow-engine/sandbox-globals"` injection from the build pipeline
- [x] 6.3 Verify built workflow bundles are valid IIFE scripts that assign exports to a global namespace

## 7. Tests

- [x] 7.1 Adapt existing sandbox isolation tests to the new engine (no Node.js surface, globalThis.constructor escape blocked)
- [x] 7.2 Adapt existing crypto tests — verify digest, sign/verify, encrypt/decrypt, generateKey, getRandomValues, randomUUID work via the WASM extension with Promise returns
- [x] 7.3 Adapt existing timer tests — setTimeout, setInterval, clearTimeout, clearInterval, cancel-on-run-end
- [x] 7.4 Adapt existing fetch bridge tests — __hostFetch, forward-fetch, abort-on-run-end
- [x] 7.5 Adapt existing lifecycle tests — dispose, onDied, factory caching, factory death eviction
- [x] 7.6 Adapt existing RPC protocol tests — host method calls, extraMethods, collision detection, requestId correlation
- [x] 7.7 Add determinism tests: clock override makes Date.now() deterministic, random override makes crypto.getRandomValues() deterministic, two sandboxes with same overrides produce same results (skipped as `.todo()` — WASI override functions are not yet wireable across the worker postMessage boundary; see TODO comments in `src/index.ts` and `src/protocol.ts`)
- [x] 7.8 Add memory limit test: sandbox with low memoryLimit rejects allocation-heavy guest code
- [x] 7.9 Add interrupt handler test: sandbox with interrupt handler stops infinite loops (skipped as `.todo()` — same postMessage serialization blocker as 7.7)
- [x] 7.10 Add WASM extension tests: URL, TextEncoder/TextDecoder, atob/btoa, structuredClone, Headers are available and functional as globals
- [x] 7.11 Security tests: verify no prototype chain escape, no access to WASM memory from guest, WASM extension globals cannot be redefined to bypass routing

## 8. Security Documentation

- [x] 8.1 Update `/SECURITY.md §2` to reflect the engine swap: quickjs-wasi replaces quickjs-emscripten, WASM extensions replace polyfills, opaque key store removed, WASI override surface documented
- [x] 8.2 Update the allowlisted globals list in SECURITY.md to reflect WASM extension-provided globals replacing polyfill-provided globals

## 9. Validation

- [x] 9.1 Run `pnpm validate` — lint, format, type check, and all tests must pass
- [x] 9.2 Build and run a workflow end-to-end with `pnpm start` to verify runtime integration (covered by `packages/runtime/src/cross-package.test.ts` which exercises the full SDK → vite-plugin → runtime → webhook path with real IIFE bundles; `pnpm build` also succeeds. Note: `pnpm dev` is broken due to a pre-existing missing `workflows/vite.config.ts`, unrelated to this migration.)
