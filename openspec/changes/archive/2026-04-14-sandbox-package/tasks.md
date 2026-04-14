## 1. Phase 1 — Refactor sandbox API in place (still at `packages/runtime/src/sandbox/`)

- [x] 1.1 Rewrite `packages/runtime/src/sandbox/index.ts`: export `sandbox(source, methods, options)` factory returning a `Sandbox` with `run(name, ctx, extraMethods?)` and `dispose()` methods; remove `createSandbox()` and `spawn()`.
- [x] 1.2 Update `RunResult` type: `{ ok: true; result: unknown; logs: LogEntry[] } | { ok: false; error: { message; stack }; logs: LogEntry[] }`. Remove old `SandboxResult` alias.
- [x] 1.3 Rewrite `packages/runtime/src/sandbox/bridge.ts`: remove `bridgeCtx`, `bridgeEvent`, `bridgeEnv`, `bridgeEmit`. Keep `bridgeHostFetch` (wire globalThis.fetch). Move to a new `install-host-methods.ts` module the logic that installs an entry from a `Record<string, async fn>` as a QuickJS global using the internal Bridge primitive.
- [x] 1.4 Implement per-run log buffer reset in `run()`: clear log buffer at the start, return a snapshot in the RunResult; leave the buffer reset between runs.
- [x] 1.5 Implement `extraMethods` install/uninstall per run: track which globals were installed for this run; on completion, remove them. Throw a clear collision error if `extraMethods` contains a name already in construction-time `methods`.
- [x] 1.6 Move VM/runtime/polyfill setup from the old `spawn()` body into `sandbox()`: construct VM once, install built-in bridges (console, timers, performance, crypto, `__hostFetch`) once, install construction-time `methods` once, `evalCode(source)` once. Capture the resolved module namespace for later `run()` calls.
- [x] 1.7 Refactor `run()` to look up the named export from the cached module namespace, call it with the JSON-marshalled `ctx`, await the promise, return the RunResult.
- [x] 1.8 Implement `dispose()`: dispose QuickJS context, runtime, and opaque-ref store. Subsequent `run()` calls throw.
- [x] 1.9 Keep `bridge-factory.ts` internals unchanged in substance, but remove the types that leak QuickJSHandle/Bridge from the package's public exports. Only `Sandbox`, `RunResult`, `LogEntry` are exported.
- [x] 1.10 Update `packages/runtime/src/context/index.ts`: remove `emit` method and `#emit` closure from `ActionContext`; simplify `createActionContext` to not depend on `EventSource` for ctx construction (the factory now returns `{ event, env }` only). Update the factory signature accordingly.
- [x] 1.11 Update `packages/runtime/src/services/scheduler.ts`: maintain `Map<workflowName, Sandbox>`; lazily call `sandbox(action.source, {})` on miss; call `sb.run(action.exportName, ctx, { emit })` per event where `emit` is the runtime's per-event closure calling `EventSource.derive()`. Persist `RunResult.logs` via the existing event-source mechanism. Dispose sandboxes on workflow eviction (see 1.13).
- [x] 1.12 Update `createScheduler` factory signature: remove the `Sandbox` parameter; scheduler owns the sandbox map internally. Added optional `options.sandboxFactory` for test injection.
- [x] 1.13 Wire sandbox disposal to workflow reload/unload: `pruneStaleSandboxes()` runs on each sandbox lookup, disposing any sandbox whose source string is no longer referenced by a live action. Avoided adding a new registry callback; the prune call is cheap and correctness-safe. `scheduler.stop()` also disposes all remaining sandboxes.
- [x] 1.14 Update `packages/runtime/src/main.ts`: no longer creates a sandbox at startup; scheduler owns construction. Removed the top-level `createSandbox()` call.
- [x] 1.15 Update `packages/sdk/src/context/index.ts`: remove `emit` from the SDK's `ActionContext` type. Added `declare global { function emit(type: string, payload: unknown): Promise<void>; }` to the SDK's public type declarations.
- [x] 1.16 Rewrote `packages/runtime/src/sandbox/sandbox.test.ts` to exercise the new API. All sub-bullets covered (see task 5 for security regressions).
- [x] 1.17 Updated `packages/runtime/src/services/scheduler.test.ts`, `packages/runtime/src/integration.test.ts`, `packages/runtime/src/event-bus/recovery.test.ts` to use the new API and sandboxFactory injection.
- [x] 1.18 Update `packages/runtime/src/event-source.ts` imports (import path stable during Phase 1; updated to `@workflow-engine/sandbox` in Phase 2).
- [x] 1.19 `pnpm validate` green after Phase 1.

