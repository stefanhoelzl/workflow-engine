## Why

The sandbox lacks `EventTarget`, `Event`, `AbortController`, and `AbortSignal` — four globals mandated by the WinterCG Minimum Common API and required transitively by Request/Response (Group I) and FileReader (Group J) in the fetch/api critical path. The existing `reportError` scenario in `openspec/specs/sandbox/spec.md` already commits to an evolution "when EventTarget is shipped in a future round" — this change fulfills that deferred requirement and unblocks ~17 WPT subtests currently skipped on the absence of this cluster.

## What Changes

- Add `globalThis.EventTarget` and `globalThis.Event` provided by the `event-target-shim` npm package (WHATWG-compliant, pure-JS, no host bridge) bundled into the sandbox polyfill at QuickJS eval time.
- Add `globalThis.AbortController` and `globalThis.AbortSignal`, hand-written on top of the shim's subclass path. `AbortSignal` includes static methods `abort(reason?)`, `timeout(ms)`, and `any(signals)` (the 2021–2023 spec additions).
- Add `globalThis.ErrorEvent` as a pure-JS class extending `Event`, used by `reportError` and the `queueMicrotask` wrap.
- **BREAKING** (scenario-level, not API): `globalThis` becomes an `EventTarget` — `globalThis instanceof EventTarget === true`, and `addEventListener`/`removeEventListener`/`dispatchEvent` appear as non-enumerable own-properties. The existing `Safe globals — self` scenarios remain literally true but gain additional documentation.
- Evolve `globalThis.reportError(err)` to dispatch a cancelable `ErrorEvent` on `globalThis` first, then forward to `__reportError` only if the event was not default-prevented. Fulfills the pre-committed forward-hook in the existing sandbox spec.
- Wrap `globalThis.queueMicrotask(cb)` so an uncaught exception inside a microtask routes through `globalThis.reportError(err)` — which dispatches an `ErrorEvent`.
- Document `globalThis.DOMException` as an existing WASM-extension global (provided by `quickjs-wasi`, not new to this change). Adds the entry to `RESERVED_BUILTIN_GLOBALS`, `SECURITY.md §2`, and the sandbox spec to close a pre-existing allowlist gap. Used by `AbortController`/`AbortSignal` for default abort/timeout reasons.
- Migrate the existing `TRIVIAL_SHIMS`, `REPORT_ERROR_SHIM`, and `FETCH_SHIM` template-string shims in `packages/sandbox/src/globals.ts` into typed `.ts` files under `packages/sandbox/src/polyfills/`. Bundle everything via a new Vite virtual-module plugin (`virtual:sandbox-polyfills`) so `vite build` in `packages/runtime` produces the complete runtime including the polyfill IIFE with no additional build steps.
- Delete the WPT harness `addEventListener`/`removeEventListener` no-op stubs at `packages/sandbox/test/wpt/harness/preamble.ts:26-30` (now dead with a real polyfill in place).
- Flip ~17 WPT skip entries in `packages/sandbox/test/wpt/spec.ts`: 10 `dom/events/**` files, 5 `dom/abort/**` files, `queue-microtask-exceptions.any.js`, and the `atob() setup.` subtest.

## Capabilities

### New Capabilities

_(none — all additions extend the existing sandbox capability)_

### Modified Capabilities

- `sandbox`: add `Safe globals — EventTarget`, `Safe globals — Event`, `Safe globals — ErrorEvent`, `Safe globals — AbortController`, `Safe globals — AbortSignal`, `Safe globals — DOMException` requirements; amend `Safe globals — self` scenarios to reflect EventTarget capability and the hybrid install (non-enumerable own-properties + prototype chain); amend `Safe globals — reportError` to require `ErrorEvent` dispatch with optional host forwarding; add microtask-exception-dispatch scenario.

## Impact

- **Code**:
  - New: `packages/sandbox/src/polyfills/{entry,trivial,event-target,report-error,microtask,fetch,guest.d,vite-plugin}.ts`, `packages/sandbox/src/polyfills/snapshot.js` (CI-verified audit artifact).
  - Edits: `packages/sandbox/src/worker.ts` (collapse 3 `evalCode` calls → 1 `virtual:sandbox-polyfills` import), `packages/sandbox/src/globals.ts` (delete migrated shims), `packages/sandbox/src/index.ts` (+6 entries in `RESERVED_BUILTIN_GLOBALS`), `packages/sandbox/package.json` (add `event-target-shim@^6` + rollup toolchain devDeps, export `./vite-plugin`), `packages/runtime/vite.config.ts` (register plugin), root `vitest.config.ts` and `packages/sandbox/test/wpt/vitest.config.ts` (register plugin), `packages/sandbox/test/wpt/harness/preamble.ts` (delete stubs), `packages/sandbox/test/wpt/spec.ts` (flip ~17 skip entries).
- **Security**: `SECURITY.md §2` amended with 5 new allowlist entries (EventTarget, Event, ErrorEvent, AbortController, AbortSignal) plus documentation of existing `DOMException`. Threat-model delta appended covering listener chain bounds, re-entrancy, `isTrusted=false` invariant, and `preventDefault()` suppression of `__reportError` (no new escape vector).
- **Build**: New Vite plugin resolves `virtual:sandbox-polyfills` by rollup-bundling `event-target-shim` + hand-written shims into an IIFE. `vite build` in `packages/runtime` continues to be the single build entry point; plugin also registered in vitest configs so unit + WPT tests resolve the same virtual module.
- **Dependencies**: `event-target-shim@^6` (runtime dep, MIT, no transitive deps). Dev deps: `rollup`, `@rollup/plugin-node-resolve`, `@rollup/plugin-replace`, `rollup-plugin-esbuild`.
- **Tests**: New unit tests in `packages/sandbox/src/sandbox.test.ts` covering the 5 new globals and the evolved `reportError`/`queueMicrotask` behavior. WPT suite picks up the flipped entries.
- **Bundle size**: ~45 KB unminified IIFE added to the sandbox bootstrap; init cost measured to be unmeasurable vs. baseline.
- **Out of scope**: Promise `unhandledrejection` event wiring (requires QuickJS promise-rejection-tracker host hook; no current WPT skip entries depend on it). WebIDL `DOMException.[[ErrorData]]` / non-enumerable prototype descriptors (tracked upstream in quickjs-wasi).
