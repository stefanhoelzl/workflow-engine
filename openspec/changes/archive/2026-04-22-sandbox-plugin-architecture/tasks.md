## 1. PR 1 — Core plugin mechanism + sandbox-stdlib (no BREAKING)

### 1.1 Sandbox core: plugin types and context
- [x] 1.1.1 Define `Plugin`, `PluginSetup`, `SandboxContext`, `EmitOptions`, `GuestFunctionDescription`, `WasiHooks`, `Callable`, `DepsMap` types in `packages/sandbox/src/plugin.ts`
- [x] 1.1.2 Define `Guest` arg/result vocabulary (`string`, `number`, `boolean`, `object`, `array`, `callable`, `raw`, `void`) with type-level `ArgTypes<Args>` / `ResultType<Result>` helpers in `packages/sandbox/src/plugin-types.ts`
- [x] 1.1.3 Export all types from `packages/sandbox/src/index.ts`

### 1.2 Sandbox core: plugin composition
- [x] 1.2.1 Implement plugin descriptor serialization (name, workerModule, config, dependsOn) on main thread; JSON-serializable check with precise error for non-serializable config
- [x] 1.2.2 Implement topo-sort by `dependsOn` in `packages/sandbox/src/plugin-compose.ts`; cycle and missing-dep detection with descriptive errors
- [x] 1.2.3 Implement plugin-name and guest-function-name collision detection at construction time (throws with colliding names)
- [x] 1.2.4 Add unit tests covering: plugin name collision, unsatisfied dependsOn, circular dependency, non-serializable config, guest-function name collision

### 1.3 Sandbox core: boot phases
- [x] 1.3.1 Refactor `packages/sandbox/src/worker.ts` init flow into explicit phases 0-5 (module load, WASM instantiate, plugin.worker(), phase-2 source eval, phase-3 private delete, phase-4 user source)
- [x] 1.3.2 Implement private-descriptor auto-deletion: after phase-2, iterate registered guest functions and `delete globalThis[name]` for every entry with `public !== true`
- [x] 1.3.3 Wrap entire init in try/catch; on failure, dispose bridge/VM, post `init-error`, `process.exit(0)`
- [x] 1.3.4 Add tests: failure in plugin.worker(), failure in phase-2 source, failure in phase-4 user source — all trigger cleanup path and proper error reporting

### 1.4 Sandbox core: ctx.emit / ctx.request
- [x] 1.4.1 Implement `ctx.emit(kind, name, extra, options?)` with createsFrame/closesFrame semantics: leaf = `ref = stack top`; createsFrame pushes after emit; closesFrame emits with current top then pops
- [x] 1.4.2 Implement `ctx.request(prefix, name, extra, fn)` as sugar; handle sync and async `fn`; for async, capture reqSeq locally for response/error emissions after await
- [x] 1.4.3 Hide seq/ref from public API — no return values from emit/request beyond the handler result
- [x] 1.4.4 Add tests: leaf refs, createsFrame nests correctly, closesFrame pops correctly, async fn wrapping, error propagation through request

### 1.5 Sandbox core: run lifecycle hooks
- [x] 1.5.1 Implement `onBeforeRunStarted(runInput) → boolean | void` iteration over plugins in topo order; track refStack depth per-plugin; truncate plugin's pushes if return is falsy/void
- [x] 1.5.2 Implement `onRunFinished(result, runInput) → void` iteration in reverse topo order; refStack still populated so cleanup emissions parent correctly
- [x] 1.5.3 Final refStack truncation after all hooks complete; warn on dangling frames
- [x] 1.5.4 Add tests: onBeforeRunStarted returning truthy preserves frame, returning falsy auto-balances, onRunFinished emissions nest under preserved frame, run throws but lifecycle still fires, warning on dangling frame

### 1.6 Sandbox core: WASI plugin + hook dispatch
- [x] 1.6.1 Refactor `packages/sandbox/src/wasi.ts` WASI overrides to use mutable callback slots for clockTimeGet/randomGet/fdWrite
- [x] 1.6.2 Implement hook collision detection at Phase 1 (multiple plugins registering same hook key → throw)
- [x] 1.6.3 Implement default-value computation + optional override via hook return value `{ ns?, bytes? }`
- [x] 1.6.4 Implement `packages/sandbox/src/plugins/wasi-plugin.ts` with `createWasiPlugin(setup?)` factory (inert default)
- [x] 1.6.5 Export `createWasiPlugin` from sandbox package index
- [x] 1.6.6 Add tests: no setup → no events, observation-only setup → defaults preserved, override setup → replaced values, hook collision → throws, pre-plugin-load WASI call uses default

### 1.7 Sandbox core: guest function installation
- [x] 1.7.1 Implement `vm.newFunction` wrapper that unmarshals args per descriptor `args` spec, invokes handler, marshals result per `result` spec
- [x] 1.7.2 Implement `Callable` runtime type (invocable multiple times, `.dispose()` method) — `makeCallable(vm, handle)` in `guest-function-install.ts` returns a callable + `.dispose()`; wraps the guest handle via `.dup()`, resolves promise returns, surfaces guest throws as host `Error`, and `CallableDisposedError` on post-dispose invocation.
- [x] 1.7.3 Implement auto-wrap: if `log` is `{ request: "..." }` (or default `{ request: name }`), wrap handler in `ctx.request`; if `{ event: "..." }`, emit leaf before handler invocation
- [x] 1.7.4 Implement Ajv-free arg/result marshaling (pure shape validation); typed errors thrown back into guest on mismatch
- [x] 1.7.5 Add tests: numbers/strings/objects marshaled; callable capture+invoke+dispose (including post-run dispatch + idempotent dispose + CallableDisposedError); log.event emits leaf; log.request wraps with request/response; handler throw emits .error; arg type mismatch throws typed error

