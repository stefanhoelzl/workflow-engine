## Context

Today the runtime has four overlapping lifecycle concepts for workflow execution:

```
  ┌────────────────────────────────┐    ┌────────────────────────────────┐
  │ SandboxFactory (sandbox pkg)   │    │ WorkflowRunner (runtime)       │
  │   source-keyed cache           │    │   tenant, name, env            │
  │   onDied → evict               │    │   actions, triggers            │
  │   ⚠ UNUSED by runtime          │    │   invokeHandler()              │
  └────────────────────────────────┘    │   onEvent()                    │
                                         │   (one per tenant/workflow)    │
                                         └────────────────────────────────┘
  ┌────────────────────────────────┐    ┌────────────────────────────────┐
  │ WorkflowRegistry (runtime)     │    │ Executor (runtime)             │
  │   owns runners[]               │    │   invoke(runner, t, payload)   │
  │   lifetimes (busy/retiring)    │    │   runQueue by tenant/name      │
  │   defer dispose until idle     │    │   emit events via bus          │
  └────────────────────────────────┘    └────────────────────────────────┘
```

The factory was spec'd as the supported sandbox-lifecycle owner, but its `create(source, options)` signature cannot carry per-workflow host methods. `__hostCallAction` — the dispatcher validating action inputs against a manifest-derived Ajv schema — must be a per-workflow closure passed at sandbox construction. Since `sandbox()` accepts methods but `factory.create()` doesn't, the registry went around the factory and called `sandbox()` directly. Grep confirms: `createSandboxFactory` has zero call sites in `packages/runtime`.

The archived change `2026-04-15-function-call-composition` (task 5.2) records this short-cut explicitly:

> Diverged from the literal signature: executor is `createExecutor({ bus })` and receives a `WorkflowRunner` (with `invokeHandler`) from the caller. Rationale: the sandbox factory's current API (`create(source, options)`) does not take methods, and `__hostCallAction` must be wired per workflow with a per-manifest closure — Phase 4's workflow-registry owns that lifecycle.

So `WorkflowRunner` exists because the factory didn't fit, and the registry's busy/retiring bookkeeping exists to defer sandbox disposal on mid-invocation re-upload. We're cutting both concepts: the factory becomes construction-only, a runtime-owned `SandboxStore` replaces the unused factory cache with a per-`(tenant, sha)` cache that actually matches how the runtime keys sandboxes, and runners disappear by splitting their metadata role into the registry and their execution role into the executor.

**Constraints:**
- Security invariants (SECURITY.md §2): `__hostCallAction` is a per-workflow closure; a shared sandbox would need identical action schemas. Per-`(tenant, sha)` keying preserves today's isolation (no cross-tenant sandbox sharing).
- Per-workflow serialization (D4 in the function-call-composition design): at most one in-flight invocation per sandbox. `sandbox.run` is not re-entrant.
- Mid-invocation re-upload must not kill the in-flight invocation (existing behavior to preserve; today achieved via busy/retiring defer-dispose).

## Goals / Non-Goals

**Goals:**

- Delete `WorkflowRunner` as a concept. Its metadata role moves into `WorkflowRegistry`; its execution role moves into `Executor`.
- Reduce `SandboxFactory` to pure construction: `create(source, options) → Sandbox`, `dispose()` for shutdown, logger injection. No caching, no `onDied`-triggered eviction.
- Introduce `SandboxStore` in `packages/runtime` keyed by `(tenant, workflow.sha)`. One sandbox per unique workflow per tenant; held for process lifetime.
- Preserve mid-invocation re-upload robustness without the busy/retiring dance — old sandboxes orphan naturally.
- Preserve all observable behavior: response shapes, lifecycle events, persistence semantics, HTTP routing.

**Non-Goals:**

- **Cross-tenant sandbox sharing.** Even byte-identical bundles get separate sandboxes per tenant. Avoids the cross-tenant module-state leak and keeps the per-workflow validator closure simple.
- **Eviction / LRU / orphan cleanup.** Sandboxes live for process lifetime. Eviction is a follow-up change.
- **Behavioral changes to sandbox execution** (host bridges, `__hostCallAction`, trigger shim, action dispatcher, worker protocol).
- **New public APIs for operators.** This is an internal refactor; the HTTP/webhook surface does not change.
- **Dashboard / UI changes.** `registry.runners[]` is consumed by dashboard/trigger UI; those consumers adapt to the new lookup shape but gain no new features.

