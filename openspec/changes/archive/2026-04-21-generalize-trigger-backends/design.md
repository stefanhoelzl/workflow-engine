## Context

The `generalize-triggers` change (2026-04-19, archived) introduced the `TriggerSource` plugin contract and the `reconfigure(view)` call shape. The `add-cron-trigger` change (2026-04-21, archived) added the second kind. Both were scoped to getting manifests, descriptors, and the plugin host right; the reconfigure contract itself was left in the shape that fit those two kinds specifically.

Current state of the contract:

```
WorkflowRegistry.registerTenant(tenant, files)
  └── parses manifest → builds descriptors
  └── notifySources()
       └── for each source:
            source.reconfigure(kindFilteredView)
                 where each view entry is {tenant, workflow, bundleSource, descriptor}

HTTP TriggerSource.reconfigure(view):
  └── rebuilds internal URLPattern index
  └── on inbound HTTP request:
       └── executor.invoke(tenant, workflow, descriptor, input, bundleSource)
            ^                                                  ^
            identity                                           code reference
            captured from entry                                captured from entry

Cron TriggerSource.reconfigure(view):
  └── cancels all timers, rebuilds from scratch
  └── on tick:
       └── executor.invoke(tenant, workflow, descriptor, {}, bundleSource)
```

Two observations that motivate this change:

1. **Every backend reimplements the same `executor.invoke(...)` call** with the same five arguments. The next backend (planned: IMAP) will do the same. Threading the executor/tenant/bundleSource plumbing through each new file is noise; it also means each backend sees internals (bundleSource, tenant) it doesn't need for its actual job (mapping a protocol event to an input).
2. **Reconfigure is sync void.** A backend that does real I/O during reconfigure (open an IMAP connection, verify credentials) has no way to surface "your credentials are wrong" as something the upload API can return as a 4xx. Logging to stdout is the only current option.

We've already aligned on the design in an interview (workspace conversation). This document captures the decisions for implementation.

## Goals / Non-Goals

**Goals:**

- Backends receive pre-wired callbacks per trigger and never touch the executor.
- `reconfigure` is scoped per-tenant with clear "replace everything for this tenant" semantics.
- `reconfigure` can signal user-config errors (4xx) and infra errors (5xx) distinctly.
- Adding a new backend (IMAP) is a single file under `packages/runtime/src/triggers/` plus one line in `main.ts`.
- Internal refactor only: no manifest schema change, no SDK change, no tenant re-upload required.

**Non-Goals:**

- Configurable HTTP paths — handled by the parallel `fix-http-trigger-url` change.
- Sandbox output-schema validation — handled by the parallel `sandbox-output-validation` change.
- Restore/rollback on partial-reconfigure failure — explicitly not guaranteed; failed uploads may leave live state inconsistent with storage until the tenant re-uploads. Keeping it simple beats the complexity of a compensating-action protocol.
- Horizontal scaling / multi-instance cron coordination — unchanged from today's single-instance assumption.
- Cancellation / abort of in-flight invocations across reconfigure — out of scope. In-flight fires complete on their captured closures; no draining, no cancellation.

## Decisions

### D1. `TriggerEntry` carries `{descriptor, fire}` — nothing else

```ts
interface TriggerEntry<D extends BaseTriggerDescriptor> {
  readonly descriptor: D;
  readonly fire: (input: unknown) => Promise<InvokeResult<unknown>>;
}
```

**Rationale:** the backend needs the descriptor (to know what URL/schedule/mailbox it represents) and something to call when it fires. Tenant and workflow identity are captured inside `fire` by the registry. Any per-entry identity the backend wants for diffing or logging can be derived from `descriptor.name` combined with the `tenant` argument to `reconfigure` — no separate `id` field needed.

