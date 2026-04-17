## 1. Dependencies and package structure

- [x] 1.1 Add `event-target-shim@^6` to `packages/sandbox/package.json` dependencies
- [x] 1.2 Add `rollup`, `@rollup/plugin-node-resolve`, `@rollup/plugin-replace`, `rollup-plugin-esbuild` to `packages/sandbox/package.json` devDependencies
- [x] 1.3 ~~Add `./vite-plugin` entry to `packages/sandbox/package.json` `exports` pointing at `./src/polyfills/vite-plugin.ts`~~ — superseded by committed-file approach (see 3.1); added `build:polyfills` script instead
- [x] 1.4 Run `pnpm install` and verify the new deps resolve cleanly with no peer-dep warnings

## 2. Polyfill source files

- [x] 2.1 Create `packages/sandbox/src/polyfills/guest.d.ts` with ambient declarations for `__reportError`, `__hostFetch`, and `__WFE_VERSION__`
- [x] 2.2 Create `packages/sandbox/src/polyfills/trivial.ts` installing `self = globalThis` and the frozen `navigator` object (migrated from `TRIVIAL_SHIMS` in `globals.ts`, now with `__WFE_VERSION__` placeholder for rollup-replace)
- [x] 2.3 Create `packages/sandbox/src/polyfills/event-target.ts` that imports `EventTarget`, `Event` from `event-target-shim`, defines `ErrorEvent extends Event`, defines hand-written `AbortSignal extends EventTarget` (with `aborted`, `reason`, `throwIfAborted`, static `abort`/`timeout`/`any`), defines hand-written `AbortController`, installs globalThis as an EventTarget via hybrid H (setPrototypeOf + non-enumerable bound own-properties), and publishes all five classes as writable/configurable own-properties of globalThis
- [x] 2.4 Create `packages/sandbox/src/polyfills/report-error.ts` migrating the existing `REPORT_ERROR_SHIM` logic and evolving it to dispatch `ErrorEvent` before forwarding to `__reportError`
- [x] 2.5 Create `packages/sandbox/src/polyfills/microtask.ts` wrapping `globalThis.queueMicrotask` to route uncaught exceptions through `globalThis.reportError`
- [x] 2.6 Create `packages/sandbox/src/polyfills/fetch.ts` migrating the existing fetch shim from `globals.ts` verbatim (behaviorally unchanged)
- [x] 2.7 Create `packages/sandbox/src/polyfills/entry.ts` that imports the five shim files in dependency order (`trivial` → `event-target` → `report-error` → `microtask` → `fetch`)

## 3. Vite plugin

- [x] 3.1 Create `packages/sandbox/src/polyfills/vite-plugin.ts` — Vite plugin `sandboxPolyfills()` that resolves `virtual:sandbox-polyfills` by rollup-bundling `src/polyfills/entry.ts` into an IIFE string (plugins: `replace`/`esbuild@es2022`/`nodeResolve`). Registered in `packages/sandbox/vite.config.ts` which bundles `src/worker.ts` → `dist/src/worker.js` with the IIFE inlined, so Node's native ESM loader (used by `new Worker(pathToFileURL(...))`) never sees the `virtual:` scheme.
- [x] 3.2 Ambient declaration `packages/sandbox/src/polyfills/virtual.d.ts` so `tsc --build` type-checks `import SANDBOX_POLYFILLS from "virtual:sandbox-polyfills"`.

## 4. Worker wiring

- [x] 4.1 Edit `packages/sandbox/src/worker.ts`: replace the three `vm.evalCode(TRIVIAL_SHIMS/REPORT_ERROR_SHIM/FETCH_SHIM, …)` calls with a single `vm.evalCode(POLYFILLS, "<sandbox-polyfills>")` call after all host-bridge methods are installed
- [x] 4.2 Add an init-assertion in `worker.ts` (or wherever sandbox bootstrap completes) that fails fast if `typeof globalThis.addEventListener !== "function"` or `globalThis instanceof EventTarget === false`, guarding against future quickjs-wasi upgrades breaking the hybrid install

## 5. Cleanup of migrated code

- [x] 5.1 Delete `TRIVIAL_SHIMS`, `REPORT_ERROR_SHIM`, and `FETCH_SHIM` constants from `packages/sandbox/src/globals.ts` and any internal helpers no longer referenced
- [x] 5.2 Delete the `addEventListener`/`removeEventListener` no-op stub block at `packages/sandbox/test/wpt/harness/preamble.ts:26-30` — the polyfill now provides both methods

## 6. Reserved globals and §2 documentation

- [x] 6.1 Add `EventTarget`, `Event`, `ErrorEvent`, `AbortController`, `AbortSignal`, `DOMException` to `RESERVED_BUILTIN_GLOBALS` in `packages/sandbox/src/index.ts:69-91`
- [x] 6.2 Amend `SECURITY.md §2` allowlist prose with five new entries (EventTarget, Event, ErrorEvent, AbortController, AbortSignal) and add `DOMException` to the WASM-extensions enumeration (closing the pre-existing gap)
- [x] 6.3 Append a cluster-level residual-risk paragraph to `SECURITY.md §2` covering listener-chain memory bounds, re-entrancy, `isTrusted=false` invariant, `AbortSignal.timeout` reliance on the existing `setTimeout` bridge, and the `preventDefault()` suppression of `__reportError`

## 7. Sandbox spec updates