## Decisions

### D1: Per-tenant sandbox keying (`(tenant, sha)`), not cross-tenant sharing

**Decision:** `SandboxStore` keys sandboxes by `(tenant, workflow.sha)`. Two tenants uploading identical bundles get independent sandboxes.

**Alternatives considered:**

1. **Cross-tenant sharing** (key only on `workflow.sha`). Rejected: (a) QuickJS module-scope state persists across invocations within a sandbox — a module-scope `Map` used as a cache would leak data across tenants; (b) the `__hostCallAction` logger currently tags log lines with workflow identity, which works, but widening to cross-tenant sharing increases the blast radius of a validator bug; (c) the memory savings are speculative (tenants rarely upload byte-identical bundles in practice).

**Rationale:** Preserves today's isolation boundary. The only cost is memory duplication across tenants with identical bundles — acceptable given the workload profile.

### D2: Sandboxes live forever within a process

**Decision:** The store never disposes sandboxes except on process shutdown. Re-uploading a tenant with a changed sha leaves the old sandbox orphaned in the store until the process restarts.

**Alternatives considered:**

1. **Dispose orphans on re-upload.** Re-introduces the busy/retiring dance we are removing — must defer dispose until in-flight invocations finish. Rejected: brings back the complexity this change exists to delete.
2. **LRU eviction.** Useful at scale, but premature for current workloads. Explicitly deferred.

**Rationale:** "Live forever" replaces the busy/retiring state machine with trivially-correct "in-flight invocation completes on the orphaned sandbox, new invocations hit the new sandbox." Memory growth is bounded by unique `(tenant, sha)` pairs ever uploaded in a process lifetime, which is a restart-bounded quantity in practice.

### D3: Store location — `packages/runtime`, not `packages/sandbox`

**Decision:** `SandboxStore` lives in `packages/runtime/src/sandbox-store.ts`. The sandbox package remains tenant-unaware and workflow-unaware.

**Alternatives considered:**

1. **Push the store into the sandbox package** (promote `SandboxFactory` to own tenant-scoped caching). Rejected: leaks workflow/tenant concepts into the sandbox layer, exactly the layering violation we're trying to fix. The sandbox package stays a pure execution primitive.

### D4: Registry becomes pure metadata lookup

**Decision:** `WorkflowRegistry` owns per-tenant manifest metadata and provides a single lookup:

```ts
registry.lookup(tenant, method, path)
  → { workflow: WorkflowManifest, triggerName: string, validator: PayloadValidator } | undefined
```

It also retains tenant-level operations (`registerTenant`, `recover`, `dispose`) but no longer owns sandboxes or runners. On re-registration, the in-memory metadata for the tenant is replaced; sandbox orphans in the store are left alone.

**Alternatives considered:**

1. **Keep registry as the composition point** (registry owns both metadata and the store, exposes `runners[]` for compatibility). Rejected: continues to couple metadata and execution. Cleaner break is to separate concerns now.
2. **Registry still returns a `WorkflowRunner`-shaped object** (lighter than today but still a wrapper). Rejected: the whole point of this change is to delete the runner concept — reintroducing it in a diminished form is a worse outcome than cleanly removing it.

### D5: Executor takes `(tenant, workflow, triggerName, payload)`

**Decision:** Change `Executor.invoke` to `invoke(tenant, workflow, triggerName, payload) → Promise<HttpTriggerResult>`. The executor:

1. Looks up the sandbox via the store: `sb = await store.get(tenant, workflow, bundleSource)`.
2. Runs under the per-sandbox queue: `queueFor(${tenant}/${workflow.sha}).run(() => ...)`.
3. Subscribes its bus-emit tail to `sb.onEvent` once per sandbox (not per invocation).
4. Calls `sb.run("__trigger_<triggerName>", payload, {invocationId, tenant, workflow: workflow.name, workflowSha: workflow.sha})`.