**Alternatives considered:**
- Add `tenant` and `workflowName` fields on the entry for logging — rejected; backends that want to log can take the `tenant` arg of `reconfigure` and combine with `descriptor.name`. Keeps the entry shape smaller.
- Add a stable `id: string` for diff-based reconfigure inside backends — rejected because `id` alone can't detect config changes (same `(tenant, workflow, trigger)` key, different schedule). Backends that need diffing compare the full entry set to their previous state, which is naturally available since they hold per-tenant state.
- Phantom generics on descriptor for typed `fire: (InputOf<D>) => …` — rejected. Backends handle heterogeneous entries (one HTTP source serves many triggers with different I/O shapes), so the phantom types collapse to `any` at the iteration site. Types are worth nothing where the collapse happens; the SDK's `httpTrigger<I,O>(…)` already covers author-site ergonomics via Zod + `z.infer`. The public `fire` signature uses `unknown`.

### D2. `reconfigure(tenant, entries): Promise<ReconfigureResult>`

```ts
type ReconfigureResult =
  | { ok: true }
  | { ok: false; errors: TriggerConfigError[] };  // user-config, 4xx

interface TriggerSource<K extends string, D extends BaseTriggerDescriptor<K>> {
  readonly kind: K;
  start(): Promise<void>;
  stop(): Promise<void>;
  reconfigure(tenant: string, entries: readonly TriggerEntry<D>[]): Promise<ReconfigureResult>;
}
```

**Rationale:**
- Per-tenant scoping matches the existing atomicity of `registerTenant` (one tenant bundle = one logical unit of replacement). Backend stores state as `Map<tenant, BackendState>`; `reconfigure(tenant, entries)` wipes `Map.get(tenant)` and installs `entries`.
- Empty array deletes the tenant's triggers for that kind — no separate `removeTenant` method needed.
- Discriminated result separates **user-config errors** (bad credentials, invalid cron syntax caught at runtime, etc.) from **backend-infra errors** (thrown, e.g., server unreachable). Registry maps `{ok: false}` to HTTP 400 and throws to 500.
- Async because future backends (IMAP) do I/O during reconfigure. Cron and HTTP are trivially async today (just wrap in `Promise.resolve()`).