## 2. Phase 2 — Extract to `packages/sandbox` workspace package

- [x] 2.1 Created `packages/sandbox/` with `package.json` and `tsconfig.json`. No separate `vitest.config.ts` needed — vitest picks up `*.test.ts` from the root config.
- [x] 2.2 Moved `packages/runtime/src/sandbox/*` → `packages/sandbox/src/*` via `git mv` (bridge-factory, bridge, crypto, globals, index, sandbox.test.ts) + plain `mv` for the new `install-host-methods.ts` (untracked at the time of move). Confirmed no cross-package relative imports remain.
- [x] 2.3 Moved `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync` from `packages/runtime/package.json` to `packages/sandbox/package.json`.
- [x] 2.4 Added `"@workflow-engine/sandbox": "workspace:*"` to `packages/runtime/package.json` dependencies.
- [x] 2.5 Updated `packages/runtime/tsconfig.json`: added project reference to `../sandbox`.
- [x] 2.6 Updated all runtime source imports from `./sandbox/...` or `../sandbox/...` to `@workflow-engine/sandbox`.
- [x] 2.7 Updated root `tsconfig.json` project references to include `packages/sandbox`.
- [x] 2.8 `pnpm install` linked the new workspace package. Runtime typechecks the new import. `pnpm build` produces expected artifacts.
- [x] 2.9 Updated `openspec/project.md` to list `@workflow-engine/sandbox` under packages and describe its role, and the new workflow-scoped VM lifecycle.
- [x] 2.10 `pnpm validate` green after Phase 2.

## 3. OpenSpec and threat-model artifacts

- [ ] 3.1 Delete the tombstone at `openspec/specs/sandbox/spec.md` (the 5-line "replaced by action-sandbox" pointer) — superseded by the new spec content from the `specs/sandbox/` delta in this change. **Deferred to archive step**: the change's ADDED requirements in `specs/sandbox/` will replace the tombstone content when this change is archived.
- [ ] 3.2 Delete `openspec/specs/action-sandbox/` after the capability's REMOVED delta archives; verify all archived change files still reference it by name only. **Deferred to archive step**: the REMOVED delta in `specs/action-sandbox/` will process the capability removal.
- [x] 3.3 Updated `SECURITY.md §2 Sandbox Boundary`:
  - Line 113–116 wording replaced with the new `sandbox(source, methods).run(name, ctx, extraMethods)` phrasing.
  - Entry points section expanded to describe construction vs run-time installation of host methods, the JSON-only boundary, and the per-run `emit` extra method.
  - Mitigations section rewrote "Fresh context per invocation" → "Fresh context per workflow module load" with the intra/cross-workflow isolation argument inline; added an explicit Bridge-primitive-internal mitigation.
  - Rules for AI agents: rewrote rule #4 (permits intra-workflow VM reuse, forbids cross-workflow), added a new rule #6 explicitly forbidding Bridge-primitive exposure via the public API, renumbered subsequent rules.
  - File references: all paths updated from `packages/runtime/src/sandbox/*` to `packages/sandbox/src/*`, plus new pointers to `scheduler.ts` and `install-host-methods.ts`, and replaced `action-sandbox/spec.md` with `sandbox/spec.md`.
  - Residual risks: added R-S7 "per-workflow opaque-reference store grows unboundedly".
- [x] 3.4 `pnpm exec openspec validate sandbox-package` reports valid after SECURITY.md edits.

## 4. Workflow author migration