**Alternatives considered:**

1. **Executor accepts a pre-resolved sandbox** (`invoke(sandbox, ...)`). Rejected: pushes sandbox resolution into the caller (HTTP trigger middleware), which would need direct access to the store — duplicates the resolution logic on every call site.
2. **Executor accepts the registry's lookup result directly** (`invoke(lookupResult, payload)`). Viable but mixes lookup concerns with execution; current shape is clearer.

### D6: runQueue re-keyed to sandbox identity (`${tenant}/${sha}`)

**Decision:** The per-sandbox queue is keyed on `${tenant}/${workflow.sha}`, not `${tenant}/${workflow.name}`. This matches the sandbox identity in the store and preserves the invariant that `sandbox.run` is not re-entrant.

**Rationale:** Today's key `${tenant}/${name}` happened to coincide with sandbox identity because one runner = one workflow = one sandbox. After this change the store makes sandbox identity explicit via sha, and the queue follows.

**Invariant to note:** Two workflows within a tenant with identical shas would share a queue. In practice this cannot happen — `workflow.sha` covers manifest content including `workflow.name`, so different names produce different shas.

### D7: Store API — `get` builds on miss

**Decision:**

```ts
interface SandboxStore {
  get(
    tenant: string,
    workflow: WorkflowManifest,
    bundleSource: string,
  ): Promise<Sandbox>;
  dispose(): void; // process shutdown only
}
```

`get` returns the cached sandbox on hit, or builds one (via factory + per-workflow `__hostCallAction` closure) on miss. No public `remove`/`disposeTenant` — eviction is not a goal.

**Internal (not exposed):** `remove(tenant, sha)` is reserved for a future eviction-policy change; it does not ship in this change.

**Rationale:** Minimal surface. The simplicity of "sandboxes live forever" is the whole point; a public eviction API would re-open the door to busy/retiring logic.

### D8: `__hostCallAction` closure construction moves into the store

**Decision:** The store owns the recipe for building a sandbox from a workflow: it compiles the per-action Ajv validators, constructs the `__hostCallAction` closure, assembles the sandbox source (bundle + action-dispatcher + name-binder + trigger-shim), and calls `factory.create(source, {methods: {__hostCallAction}, filename, methodEventNames})`. The registry does not participate.

**Alternatives considered:**

1. **Registry builds sandboxes eagerly at `registerTenant`, passes them to the store.** Rejected: duplicates construction logic across registry and store, and couples registration latency to sandbox construction latency. Lazy on-first-invocation is simpler.
2. **Executor builds sandboxes.** Rejected: executor should not own manifest interpretation.

## Risks / Trade-offs

- **Memory growth per tenant × unique shas** → `SandboxStore` grows monotonically; restart-bounded. Fine for pod-lifetime workloads; a risk for long-lived processes with rapid re-upload. **Mitigation:** flag in operator docs; address with a future eviction change when operational need demands.
- **Orphan sandboxes still consume worker threads** → each sandbox holds a Node `worker_thread`. 100 orphans = 100 extra worker threads. **Mitigation:** same as above — not a v1 concern for expected workloads.
- **Lazy sandbox construction moves first-invocation latency** → today the registry builds sandboxes eagerly at `registerTenant`, so the first webhook sees a hot sandbox. After this change the first webhook per `(tenant, sha)` pays sandbox construction cost (~100–500ms). **Mitigation:** acceptable; alternative is to keep eager construction as an optimization flag, deferred.
- **Two-pass migration risk** → dashboard / trigger UI consume `registry.runners[]` today. Those consumers migrate to the new lookup shape in the same change. **Mitigation:** integration + cross-package tests catch regressions; dashboard/trigger UI tests updated in the same PR.
- **Busy/retiring test at `workflow-registry.test.ts:370` covers a real behavior** — "mid-invocation re-upload doesn't kill the invocation." The new `sandbox-store.test.ts` covers the equivalent behavior (orphan-survives-invocation) via a different mechanism. **Mitigation:** the existing test is deleted and replaced with the new one; both describe the same observable contract.