**Alternatives considered:**
- Diff-based API `{added, removed, replaced}` — rejected. The registry can't compute "replaced vs unchanged" meaningfully because "same" is backend-specific (IMAP cares about server+creds; cron cares about schedule+tz). Backends that want diffing do it themselves against their held state, which is simpler than lifting policy into the registry.
- Sync void (today's shape) — rejected; no way to surface classified errors.
- Single error type, registry classifies by message prefix — rejected; brittle and hostile to tooling.

### D3. `buildFire` is a non-generic helper in the registry

```ts
function buildFire(
  executor: Executor,
  tenant: string,
  workflow: WorkflowManifest,
  descriptor: BaseTriggerDescriptor,
  bundleSource: string,
  validate: (schema: Record<string, unknown>, input: unknown) =>
    | { ok: true; value: unknown }
    | { ok: false; error: ValidationError },
): (input: unknown) => Promise<InvokeResult<unknown>> {
  return async (input) => {
    const v = validate(descriptor.inputSchema, input);
    if (!v.ok) return { ok: false, error: { message: v.error.message } };
    return executor.invoke(tenant, workflow, descriptor, v.value, bundleSource);
  };
}
```

**Rationale:** at the point of fire construction, the registry has just parsed descriptors from the manifest — everything is `BaseTriggerDescriptor` with no narrower type available. A generic `buildFire<D>` helper would resolve `D = BaseTriggerDescriptor` at every call site. Pure ceremony. The Zod-to-TS-type plumbing that gives authors typed handlers lives entirely in the SDK (`httpTrigger<I,O>({inputSchema, outputSchema, handler})`) where `I` and `O` are inferable from the Zod schemas — this never reaches the runtime.

**Input validation lives here, not in the backend.** Backends normalize raw protocol events into a canonical input shape (HTTP: `{body, query, headers, method}`; IMAP: parsed email struct). `buildFire` validates that shape against `descriptor.inputSchema` before calling `executor.invoke`. One place owns validation policy.

**Alternatives considered:**
- Backend calls `validate(descriptor, rawInput)` itself — rejected; each new backend would reimplement the same call and the failure-result shape (`{ok: false, error: {message}}`). Centralizing is cheaper.
- Registry wraps `fire` *outside* the backend completely (backend receives raw protocol input, registry handles everything including normalization) — rejected; normalization is protocol-specific and belongs to the backend. Validation is schema-driven and belongs to the registry.

### D4. Parallel reconfigure across backends, no rollback, persist-on-full-success

```
tenant upload
    │
    ▼
parse manifest  ─────▶ manifest invalid ─▶ 422 + zod issues (today's behavior)
    │
    ▼
partition entries by kind → build `fire` per entry via buildFire
    │
    ▼
Promise.allSettled([
  httpSource.reconfigure(tenant, httpEntries),
  cronSource.reconfigure(tenant, cronEntries),
  ... (future backends)
])
    │
    ▼
any thrown?       ───yes──▶ 500 {errors: [...]} (infra)
    │
    ▼
any {ok: false}?  ───yes──▶ 400 {errors: [...]} (user-config)
    │
    ▼
all {ok: true}
    │
    ▼
writeBytes('workflows/<tenant>.tar.gz', bytes)  (persist-on-full-success)
    │
    ▼
204 No Content
```

**Rationale:**
- Parallel: latency of the slowest backend, not the sum. Backends are independent.
- No rollback on mixed success: keeping "restore to old state" correct under a failed restore is a rabbit hole (what if the restore also fails? retry? halt the process?). The user has explicitly asked to keep it simple with no guarantees on failed uploads. Storage is not updated on failure, so on restart `recover()` replays the old bundle — the tenant can simply re-upload.
- Persist-on-full-success (not persist-first-then-rollback): keeps the storage key consistent with the happy path. If reconfigure succeeds but `writeBytes` crashes, recover() on restart re-runs reconfigure from the old bundle — uploads are idempotent, tenant re-uploads. Acceptable crash window.

**Alternatives considered:**
- Sequential fail-fast with rollback — rejected per user direction; partial state is accepted.
- Stage-then-swap storage (`.pending` key) — rejected; the persist-on-full-success path has a strictly smaller crash window (no intermediate `.pending` key ever exists). The loss case is "upload succeeded end-to-end except the final writeBytes crashed" → tenant re-uploads. That's rare and benign.

### D5. In-flight fires finish on captured closures

`fire` is a closure constructed once per reconfigure, capturing `(executor, tenant, workflow, descriptor, bundleSource)` at that moment. When the next reconfigure replaces the entries, the old closure is no longer referenced by the backend, but an in-flight fire call still holds its reference and runs to completion.

Sequence:

```
t0: reconfigure(tenant, entriesV1)
    └── httpSource stores entries with fire1 closures
t1: HTTP request arrives
    └── httpSource resolves entry1 → calls entry1.fire(input)
    └── fire1 → executor.invoke(tenantV1, workflowV1, descV1, input, bundleV1)
    └── executor enqueues on runQueue[(tenant, workflowV1.sha)]
t2: reconfigure(tenant, entriesV2)  (tenant re-uploads)
    └── httpSource replaces entries with fire2 closures
t3: in-flight call from t1 dequeues and runs the sandbox for workflowV1.sha
    (sandboxStore still holds workflowV1's sandbox — no eviction)
t4: fire1 resolves with result; HTTP response is written
t5: new HTTP request arrives
    └── httpSource resolves entry2 → calls entry2.fire(input)
    └── fire2 → executor.invoke(tenantV2, workflowV2, descV2, input, bundleV2)
```

**Why this is safe:** the `SandboxStore` is keyed by `(tenant, workflow.sha)` and does not evict on registry mutations. The v1 bundle's sandbox stays alive for any in-flight invocation holding it.

**Consequence:** `reconfigure` does NOT await in-flight fires. It returns as soon as its own state swap is done. This matches the existing cron source behavior (cancel timers, rebuild) and is safe because fire closures are immutable.

### D6. `start()` and `stop()` semantics

- `start()` — called once at server boot, before `registry.recover()`. Backend allocates infra-level resources (HTTP mounts its Hono middleware; cron starts its scheduler; IMAP opens its connection pool). No entries are known yet.
- `stop()` — called at server shutdown. Backend stops accepting new fires (HTTP returns 503 from its middleware; cron cancels pending timers; IMAP closes server sockets). In-flight invocations run to completion via the executor's per-workflow runQueue — no cancellation, no draining inside the backend.

**Alternatives considered:**
- Fold `start`/`stop` into `reconfigure` (lifecycle implicit) — rejected; the start call is stateless init (mount the middleware once) and has no "tenant" context.
- Drain in-flight on stop — rejected; sandboxes keyed by sha keep state alive regardless, and drain-on-stop adds non-trivial complexity for no observable invariant.

### D7. Unknown trigger kinds rejected at manifest parse

The registry's constructor takes `backends: readonly TriggerSource[]`. It computes `allowedKinds = new Set(backends.map(b => b.kind))`. Manifest parsing checks each trigger's `type` against `allowedKinds`; unknown kinds produce a standard manifest-validation error (`422` from the upload API).

**Rationale:** fail-closed. A tenant uploading a bundle that uses `type: "imap"` on a deployment without an IMAP backend gets a clear error rather than silently-dead triggers.

**Alternatives considered:**
- Accept upload, log, skip unknown-kind triggers — rejected; the "my trigger never fires and nothing tells me why" footgun is worse than rejecting up front.

## Risks / Trade-offs

**[R1: Divergence between live backend state and storage on failed upload]** → Documented non-guarantee. Tenant re-uploads; `recover()` replays the old bundle on restart. Explicitly called out in CLAUDE.md upgrade notes.

**[R2: No backward-compatible path for backends that can't be async]** → All backends can trivially `Promise.resolve({ok: true})` for in-memory ops. No real risk; just a uniform interface.

**[R3: Existing specs (`workflow-registry` in particular) document `lookup(tenant, method, path)`, which was already superseded by the generalize-triggers change]** → This proposal's delta for `workflow-registry` removes the stale requirements and documents the current reality (no `lookup`; HTTP source owns its own routing). Housekeeping for drift that existed before this change.

**[R4: Error aggregation shape is new and not versioned]** → Accepted. Upload API is internal to the operator (tenants use the CLI, not direct API curl). If error shape becomes part of a stable public contract later, version it then.

**[R5: `buildFire` captures `workflow` and `bundleSource` — if the sandbox is evicted, in-flight fires reference stale bundle data]** → Today's `SandboxStore` does not evict on registry changes; it holds per-`(tenant, sha)` sandboxes for process lifetime. This proposal does not change that. If eviction is added later, it must consider in-flight fire references; call this out in the sandbox-store capability documentation when that change comes.

## Migration Plan

Internal refactor — no tenant-visible migration.

**Deploy steps:**
1. Land the change on `main`. CI enforces type + test gates.
2. Prod deploy via existing `release` branch flow. No kubeconfig edits, no env changes, no secret rotation.
3. Upload API's response changes shape on failure (4xx/5xx split). The CLI (`wfe upload`) already expects a non-2xx response as failure; error message text will change but exit codes are preserved. No CLI update needed for this change.

**Rollback:** standard `git revert` on `release`. No schema or storage migration to unwind.

**Tenant action:** none. Bundles uploaded before and after land identically on the backend contracts; the registry reconstructs fire closures the same way regardless of when the bundle was uploaded.

## Open Questions

None identified in the interview. All branches of the decision tree resolved before writing this document.