- [x] 4.1 Audit complete: only one `ctx.emit` call in workflow source (`workflows/cronitor.ts:46`) and five in `packages/sdk/src/define-workflow.test.ts` (type-level tests).
- [x] 4.2 Rewrote `workflows/cronitor.ts` — `ctx.emit(...)` → `emit(...)`. The SDK's type-level tests for `ctx.emit` were collapsed into a single test confirming `emit` is available as an ambient global; the narrowing checks were documented as an intentional regression of the new global-emit contract.
- [x] 4.3 `pnpm check` green.
- [x] 4.4 `pnpm test` green across all 367 tests.
- [x] 4.5 `pnpm build` green; workflows bundle regenerates successfully.

## 5. Security regression tests

- [x] 5.1 Node.js globals absent test preserved in `sandbox.test.ts` (`process`, `require`, global `fetch` without polyfill, `globalThis.constructor` escape all rejected).
- [x] 5.2 Added test "internal Bridge methods are not reachable from guest" confirming `storeOpaque`, `derefOpaque`, `opaqueRef` are not on `globalThis` inside the sandbox.
- [x] 5.3 Added test "exportKey on non-extractable key rejects".
- [x] 5.4 Added test "opaque-ref ids from one sandbox are not dereferenceable in another" using two independent sandbox instances.
- [x] 5.5 Added two collision tests: `extraMethods` shadowing a built-in global, and `extraMethods` shadowing a construction-time method — both throw a clear error before the export is invoked.
- [x] 5.6 Added test "per-run log buffer is reset between runs on the same sandbox" verifying console output from the first run does not appear in the second run's `RunResult.logs`.

## 7. Restore ctx.emit typing (follow-up refinement)

- [x] 7.1 Restore the `emit` method on SDK's `ActionContext<Payload, Events, Env>` with generic narrowing: `<K extends keyof Events & string>(type: K, payload: Events[K]) => Promise<void>`.
- [x] 7.2 Wrap user handlers in SDK's `workflow.action({...})`: the wrapper injects `ctx.emit` as a thin proxy that reads `globalThis.emit` at call time and lazily throws a clear error if it's missing. The wrapper is stored in `#actions.handler` and returned from `action()` so the vite-plugin's reference-equality match still holds.
- [x] 7.3 Keep the ambient `declare global { function emit }` declaration as an untyped escape hatch.
- [x] 7.4 Restore the six `ctx.emit` type-level tests in `packages/sdk/src/define-workflow.test.ts` (accepts declared event, rejects trigger events, rejects non-declared events, rejects unknown events, rejects wrong payload, accepts never when no emits declared). Add a "ctx.emit throws when emit global missing" scenario.
- [x] 7.5 Update the reference-equality test to reflect the new invariant: `action()` returns a wrapper distinct from the user handler, and the wrapper is what appears in `compile().actions[i].handler`.
- [x] 7.6 Migrate `workflows/cronitor.ts` back to `ctx.emit(...)` now that the typed path is available.
- [x] 7.7 Update the `sdk` spec delta in this change to describe `ctx.emit` restored with narrowing, the wrapper's lazy-throw behavior, and the dual path (narrow `ctx.emit` + wide ambient `emit`).
- [x] 7.8 Update `SECURITY.md §2` entry points to note that `ctx.emit` is a type-checked alias for the ambient `emit` global, with host-side payload validation unchanged.
- [x] 7.9 Update `proposal.md` to reflect the preserved typing (not a regression after all).
- [x] 7.10 `pnpm validate` green; `pnpm build` rebuilds the workflow bundle with the new typed path.

## 6. Final validation

- [x] 6.1 `pnpm validate` green at the repo root (lint, format, check, test, infra-validate).
- [x] 6.2 `pnpm build` produces expected artifacts (`packages/runtime/dist/main.js`, `workflows/dist/cronitor/{manifest.json,actions.js,bundle.tar.gz}`). Vite-plugin behavior unchanged.
- [x] 6.3 `pnpm exec openspec validate sandbox-package` reports valid.
- [ ] 6.4 Manual sanity: start the local stack (`pnpm dev`), upload a workflow, trigger an event, confirm it runs and logs persist against the event. **Deferred**: requires local infrastructure not runnable in this implementation step; validate during PR review or on branch deploy.
- [ ] 6.5 Squash review of the two-phase commit sequence. **Deferred**: will happen at PR-open time; recommend one commit per phase on this branch.