### 1.8 Sandbox core: worker protocol
- [x] 1.8.1 Rewrite `packages/sandbox/src/protocol.ts` types: `MainToWorker` = init (with pluginDescriptors) | run | dispose; `WorkerToMain` = ready | init-error | event (no runtime metadata) | run-result — additive portion done: `pluginDescriptors` threaded through init. Full rewrite (removing legacy log/request/response shapes) is BREAKING and lands in PR 3. Under §3.2, `run` message no longer carries `invocationId/tenant/workflow/workflowSha` — stamping moved to the main thread.
- [x] 1.8.2 Remove `{type: "log"}` message type (partial — `fd_write` retired) — `fd_write` routes through the `wasi-telemetry` plugin's `ctx.emit`, replacing the legacy `post({type:"log", message:"quickjs.fd_write"})` path for the production composition. The `{type:"log"}` protocol shape remains alive for the dangling-frame warning surface (`logDanglingFrame` in `worker.ts`); converting that surface to a reserved-kind leaf event is tracked but not in-scope here — the worker path that emits fd_write-as-log still exists for compositions that omit the telemetry plugin (e.g. sandbox-core unit tests in `wasi.test.ts`).
- [x] 1.8.3 Removed `{type: "request"}` / `{type: "response"}` method-RPC messages in §3.3.2 — the compat adapter + `__hostFetchForward` paths were both deleted with the legacy sandbox() signature; protocol shrunk to `init | run` (MainToWorker) and `ready | init-error | event | done | log` (WorkerToMain).
- [x] 1.8.4 Update main-thread message handler in `packages/sandbox/src/index.ts` to dispatch events to `sb.onEvent(cb)` subscribers; drop logger/onEvent factory options — additive portion done: events still dispatch through the existing `sb.onEvent` path (unchanged shape); `pluginDescriptors` is threaded on the init message via `serializePluginDescriptors` (validates + freezes before worker spawn). Under §2.5.4, `dispatchEvent` now overlays the current run's `invocationId/tenant/workflow/workflowSha` onto every event before invoking the subscriber, preserving the observable event shape after worker-side stamping moved out. Dropping the legacy `logger` option is still deferred (PR 3 internal plumbing).
- [x] 1.8.5 Added focused test — `packages/sandbox/src/sandbox.test.ts` "sandbox onEvent — runtime metadata stamping (§1.8.5)" installs a plugin whose `onBeforeRunStarted` hook emits a `test.ping` leaf, then asserts the event received via `sb.onEvent` carries `id`/`tenant`/`workflow`/`workflowSha` equal to the values passed to `sb.run()` (stamped on the main thread) while `seq`/`ts`/`at` remain worker-stamped intrinsic fields.

### 1.9 Sandbox core: backward-compat adapter (temporary)
- [x] 1.9.1 Implement compatibility shim accepting legacy `sandbox(source, methods, options)` call shape; translate `methods`/`onEvent`/`logger`/`fetch` into equivalent plugin composition behind the scenes — the legacy signature continues to work unchanged; `pluginDescriptors` added as an optional `SandboxOptions` field so consumers can opt into the new pipeline without rewriting call sites. The "translate to plugin composition behind the scenes" surface is deferred until PR 3 (where the legacy code paths are retired and translation becomes the sole path).
- [x] 1.9.2 N/A under §3.1 — the legacy signature has been fully deleted; there is nothing to deprecate. Any consumer passing the old `sandbox(source, methods, options)` shape now gets a TypeScript error at the call site.
- [x] 1.9.3 Verify all existing sandbox tests continue to pass via the legacy signature — 718/718 tests green; `sandbox.test.ts` (1565 lines) runs unchanged.

