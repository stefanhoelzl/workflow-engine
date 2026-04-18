## Why

`SandboxFactory` was spec'd as the supported lifecycle owner for sandboxes (source-keyed cache, `onDied`-triggered eviction, single creation seam), but the runtime bypasses it — `workflow-registry.ts` calls `sandbox()` directly because the factory's `create(source, options)` signature cannot accept per-workflow host methods (`__hostCallAction` is a per-manifest closure). The fallout is a `WorkflowRunner` abstraction whose metadata role belongs to the registry and whose execution role belongs to the executor, plus a registry-owned busy/retiring dance for mid-invocation re-uploads. The factory's cache and death-eviction logic are unused dead weight; the runner is a seam that no longer carves reality at its joints.

## What Changes

- **BREAKING** (internal). Reduce `SandboxFactory` to pure construction: drop the source-keyed cache, drop `onDied`-triggered eviction, keep logger injection and `dispose()` for shutdown.
- Introduce a runtime-owned `SandboxStore` keyed by `(tenant, workflow.sha)`. Builds sandboxes on miss, holds them for process lifetime. No eviction in this change (deferred).
- Remove the `WorkflowRunner` type. Its metadata role collapses into `WorkflowRegistry` (now a pure `(tenant, method, path) → {workflow, triggerName, validator}` lookup); its execution role collapses into `Executor`.
- Change `Executor.invoke` signature from `invoke(runner, trigger, payload)` to `invoke(tenant, workflow, triggerName, payload)`. The executor resolves the sandbox via the store and calls `sandbox.run("__trigger_<name>", payload, runOptions)` directly.
- Delete the registry's busy/retiring lifetime bookkeeping. Mid-invocation re-uploads now complete on the orphaned sandbox (old sha remains in the store, never disposed); new invocations route to the new sandbox via the swapped registry entry.
- Re-key the per-workflow runQueue from `${tenant}/${name}` to `${tenant}/${sha}`, matching sandbox identity.

## Capabilities

### New Capabilities
- `sandbox-store`: Runtime-owned per-`(tenant, sha)` sandbox store. Builds on miss via the factory, holds for process lifetime, provides the sole accessor the executor uses to reach a sandbox.

### Modified Capabilities
- `sandbox`: Trim the sandbox-factory requirements — remove the lazy-cached `create`, death-eviction, and "SHOULD depend on factory for caching" guidance. Factory retains logger injection, `create(source, options) → Sandbox`, `dispose()`, and eval-failure propagation.
- `workflow-registry`: Remove `WorkflowRunner` from the registry's public surface. Registry becomes pure metadata: `lookup(tenant, method, path) → {workflow, triggerName, validator}`. Re-upload no longer defers sandbox disposal; old sandboxes are orphaned (see `sandbox-store`).
- `executor`: Update `invoke` signature to `(tenant, workflow, triggerName, payload)`. Executor depends on a `SandboxStore` (not a `SandboxFactory`) for sandbox resolution. runQueue key changes to `${tenant}/${sha}`.
- `service-lifecycle`: Update any references from `SandboxFactory` to the new construction-only shape and to the runtime-owned `SandboxStore`.

## Impact

- **Code**:
  - `packages/sandbox/src/factory.ts` — strip cache + `onDied` eviction; keep `create` + `dispose`.
  - `packages/sandbox/src/factory.test.ts` — drop cache / death-eviction tests.
  - `packages/runtime/src/sandbox-store.ts` (**new**) — per-`(tenant, sha)` store.
  - `packages/runtime/src/sandbox-store.test.ts` (**new**) — hit/miss, per-tenant isolation, orphan-survives-invocation.
  - `packages/runtime/src/workflow-registry.ts` — rewrite as metadata-only lookup.
  - `packages/runtime/src/workflow-registry.test.ts` — rewrite; delete the busy/retiring test at `:370`.
  - `packages/runtime/src/executor/types.ts` — delete `WorkflowRunner`.
  - `packages/runtime/src/executor/index.ts` — new `invoke` signature + store lookup.
  - `packages/runtime/src/executor/index.test.ts` — adapt to new signature.
  - `packages/runtime/src/triggers/http.ts` — adapt to new registry shape.
  - `packages/runtime/src/triggers/http.test.ts` — minor adapt.
  - `packages/runtime/src/main.ts` — wire `SandboxStore` into executor + registry.
  - `packages/runtime/src/integration.test.ts`, `cross-package.test.ts` — verify end-to-end behavior unchanged (should not require changes beyond construction wiring).
- **APIs**: No external HTTP/webhook changes. Internal TypeScript API of `@workflow-engine/sandbox` (factory) narrows; `@workflow-engine/runtime` gains `SandboxStore`.
- **Dependencies**: None added.
- **Runtime behavior**:
  - Memory grows monotonically per process with unique `(tenant, sha)` pairs ever seen. Acceptable for pod-lifetime bounded workloads; flagged as a risk for long-lived processes with rapid re-upload patterns.
  - Mid-invocation re-upload is now more robust: in-flight invocation completes on the orphaned sandbox; no cross-sandbox migration or forced disposal.
- **Documentation**: `/SECURITY.md` — check if §2 or §5 reference `SandboxFactory` caching as an invariant; update accordingly.
- **Persistence/manifest**: Unchanged.