- [x] 7.1 Apply the modified `Safe globals — self` requirement from `openspec/changes/sandbox-event-target/specs/sandbox/spec.md` to the canonical `openspec/specs/sandbox/spec.md` (applied at archive time via `openspec archive`; delta is in `specs/sandbox/spec.md`)
- [x] 7.2 Apply the modified `Safe globals — reportError` requirement (same — applied at archive time)
- [x] 7.3 Add the six new `Safe globals — …` requirements (EventTarget, Event, ErrorEvent, AbortController, AbortSignal, DOMException) and the `Guest-side microtask exception routing` requirement (delta defines them; applied at archive)

## 8. Consumer vite / vitest config registration

- [x] 8.1 Register `sandboxPolyfills()` plugin in `packages/sandbox/vite.config.ts` — this config bundles worker.ts with the virtual module resolved; no registration needed in consumer configs because consumers load the pre-compiled `dist/src/worker.js` via `pathToFileURL` at runtime.
- [x] 8.2 Wire `pnpm --filter @workflow-engine/sandbox build:worker` into root `pnpm test`, `pnpm test:wpt` (both run the sandbox vite build before vitest) via a new `build:sandbox-worker` root script.
- [x] 8.3 No separate plugin registration in vitest configs needed — the bundled `dist/src/worker.js` is the runtime artifact.

## 9. Unit tests (`packages/sandbox/src/sandbox.test.ts`)

- [x] 9.1 Add tests for `EventTarget`: construct, addEventListener, dispatchEvent target/currentTarget, once option, signal option auto-remove, re-entrancy snapshot
- [x] 9.2 Add tests for `Event`: constructor, isTrusted always false, preventDefault with/without cancelable, stopImmediatePropagation prevents subsequent listeners
- [x] 9.3 Add tests for `ErrorEvent`: constructor with error/message/lineno/filename/colno
- [x] 9.4 Add tests for `AbortController`/`AbortSignal`: signal construction, abort(reason) dispatches event, abort() without reason uses DOMException AbortError, idempotent abort, throwIfAborted throws stored reason
- [x] 9.5 Add tests for `AbortSignal.abort(reason?)` pre-aborted factory
- [x] 9.6 Add tests for `AbortSignal.timeout(ms)` — aborts after delay with DOMException TimeoutError
- [x] 9.7 Add tests for `AbortSignal.any(signals)` — composes, aborts on first input abort, handles already-aborted input
- [x] 9.8 Add tests for evolved `reportError`: dispatches ErrorEvent to `self.addEventListener("error", ...)` before forwarding; `preventDefault()` suppresses host forwarding; host forwarding receives correct serialized payload when event not cancelled
- [x] 9.9 Add tests for `queueMicrotask` wrap: exception in microtask dispatches ErrorEvent to global error listener
- [x] 9.10 Add tests for `self === globalThis`, `self instanceof EventTarget`, `Object.keys(globalThis)` does not include addEventListener (non-enumerable check)
- [x] 9.11 Add tests for `DOMException` availability via guest (typeof function, construct with name/message, instanceof Error and DOMException)

## 10. Security test cases (sandbox-boundary invariants)

- [x] 10.1 Add test asserting `Event.isTrusted === false` holds for every listener-received event constructed in guest code
- [x] 10.2 Add test asserting `reportError` with `preventDefault()`-listener does NOT invoke `__reportError` host bridge (covered by 9.8 second scenario — captured array stays empty)
- [x] 10.3 Add test that shadowing `EventTarget`/`AbortController`/etc via `extraMethods` fails — reserved globals win

## 11. WPT spec.ts flips

- [x] 11.1 In `packages/sandbox/test/wpt/spec.ts`, flip `dom/events/**` from `{ expected: "skip", reason: "needs EventTarget/Event polyfill" }` to `{ expected: "pass" }`
- [x] 11.2 Flip `dom/abort/**` from `{ expected: "skip", reason: "needs AbortController/AbortSignal polyfill" }` to `{ expected: "pass" }`
- [x] 11.3 Flip `html/webappapis/microtask-queuing/queue-microtask-exceptions.any.js` from skip to pass (directory-wide `pass` entry already exists)
- [x] 11.4 Flip `html/webappapis/atob/base64.any.js:atob() setup.` from skip to pass
- [x] 11.5 Run WPT and record failures — 4420 tests pass, 0 failures. One intermediate regression (queueMicrotask with missing callback) was fixed in the polyfill; no residual subtest-level skips needed.

## 12. Snapshot artifact

- [x] 12.1 ~~Committed snapshot artifact~~ — dropped in favor of virtual module + on-demand vite build. §2 audit happens by reviewing the polyfill source files under `packages/sandbox/src/polyfills/` and the pinned `event-target-shim@^6` npm version.
- [x] 12.2 ~~Snapshot regeneration script~~ — not needed; the vite build itself produces the bundled worker on every `pnpm test` / `pnpm build`.
- [x] 12.3 ~~CI snapshot divergence check~~ — not needed; there is no snapshot to diverge.

## 13. Validation

- [x] 13.1 Run `pnpm lint` — clean
- [x] 13.2 Run `pnpm check` (tsc) — clean
- [x] 13.3 Run `pnpm test` — 362 passed / 34 files
- [x] 13.4 Run `pnpm test:wpt` — 4420 passed / 0 failed; all 17 expected flips land as passes
- [x] 13.5 Run `pnpm exec openspec validate sandbox-event-target --strict` — valid
- [x] 13.6 Run `pnpm validate` — all 7 concurrent jobs green (lint / tsc / test / polyfill-snap / tofu-fmt / tofu-val-local / tofu-val-upcloud / tofu-val-persistence)