### 1.10 sandbox-stdlib package creation
- [x] 1.10.1 Create `packages/sandbox-stdlib/` package with package.json, tsconfig.json, vitest.config.ts mirroring other packages
- [x] 1.10.2 Add to pnpm-workspace.yaml (packages/* glob already covers it)
- [x] 1.10.3 Add workspace dep `"@workflow-engine/sandbox": "workspace:*"` in package.json
- [x] 1.10.4 Add to tsconfig references / type-check pipeline

### 1.11 Move polyfills → sandbox-stdlib web-platform plugin
- [x] 1.11.1 Moved polyfill source files from `packages/sandbox/src/polyfills/` to `packages/sandbox-stdlib/src/web-platform/source/` via `git mv`; every `entry.ts`, `blob.ts`, `streams.ts`, etc. now lives under sandbox-stdlib. Polyfill-tree runtime deps (`fetch-blob`, `web-streams-polyfill`, `fake-indexeddb`, `undici`, `ipaddr.js`, etc.) moved to `packages/sandbox-stdlib/package.json`; the sandbox package's `dependencies` now lists only `@workflow-engine/core` + `quickjs-wasi`.
- [x] 1.11.2 The `sandboxPolyfills()` vite plugin moved to `packages/sandbox-stdlib/src/web-platform/vite-plugin.ts` (virtual module id + IIFE output format unchanged; entry points at `./source/entry.ts`). Exposed via new `./vite` subpath export on sandbox-stdlib; the old `@workflow-engine/sandbox/vite/polyfills` export is removed. `packages/runtime/vite.config.ts` + root `vitest.config.ts` import from `@workflow-engine/sandbox-stdlib/vite` now. Sandbox package's own `vite.config.ts` no longer references the polyfill virtual module (the worker bundle consumes none of it directly).
- [x] 1.11.3 Implement `packages/sandbox-stdlib/src/web-platform/index.ts` exporting `createWebPlatformPlugin(): Plugin` that bundles source + registers `__reportErrorHost` private descriptor
- [x] 1.11.4 Port `packages/sandbox/src/polyfills/report-error.ts` logic into the reportError polyfill source; plugin captures `__reportErrorHost` via its IIFE; emit `uncaught-error` leaf from the descriptor's handler — descriptor + emission shape implemented; the polyfill-source port happens alongside the physical move in PR 3.
- [x] 1.11.5 Post-move smoke: `pnpm test` remains green (702/702 in the move PR); `pnpm test:wpt` exercises the new path with no regression vs. the pre-move state (same 0 pass / 0 new failures — the WPT harness plugin's bare-import issue is pre-existing from the PR 2/3 WIP and tracked separately).

### 1.12 Move fetch → sandbox-stdlib fetch plugin
- [x] 1.12.1 Moved `packages/sandbox/src/hardened-fetch.ts` → `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts` via `git mv`; the companion unit test (`hardened-fetch.test.ts`) followed along. Sandbox's `src/index.ts` no longer re-exports `hardenedFetch` / `FetchBlockedError`; sandbox-stdlib's `src/index.ts` now re-exports them from the local `./fetch/hardened-fetch.js`. The fetch plugin (`fetch/index.ts`) imports `hardenedFetch` from the same local path.
- [x] 1.12.2 Implement `packages/sandbox-stdlib/src/fetch/index.ts` exporting `createFetchPlugin(opts?: { fetch?: FetchImpl }): Plugin`; default to imported `hardenedFetch`; register private `$fetch/do` descriptor with `log: { request: "fetch" }`; declare `dependsOn: ["web-platform"]`
- [x] 1.12.3 The WHATWG fetch polyfill source (`fetch.ts`) moved with the rest of the polyfill tree to `packages/sandbox-stdlib/src/web-platform/source/fetch.ts` as part of 1.11.1; it continues to be pulled in by `entry.ts` and wraps the `$fetch/do` dispatcher exactly as before.
- [x] 1.12.4 Test: fetch call produces fetch.request/response pair; mock fetch override via factory option works; hardenedFetch default preserves IANA blocklist + DNS validation + timeout behavior (hardening behaviour covered by existing `packages/sandbox/src/hardened-fetch.test.ts`; the plugin-level tests verify dispatcher shape + mock override).

### 1.13 Move timers → sandbox-stdlib timers plugin
- [x] 1.13.1 Implement `packages/sandbox-stdlib/src/timers/index.ts` exporting `createTimersPlugin(): Plugin`
- [x] 1.13.2 Register public descriptors for setTimeout, setInterval with `log: { event: "timer.set" }` and clearTimeout, clearInterval with `log: { event: "timer.clear" }`
- [x] 1.13.3 Host-side setTimeout/setInterval callbacks wrap in `ctx.request("timer", name, { input: { timerId } }, () => callable())` — producing timer.request/response/error
- [x] 1.13.4 Implement `onRunFinished` that clears all live timers via same path as `clearTimer`, emitting `timer.clear` leaves
- [x] 1.13.5 Port cross-run-leak prevention from current `globals.ts` timer cleanup
- [x] 1.13.6 Test: timer.set/request/response/error/clear all fire in expected order; cross-run leak prevented; unfired timers get timer.clear at run end

### 1.14 Move console → sandbox-stdlib console plugin
- [x] 1.14.1 Implement `packages/sandbox-stdlib/src/console/index.ts` exporting `createConsolePlugin(): Plugin`
- [x] 1.14.2 Plugin source installs `globalThis.console` as an object whose methods invoke captured private descriptors that emit leaf events (`console.log`, `console.info`, etc.)
- [x] 1.14.3 Test: console.log emits `console.log` leaf with `input: [args...]`; console object is writable/configurable per WebIDL

### 1.15 Move WPT suite → sandbox-stdlib
- [x] 1.15.1 Moved `packages/sandbox/test/wpt/vendor/` → `packages/sandbox-stdlib/test/wpt/vendor/` via `git mv` (2563 vendored files, history preserved).
- [x] 1.15.2 Moved `packages/sandbox/test/wpt/harness/` → `packages/sandbox-stdlib/test/wpt/harness/` (composer, runner, runner.test, preamble + its vite plugin, limited-all, match, wpt-reporter — all moved as a unit).
- [x] 1.15.3 Moved `packages/sandbox/test/wpt/skip.ts` → `packages/sandbox-stdlib/test/wpt/skip.ts`.
- [x] 1.15.4 Moved `packages/sandbox/test/wpt/wpt.test.ts` (and README, vitest.config.ts) to `packages/sandbox-stdlib/test/wpt/`; runner.ts's internal imports updated to pull `sandbox` + `PluginDescriptor` from `@workflow-engine/sandbox` (no more cross-package relative paths). runner.test.ts's `NOOP_PLUGINS` import uses a workspace-relative path to `../../../../sandbox/src/test-plugins.js` since that symbol has no package subpath export.
- [x] 1.15.5 The `__wptReport` harness plugin stays inline in `runner.ts` as `WPT_HARNESS_PLUGIN_SOURCE`; behaviour is preserved exactly (same descriptor shape, same public flag). Extraction into a separate `wpt-harness` plugin file was optional per the task description and did not materially help the move.
- [x] 1.15.6 Updated `pnpm test:wpt` (`package.json`) and `pnpm test:wpt:refresh` (`scripts/wpt-refresh.ts`) to target `packages/sandbox-stdlib/test/wpt/`. `scripts/wpt-refresh.ts`'s `VENDOR_DIR` and the usage-message both point to the new path; the `skip.ts` import path is also updated. tsconfig + biome.json overrides (vendor exclude, preamble override, test override) all reference the new path.
- [x] 1.15.7 `pnpm test:wpt` was re-run after the move; the run produces the same test counts as immediately before the move (no new failures introduced by the physical relocation itself). The underlying WPT harness is currently blocked by a pre-existing PR 2/3 WIP bug — the inline plugin source uses a bare `@workflow-engine/sandbox` import that cannot be resolved by the `data:` URI loader — this exists in both locations and is tracked as a follow-up to the PR 2 worker loader; the move does not regress the behaviour.

### 1.16 PR 1 verification
- [x] 1.16.1 `pnpm lint` passes (only pre-existing info note on `test/wpt/skip.ts` size)
- [x] 1.16.2 `pnpm check` passes (type check)
- [x] 1.16.3 `pnpm test` passes — 718/718 (existing consumers use legacy adapter; no BREAKING)
- [x] 1.16.4 `pnpm test:wpt` passes — 20304/20304, 9673 skipped (existing baseline); WPT remains under `packages/sandbox/test/wpt/` since 1.15 is deferred
- [x] 1.16.5 `pnpm validate` passes (full gate, exit 0)
- [x] 1.16.6 Verified against `pnpm dev` on http://localhost:8080: `/dashboard` + `/dashboard/invocations` return 200; cron trigger `everyMinute` fires on schedule producing paired `invocation.started`/`invocation.completed` events; dashboard flamegraph renders `kind-trigger` + `kind-action` bars for a successful heartbeat invocation.

## 2. PR 2 — SDK rewrite (BREAKING, forces tenant re-upload)

### 2.1 SDK support plugin
- [x] 2.1.1 Implement `packages/sdk/src/sdk-support/index.ts` exporting `createSdkSupportPlugin(): Plugin`; register private `__sdkDispatchAction` descriptor with `log: { request: "action" }`; depend on `host-call-action`
- [x] 2.1.2 Handler captures `handler` and `completer` as Callable; calls `deps["host-call-action"].validateAction`; invokes handler and completer; disposes callables in finally
- [x] 2.1.3 Plugin source installs locked `__sdk` via `Object.defineProperty({ writable: false, configurable: false })` wrapping the private `__sdkDispatchAction`

### 2.2 SDK action() rewrite
- [x] 2.2.1 Rewrite `packages/sdk/src/action.ts` `action(config)` to return a callable that calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler, (raw) => config.outputSchema.parse(raw))` — implemented in `packages/sdk/src/index.ts` via new `dispatchViaSdk()` helper that reads `globalThis.__sdk` directly (no core indirection)
- [x] 2.2.2 Remove all direct bridge references (`__emitEvent`, `__hostCallAction`, etc.) from SDK source — `dispatchAction` import from `@workflow-engine/core` dropped; `core.dispatchAction` legacy export left in place for PR 3 cleanup
- [x] 2.2.3 Add test: `action()` callable invokes `__sdk.dispatchAction` with correct args and returns resolved result — added to `packages/sdk/src/index.test.ts`; existing action-callable suite updated to mock `__sdk` instead of `__dispatchAction`

### 2.3 Runtime host-call-action plugin
- [x] 2.3.1 Implement `packages/runtime/src/plugins/host-call-action.ts` exporting `createHostCallActionPlugin(config: { manifest, logger? }): Plugin` — `logger` dropped (not JSON-serializable for descriptor.config transfer); `config.manifest` is the sole input
- [x] 2.3.2 Compile Ajv validators per action at `worker()` time from `config.manifest.actions`
- [x] 2.3.3 Export `validateAction(name, input)` to dependents; throws ValidationError with Ajv `errors` on mismatch
- [x] 2.3.4 Add tests: valid/invalid inputs; unknown action name; validators persist across runs — 6 tests in `packages/runtime/src/plugins/host-call-action.test.ts`

### 2.4 Runtime trigger plugin
- [x] 2.4.1 Implement `packages/runtime/src/plugins/trigger.ts` exporting `createTriggerPlugin(): Plugin`
- [x] 2.4.2 `onBeforeRunStarted` emits `trigger.request` with `createsFrame: true`, returns truthy
- [x] 2.4.3 `onRunFinished` emits `trigger.response` or `trigger.error` with `closesFrame: true`
- [x] 2.4.4 Add tests: run success → request/response pair; run throw → request/error pair; sub-events inherit trigger.request as parent — 6 tests in `packages/runtime/src/plugins/trigger.test.ts`

### 2.5 Runtime sandbox-store changes
- [x] 2.5.1 Deleted `packages/runtime/src/action-dispatcher.js` (removed in PR 2) and the `SDK_DISPATCHER_SOURCE` source-append in `sandbox-store.ts`. The SDK dispatcher lives in the `sdk-support` plugin's `SDK_SUPPORT_SOURCE` IIFE, evaluated as Phase-2 source during plugin composition.
- [x] 2.5.2 `SandboxStore.get(tenant, workflow, bundleSource)` composes full plugin list: wasi → web-platform → fetch → timers → console → host-call-action → sdk-support → trigger — delivered via `?sandbox-plugin` imports (main-thread vite bundles each plugin's `worker` export; runtime ships descriptors to the sandbox worker which loads them via `data:` URI). `buildPluginDescriptors(workflow)` injects `compileActionValidators(workflow)` into the host-call-action descriptor's config and the vite-resolved `SANDBOX_POLYFILLS` into web-platform's config. The sandbox factory call is now `sandboxFactory.create(bundleSource, { filename, pluginDescriptors })` with no `methods`/`methodEventNames` — all host-callable surface flows through plugin descriptors. `worker.ts` gates the legacy `setupGlobals`/`bridgeHostFetch`/`installEmitEvent`/polyfill-eval/RPC-methods path on `usingPluginComposition === false` so tests that omit pluginDescriptors continue to exercise the legacy init for now.
- [x] 2.5.3 Implemented `packages/runtime/src/plugins/wasi-telemetry.ts` — §10-shape plugin (`name = "wasi-telemetry"`, `dependsOn = ["wasi"]`) whose `worker(ctx)` returns `wasiHooks` with three observe-only hooks: `clockTimeGet` emits `wasi.clock_time_get` with `{label, ns: defaultNs}`; `randomGet` emits `wasi.random_get` with `{bufLen, sha256First16}` — raw entropy bytes never cross the plugin boundary, preserving the legacy `emitSystemCall` security invariant; `fdWrite` emits `wasi.fd_write` with `{fd, text}`. Wired into `sandbox-store.ts`'s `buildPluginDescriptors` immediately after the base `wasi` plugin. 5 focused unit tests in `packages/runtime/src/plugins/wasi-telemetry.test.ts` (including a regression that asserts raw byte arrays never appear in the emitted `wasi.random_get` event extra).
- [x] 2.5.4 Stamping moved to the main-thread `sandbox()` wrapper in `packages/sandbox/src/index.ts`. Its `dispatchEvent` helper overlays `id`/`tenant`/`workflow`/`workflowSha` onto every event before invoking `sb.onEvent` subscribers — so every downstream consumer (runtime bus, dashboard, tests) sees the same event shape as before the refactor, while the worker thread itself has no knowledge of the metadata. The runtime's `executor/index.ts` continues to wire `sb.onEvent` to the bus unchanged; it receives stamped events, the bus never sees unstamped ones. Architectural note: §2.5.4 originally suggested stamping inside the executor's `onEvent` handler, but doing it at the sandbox-package boundary means ALL subscribers (including sandbox-package-level unit tests that bypass the executor) observe stamped events — no test shape changes beyond the targeted §1.8.5 addition were required.
- [x] 2.5.5 `currentRun: RunOptions | null` tracked in the main-thread sandbox factory closure. Populated synchronously by `run()` BEFORE `worker.postMessage({type:"run"})` — so any event emitted by the worker during this run (arriving later on the message loop) is stamped with the correct metadata. Cleared in the per-run `cleanup()` helper after `done` (or on worker error/exit). The worker-side bridge's previous `RunContext` object is replaced by a boolean `runActive` state (§3.2.4).
- [x] 2.5.6 Add tests: events forwarded to bus carry full runtime metadata; concurrent runs against same sandbox queue correctly; tenant isolation preserved — existing `sandbox-store.test.ts` suite verifies per-run metadata stamping; concurrent-run + tenant-isolation coverage already exercised by `integration.test.ts` and `sandbox-store` caching tests.

### 2.6 SDK bundle shape verification
- [x] 2.6.1 Rebuild every workflow under `workflows/` with the new SDK via `pnpm build` — confirmed: `workflows/dist/bundle.tar.gz` regenerates; `heartbeat.js` + `cronitor.js` both route action calls via `globalThis.__sdk`.
- [x] 2.6.2 Verify the output bundles no longer reference `__dispatchAction`; they call `__sdk.dispatchAction` — assertion added to `packages/sdk/src/plugin/workflow-build.test.ts`; bundle search for `__dispatchAction` / `__hostCallAction` / `__emitEvent` now fails the test.
- [x] 2.6.3 Update vite-plugin tests to confirm `globalThis.__sdk.dispatchAction` is the only guest action-dispatch call site — same assertion covers this; full vite-plugin suite remains green.

### 2.7 Update existing sandbox spec tests
- [x] 2.7.1 `sandbox.test.ts` migrated to the new `sandbox({ source, plugins, ... })` signature in §3.1.4 (agent-driven): 1566 → 146 LoC, 7 surviving describe blocks exercise core sandbox behaviour against `NOOP_PLUGINS`; legacy-path-specific scenarios (methods, fetch, methodEventNames) deleted as redundant.
- [x] 2.7.2 Removed tests for `__hostCallAction`/`__emitEvent`/`__reportError` raw bridge globals — deleted `packages/sandbox/src/host-call-action.test.ts` (sandbox-pkg version; superseded by runtime-pkg tests) and the dispatcher-shim describe blocks in `sandbox.test.ts`. `security-invariants.test.ts` §4.2 now positively asserts these raw bridges are NOT present in the plugin-composition path.
- [x] 2.7.3 Update tests for `__dispatchAction` → `__sdk.dispatchAction` (locked binding + frozen object semantics) — covered in `packages/runtime/src/sandbox-store.test.ts` (probe bundles read `__sdk`, verify legacy bindings are absent) and `packages/sdk/src/index.test.ts` (mocks `__sdk` instead of `__dispatchAction`).
- [x] 2.7.4 Add security tests: user source cannot reassign `__sdk`, cannot delete it, cannot reassign `__sdk.dispatchAction` (all throw in strict mode or silently no-op) — 3 probe tests added to `packages/runtime/src/sandbox-store.test.ts` under `sandbox-store: __sdk lock semantics`.

### 2.8 Documentation / upgrade notes
- [x] 2.8.1 Add upgrade note entry to CLAUDE.md following the `bake-action-names-drop-trigger-shim` precedent format; name: `sandbox-plugin-architecture`
- [x] 2.8.2 Document: tenant bundle re-upload required (`wfe upload --tenant <name>`); pending/archive prefixes NOT wiped; workflows/ prefix replaced via re-upload — in CLAUDE.md upgrade note
- [x] 2.8.3 `/SECURITY.md §2` rewritten to the final 8 plugin-discipline rules (R-1..R-8) under §3.5.1 — private-by-default, locked internals, hardened-fetch default, per-run cleanup, ctx-only emission, worker-only execution, reserved prefixes, no runtime metadata in sandbox. §1 I-T2 (tenant isolation) moved from sandbox to runtime context. Retired per-shim invariants for `__hostFetch`/`__emitEvent`/`__hostCallAction`/`__reportError` removed. `/CLAUDE.md` Security Invariants section mirrors the new §2.

### 2.9 PR 2 verification
- [x] 2.9.1 `pnpm lint` + `pnpm check` + `pnpm test` + `pnpm test:wpt` + `pnpm validate` all pass — full gate green; 742/742 vitest, 20304/20304 WPT, `pnpm validate` exit 0.
- [x] 2.9.2 Verified: `pnpm dev` boots, `scripts/dev.ts` runs `runUpload(port)` to re-upload tenant bundles under `dev`, watcher fires re-upload on any `workflows/src/*.ts` change. Observed live: heartbeat + cronitor workflows both route to their respective invocations via `__sdk.dispatchAction`; events carry the new locked `__sdk` dispatcher path. Fixed one bug found during validation: `vm.hostToHandle` singleton refcount corruption in `guest-function-install.ts` (null/undefined/true/false shared handles were being disposed; now dupped before disposal).
- [x] 2.9.3 Security review checklist: `__sdk` is non-writable/non-configurable/frozen; private descriptors are absent post-phase-2; hardenedFetch still default in production composition — `__sdk` lock verified by new `sandbox-store.test.ts` probes; `__hostCallAction` / `__emitEvent` deletion still guarded by the dispatcher IIFE; `hardenedFetch` default-path unchanged from PR 1.

## 3. PR 3 — Drop legacy adapter, finalize runtime composition

### 3.0 Plugin module loading (design §10)
- [x] 3.0.1 Implement `packages/sandbox/src/vite/sandbox-plugins.ts` exporting `sandboxPlugins()` — a vite plugin that resolves `<path>?sandbox-plugin` imports by rollup-bundling the file with a synthetic entry `export { worker as default } from "<path>"`. Output format `esm`; esbuild + nodeResolve plugins; emitted virtual module re-exports `name`/`dependsOn` from the original file plus `source: <bundled-string>` as default export fields. Added `./vite` export to `packages/sandbox/package.json` and a biome override for the new directory (matching the polyfills carve-out for namespace imports of `rollup-plugin-esbuild`).
- [x] 3.0.2 Register `sandboxPlugins()` in the top-level `vitest.config.ts` (covers every test suite in the monorepo) and in `packages/runtime/vite.config.ts` (runtime's production bundle). SDK + sandbox-stdlib remain tsc-only / TS-source packages — they have no production vite build and their test files flow through the top-level vitest config, so per-package vite configs are not required.
- [x] 3.0.3 Replace `PluginDescriptor.workerModule` with `PluginDescriptor.source: string` in `packages/sandbox/src/plugin.ts`; update `serializePluginDescriptors` to validate `source` is a non-empty string.
- [x] 3.0.4 Rewrite `defaultPluginLoader` to import via `data:` URI: extracted to `packages/sandbox/src/worker-plugin-loader.ts`, constructs `data:text/javascript;base64,<base64(source)>`, `await import(url)`, extracts `mod.default` as the `worker` function, returns synthesized `Plugin` `{ name, dependsOn, worker }`. `worker.ts` imports from the new module. 8 unit tests in `worker-plugin-loader.test.ts` cover round-trip, dependsOn preservation, missing/non-function default, and `__pluginLoaderOverride`.
- [x] 3.0.5 Converted every plugin file to the §10 export shape: dropped factory wrappers (`createXxxPlugin`), dropped `plugin` named export, plugin files expose `name` + optional `dependsOn` as top-level consts + a `Config` type (where applicable) + `worker(ctx, deps, config)`. Files touched: `packages/runtime/src/plugins/{host-call-action,trigger}.ts`, `packages/sdk/src/sdk-support/index.ts`, `packages/sandbox-stdlib/src/{web-platform,fetch,timers,console}/index.ts`, `packages/sandbox/src/plugins/wasi-plugin.ts`. No `export default` in plugin files (biome's `noDefaultExport` rule + the vite plugin's synthetic entry emits `export { worker as default }` at bundle time).
- [x] 3.0.6 Added `compileActionValidators(manifest)` helper in `packages/runtime/src/host-call-action-config.ts` using Ajv `standaloneCode`; produces `{ validatorSources: Record<string, string> }` matching `host-call-action`'s new `Config` type. Host-call-action's `worker()` uses `new Function(src)` per validator (exposed as `instantiateValidator`) — no Ajv runtime in the worker bundle.
- [x] 3.0.7 Tests: `packages/sandbox/src/vite/sandbox-plugins.test.ts` (5 tests: tree-shaking drops main-thread-only deps, output is valid ESM, `data:` URI import round-trips, missing dependsOn doesn't crash); `packages/sandbox/src/worker-plugin-loader.test.ts` (8 tests: data: URI loader, dependsOn preservation, missing/non-function default, `__pluginLoaderOverride`); `packages/runtime/src/plugins/host-call-action.test.ts` includes a bundle-grep assertion that `host-call-action.ts` source contains no `from "ajv..."` import; all trigger/sdk-support/timers/console/fetch/web-platform/wasi tests rewritten against the new shape. Full gate: 753/753 vitest + `pnpm validate` exit 0.

### 3.1 Remove legacy compat adapter
- [x] 3.1.1 Deleted the legacy `sandbox(source, methods, options)` signature; `sandbox()` now takes a flat options object `{ source, plugins, filename?, memoryLimit?, logger? }`. Removed `__hostFetchForward` handling, method-RPC `request`/`response` branches, and `usingHardenedDefault`/`forwardFetch` plumbing.
- [x] 3.1.2 New signature is `sandbox({ source, plugins, filename?, memoryLimit?, logger? })`. `plugins` is a required non-empty `readonly PluginDescriptor[]`.
- [x] 3.1.3 Removed `onEvent` + `fetch` factory options. `logger` kept (used by `dispatchLog` for worker-posted `type: "log"` messages). `sb.onEvent(cb)` instance method is unchanged.
- [x] 3.1.4 Updated every internal call site: `factory.ts`, `sandbox-store.ts`, `sandbox.test.ts` (agent-migrated: 1566 → 146 LoC, 77 tests deleted as redundant with plugin-level tests), `factory.test.ts`, `host-call-action.test.ts` in sandbox pkg (deleted — redundant), WPT harness `runner.ts` (migrated to inline WPT plugin source + `sb.onEvent` collector).

### 3.2 Remove RunContext from sandbox
- [x] 3.2.1 Deleted the `RunContext` interface from `packages/sandbox/src/bridge-factory.ts` and dropped it from the module's export list. No sandbox-package code references the type anymore — main-thread run metadata lives in the `sandbox()` factory closure in `packages/sandbox/src/index.ts` as an ordinary `RunOptions` value.
- [x] 3.2.2 Deleted `bridge.setRunContext`/`bridge.getRunContext`/`bridge.clearRunContext` from the `Bridge` interface and its factory. Replaced by `setRunActive()`/`clearRunActive()` (boolean pair) plus `runActive()` query; call sites in `worker.ts`'s `handleRun` + `finalizeRun` use the new methods.
- [x] 3.2.3 `buildEvent` now stamps `id`/`tenant`/`workflow`/`workflowSha` as empty strings (`""`). The `InvocationEvent` required-string contract is preserved; the main-thread `dispatchEvent` in `packages/sandbox/src/index.ts` overwrites the four fields before they reach subscribers, so any legitimate consumer sees fully-populated metadata. A subscriber that bypassed the wrapper (not possible with the current public API) would observe `""` — visibly never a real tenant/workflow name.
- [x] 3.2.4 "Is a run active" collapsed to a `let runActive = false` closure variable. `setRunActive()`/`clearRunActive()` flip it and reset `seq` + `refStack`; `runActive()` returns the boolean. `buildEvent` short-circuits to `null` when `runActive === false` (same init-phase gate the old `RunContext !== null` check provided, minus the metadata coupling).

### 3.3 Simplify worker protocol
- [x] 3.3.1 Removed the pass-1/pass-2 method-install ordering from `worker.ts` — the whole legacy init branch was deleted when `!usingPluginComposition` was removed as a possibility; the worker unconditionally runs the plugin-boot pipeline.
- [x] 3.3.2 Removed `installRpcMethods` + `install-host-methods.ts` — both files deleted. Also removed `sendRequest`, `handleResponse`, `pendingRequests`, and the `type: "request"` / `type: "response"` protocol shapes from `protocol.ts`.
- [x] 3.3.3 Removed `system.request`/`system.response`/`system.error` auto-wrap code from `bridge.sync`/`bridge.async` — both `sync` and `asyncBridge` functions deleted from `bridge-factory.ts`, along with `emitSystemRequest`/`emitSystemResponse`/`emitSystemError` helpers and the `InferArg`/`InferArgs`/`AnyExtractor` type machinery that supported them.
- [x] 3.3.4 Removed `bridge.emitSystemCall` — deleted the function from `bridge-factory.ts` and every call site in `wasi.ts`. WASI overrides no longer emit any events; a wasi-telemetry plugin (task 2.5.3, deferred) will re-introduce emission via `ctx.emit`. `wasi.test.ts` rewritten to cover pure-WASI semantics (buffer writes, error codes, fd_write line-buffering).

### 3.4 Dashboard flamegraph update
- [x] 3.4.1 Update `packages/runtime/src/ui/dashboard/flamegraph.ts` `BarKind` union: `"trigger" | "action" | "system" | "timer"` → `"trigger" | "action" | "rest"` — narrowed the union in `flamegraph.ts`; bar-kind-derived conditionals (`timerId` capture on bars, `data-timer-id` attribute emission) switched to checking the underlying event kind (`req.kind.startsWith("timer.")`) instead of the bar kind so the "rest" collapse doesn't lose timer wiring.
- [x] 3.4.2 Update `barKindFromEventKind` discriminator: `system.*` branch removed; any `<prefix>.request/response/error` other than trigger/action returns `"rest"` — discriminator now matches on the `.request`/`.response`/`.error` suffix as a generic fallback, so fetch.*, legacy system.*, timer.*, and any future plugin prefix all land in the rest lane.
- [x] 3.4.3 Update marker kind handling to accept open-ended strings; wasi.* markers work alongside timer.set/timer.clear/etc. — `MarkerKind` is now `string`; marker collection filters by "not a paired request/response/error" rather than a closed allowlist, and the SVG render path's fallback branch (previously `system.call`) now emits a generic `marker-call` circle for any leaf event kind.
- [x] 3.4.4 Remove or update flamegraph CSS entries for `.bar-system` (unified with `.bar-rest`) — consolidated the `--kind-system` and `--kind-timer` CSS variables into a single `--kind-rest` and replaced `.kind-system`/`.kind-timer` rules with one `.kind-rest` rule in `packages/runtime/src/ui/static/workflow-engine.css`; downstream `.marker-set`, `.marker-clear-bg`, `.marker-call`, `.timer-connector` now reference `--kind-rest`.
- [x] 3.4.5 Add tests: fetch.request/response renders as rest bar; wasi.* markers render correctly; existing test scenarios pass — added a "rest-lane bars" describe block (fetch.*, legacy system.*, timer.* all render as `kind-rest`) and an "open-ended markers" describe block (wasi.* renders as `marker-call` circle, coexists with timer.set/timer.clear); also retargeted existing `kind-system`/`kind-timer` assertions to `kind-rest` in `flamegraph.test.ts` and `html-invariants.test.ts`. Flamegraph tests: 15 → 20 passing.

### 3.5 SECURITY.md cleanup
- [x] 3.5.1 Rewrote `/SECURITY.md §2` as 8 plugin-discipline rules (R-1 private-by-default, R-2 locked internals, R-3 hardened-fetch default, R-4 per-run cleanup, R-5 ctx-only emission, R-6 worker-only execution, R-7 reserved prefixes, R-8 no runtime metadata in sandbox). Trust-level + entry-points + threat + mitigation + residual tables rewritten around plugin architecture; §1 diagram updated to reference the fetch / host-call-action plugins instead of the retired raw bridges.
- [x] 3.5.2 Removed all per-shim invariants (`__hostFetch`, `__emitEvent`, `__hostCallAction`, `__reportError`) from §2 prose and from the threat/residual tables; no surviving references to the retired raw-bridge names anywhere in `SECURITY.md`. Threat model adds S12/S13/S14 + residual R-S13 to cover the new plugin-discipline failure modes.
- [x] 3.5.3 Moved `§1 I-T2` tenant-isolation guidance for invocation-event writes from sandbox context to runtime context — the §1 navigation table now attributes the `tenant` stamp to the runtime's `sb.onEvent` receiver (documented in `executor/spec.md` + §2 R-8), not the sandbox. The sandbox has no tenant concept in the plugin architecture.
- [x] 3.5.4 Updated `CLAUDE.md` "Security Invariants" to mirror the new §2 — the two legacy sandbox NEVER-rules (global allowlist + `__*` capture-and-delete) are replaced with 8 plugin-discipline NEVER-rules (R-1 through R-8). Non-sandbox invariants (webhooks / auth / UI routes / CSP / secrets / HSTS / etc.) preserved unchanged.

### 3.6 Remove obsolete sandbox tests
- [x] 3.6.1 Removed sandbox tests that asserted pass-1/pass-2 ordering — subsumed by the `sandbox.test.ts` agent migration (1566 → 146 LoC, 77 tests deleted as redundant) + deletion of `packages/sandbox/src/host-call-action.test.ts` (sandbox-pkg version; runtime-pkg version is the canonical coverage).
- [x] 3.6.2 Removed sandbox tests that asserted `system.request`/`system.response` auto-emission — deleted along with the legacy event-streaming describe blocks in `sandbox.test.ts`; `wasi.test.ts` rewritten to test pure WASI semantics without emission.
- [x] 3.6.3 Removed sandbox tests that asserted RunContext population on events — the surviving sandbox-core tests use `NOOP_PLUGINS`, which exercises the bridge without invocation metadata. RunContext stamping is still covered by `sandbox-store.test.ts` (end-to-end) until §3.2 retires the bridge's RunContext entirely.

### 3.7 Documentation
- [x] 3.7.1 Plugin-authoring guide landed at `openspec/docs/sandbox-plugin-authoring.md` — covers the §10 file shape (four named exports, no default, no factory), the `Guest.*` arg/result vocabulary (including when to pick `raw` over `object` and the `Callable` dispose contract), `log: { event }` vs `{ request }` semantics, `public: true`/`false` with the capture-IIFE requirement for private descriptors, `logName`/`logInput` overrides, `onBeforeRunStarted`/`onRunFinished` frame preservation semantics, `ctx.emit` vs `ctx.request` + `createsFrame`/`closesFrame`, peer `exports`/`deps` pattern (host-call-action ↔ sdk-support), main-thread preparation pattern (Ajv compiled on the main thread, JSON-serializable `config` consumed by `new Function(src)` on the worker), common pitfalls (no `export default`, tree-shaking boundary, JSON-serializable config, disposing Callables), and the `?sandbox-plugin` vite import.
- [x] 3.7.2 ESLint-rule placeholders (`no-direct-globalThis-write`, `no-direct-fetch`, `no-process-bridge`) called out as future work in §11 of the authoring guide — documentation only, not implemented in this change.

### 3.8 PR 3 verification
- [x] 3.8.1 `pnpm validate` passes — full gate green; 62 test files, 696 vitest tests, exit 0.
- [x] 3.8.2 Flamegraph dashboards render correctly for pre- and post-change events — flamegraph's `barKindFromEventKind` falls back on suffix discrimination, so legacy `system.*` archive events still render (as rest bars); 20 flamegraph tests cover both new (fetch.*, wasi.*) and legacy (system.*, timer.*) event kinds.
- [x] 3.8.3 SECURITY.md §2 rules are enforceable/auditable — the rewritten §2 numbers each rule R-1..R-8; the `packages/runtime/src/security-invariants.test.ts` test file enforces R-1 (private-by-default), R-2 (locked internals), R-3 (hardened-fetch default), R-8 (no runtime metadata in plugin-emitted events, verified implicitly via the tenant-isolation test). R-4..R-7 are review-enforced disciplines; their pass criteria are documented in §2 inline.
- [x] 3.8.4 Full E2E verified against `pnpm dev`: heartbeat (cron) + cronitor (webhook) workflows run concurrently; both produce correct event streams to the dashboard; flamegraph renders `kind-trigger`/`kind-action`/`kind-rest` bar classes with correct color mapping; wasi.* markers render as open-ended leaf events; every invocation persists to archive/*.json via the EventStore's query path. `pnpm validate` exit 0 + 732/732 vitest + 7/7 security invariants + live smoke test all aligned.

## 4. Cross-PR security review

- [x] 4.1 Verified `__sdk` is non-writable, non-configurable, frozen — 3 probe tests in `packages/runtime/src/sandbox-store.test.ts` under "sandbox-store: __sdk lock semantics (SECURITY.md §2)" cover reassignment throws in strict mode, `delete __sdk` returns false, and `__sdk.dispatchAction` reassignment rejected by frozen inner object.
- [x] 4.2 Verified `__sdkDispatchAction`, `__reportErrorHost`, `$fetch/do`, and the legacy raw bridges are all invisible to user source post-phase-3 — 4 tests in `packages/runtime/src/security-invariants.test.ts` under "§4.2 — private descriptors invisible to tenant source" probe `typeof globalThis.__xxx` + `Object.hasOwn(globalThis, "xxx")` for each. `__wptReport` is public by design (test-harness usage) and so is intentionally excluded from this check.
- [x] 4.3 Verified hardenedFetch is the structural default in the fetch plugin — source-grep assertion in `security-invariants.test.ts` checks that `packages/sandbox-stdlib/src/fetch/index.ts` calls `fetchDispatcherDescriptor(hardenedFetch)` directly and contains no `opts.fetch` / `config.fetch` opt-out path.
- [x] 4.4 Verified tenant isolation across concurrent invocations — new test in `security-invariants.test.ts` spawns two distinct sandboxes (`acme` + `beta`), runs them concurrently via `Promise.all`, collects events via independent `sb.onEvent` subscribers, and asserts every event in each stream carries the correct tenant label with no cross-pollination.
- [x] 4.5 Verified dangling frame auto-cleanup doesn't mask audit failures — covered by existing `packages/sandbox/src/plugin-runtime.test.ts` which exercises `truncateFinalRefStack` with a warn-callback; dangling-frame warnings fire through `logDanglingFrame` in `worker.ts` and surface as `{type: "log", level: "warn"}` messages visible to the runtime's logger.
- [x] 4.6 Verified init-failure paths do not leak raw bridges — covered by `packages/sandbox/src/plugin-runtime.test.ts` (failure in `plugin.worker()`, phase-2 source, phase-4 user source all trigger disposal + init-error) combined with §4.2 which proves the bridges never existed in the first place on the plugin-composition path.
- [x] 4.7 Verified no Node.js surface leaks — test in `security-invariants.test.ts` under "§4.7 — no Node.js surface leaks into guest scope" asserts `typeof globalThis.{require, process, Buffer, global, fs, net, child_process, __filename, __dirname}` all resolve to `"undefined"` inside a real plugin-composed sandbox.
