## Context

`SandboxStore` (`packages/runtime/src/sandbox-store.ts`) today is a `Map<string, Promise<Sandbox>>` keyed by `${owner}/${sha}`, with no eviction. Every distinct `(owner, workflow.sha)` that has fired remains resident — each pinning a worker thread, a QuickJS VM, decrypted plaintext secrets for the lifetime of the sandbox, and compiled plugin state. Re-uploads that change a workflow's SHA orphan the old entry without disposing it.

In parallel, `packages/runtime/src/executor/index.ts:65` holds `queues: Map<string, RunQueue>` keyed by `${owner}/${repo}/${sha}`. The queue is the executor's serializer — required because `Sandbox.run()` rejects on concurrent calls (`packages/sandbox/src/sandbox.ts:49-52`). Because this map is string-keyed, it never gets reclaimed, so every `(owner, repo, sha)` tuple that ever invoked leaves a dead queue behind — a slow leak independent of sandbox residency.

The executor additionally tracks three pieces of per-sandbox state: `wired: WeakSet<Sandbox>`, `emitTails: WeakMap<Sandbox, Promise<void>>`, and `activeMeta: WeakMap<Sandbox, InvocationMeta>`. These are already tied to sandbox lifetime via weak references, so GC reclaims them naturally on eviction — but they are four separate data structures tracking aspects of one logical "per-sandbox runtime state."

Relevant constraints:

- **Sandbox lifetime already owns plugin teardown** (SECURITY.md §2 R-4). A plugin with long-lived state must install an `onRunFinished` that drains it; eviction is therefore safe iff the sandbox is not currently running.
- **Runtime-owned event stamping** (SECURITY.md §2 R-8/R-9). The executor's `sb.onEvent` callback stamps `owner`, `repo`, `workflow`, `workflowSha`, `invocationId`, and — on `trigger.request` only — `meta.dispatch`. This site must remain runtime-side; moving it inside a consolidated state object is fine as long as the stamping behaviour is preserved.
- **Existing serialization guarantee** (`executor/spec.md` "Per-workflow serialization via runQueue"). Two concurrent invocations of the same `(owner, workflow.sha)` must not overlap. Two invocations on different workflows (or different SHAs of the same workflow) may run in parallel.

## Goals / Non-Goals

**Goals:**

- Bound process memory by capping resident sandboxes at a configurable count, with eviction that is safe under concurrent invocations.
- Close the `queues` map leak by tying runQueue lifetime to sandbox lifetime.
- Collapse four scattered per-sandbox data structures into one consolidated `SandboxState`.
- Preserve the observable per-`(owner, workflow.sha)` serialization guarantee.
- Preserve every SECURITY.md invariant touching the sandbox lifecycle (R-4, R-8, R-9, R-10).

**Non-Goals:**

- Idle TTL, background sweepers, or any time-based eviction. Eviction is driven purely by creation-miss cap pressure.
- Per-owner fairness or multi-tenant quotas. Global LRU across all owners.
- Memory-pressure-based eviction (RSS thresholds, aggregate QuickJS heap). A count cap is the only bound.
- Stale-SHA push notification from `workflow-registry` to `sandbox-store`. Orphaned SHAs are reclaimed implicitly by LRU position.
- Runaway-guest watchdog. A sandbox stuck in `isActive === true` forever is permanently unevictable under this design; that is an independent concern.
- Pre-warming (eagerly rebuilding evicted sandboxes). First trigger post-eviction pays cold-start.

## Decisions

### D1. Key serialization identity by `Sandbox` instance, not by string tuple

The executor consolidates its four per-sandbox structures into `sandboxState: WeakMap<Sandbox, SandboxState>`:

```ts
interface SandboxState {
  wired: boolean;              // was: wired: WeakSet<Sandbox>
  emitTail: Promise<void>;     // was: emitTails: WeakMap<Sandbox, Promise<void>>
  activeMeta: InvocationMeta | null; // was: activeMeta: WeakMap<Sandbox, InvocationMeta>
  runQueue: RunQueue;          // was: queues: Map<string, RunQueue>
}
```

The invocation path becomes:

```
invoke(owner, repo, workflow, descriptor, input, options):
  sb = await sandboxStore.get(owner, workflow, options.bundleSource)
  state = sandboxState.get(sb) ?? initState(sb)
  return state.runQueue.run(() => runInvocationWith(sb, state, ...))
```

**Rationale.** Two concurrent invocations for the same `(owner, workflow.sha)` resolve to the same `Sandbox` via `sandboxStore.get()` (which caches by the same key), so they hit the same `state.runQueue` and serialize — the observable guarantee is preserved. Evicting a sandbox drops the `WeakMap` entry naturally under GC; the stale `queues` string-keyed map is gone entirely.

**Alternatives considered.**

- *Keep the string-keyed queues map and add a separate per-sandbox state WeakMap.* Rejected — leaves the `queues` leak open and introduces dual bookkeeping.
- *Key the queues map by `(owner, sha)` and clean up in an eviction hook.* Rejected — still a string key, still a cleanup hook to wire, loses the natural WeakMap lifetime tie.

### D2. Expose `isActive` on the `Sandbox` interface

The sandbox already tracks `runActive: boolean` internally (`packages/sandbox/src/sandbox.ts:203`) to reject concurrent `run()` calls. Lift it to a public `isActive` getter on the `Sandbox` interface. Eviction consults `sb.isActive` as the sole gate on whether an entry is safe to dispose.

**Rationale.** The executor's serialization already ensures `sb.run()` is called at most once per sandbox at a time, so `isActive === false` means: no run is currently executing against this sandbox. Combined with the plugin R-4 invariant (all plugin-side work drained before `run()` resolves), `isActive === false` is a sufficient signal that dispose is safe. No refcount, no queue-length probe needed.

**Alternative considered.**

- *Eviction asks executor `isBusy(sb)`.* Rejected — adds a reverse dependency from `sandbox-store` to `executor`. The existing internal flag is a cleaner signal.

### D3. LRU via insertion-ordered `Map`, eviction on creation-miss

Replace `cache: Map<string, Promise<Sandbox>>` with the same type, but relied upon as an insertion-ordered LRU (JS `Map` iteration order is insertion order). Operations:

- **On hit**: `cache.delete(key)` then `cache.set(key, entry)` to move to MRU.
- **On miss**: build new `Promise<Sandbox>`, `cache.set(key, promise)` at MRU, then call `sweep()`.
- **`sweep()`**: iterate the cache in insertion order (LRU → MRU); for each entry, skip if the promise is unresolved or if the resolved sandbox has `isActive === true`; otherwise `cache.delete(key)`, fire-and-forget `sb.dispose()`, and repeat until `cache.size <= cap` or no evictable candidate remains.

**Rationale.** Creation-miss is the only moment we need to reclaim. A background sweeper would impose a periodic timer, reclaim nothing the miss path wouldn't have reclaimed, and complicate shutdown. Soft cap (exceeding temporarily when every candidate is active) is preferable to blocking or rejecting a caller — the cap is a memory hint, not a safety invariant.

**Alternatives considered.**

- *Queue new creations until a slot frees.* Rejected — adds latency + deadlock risk if all active runs are long-lived.
- *Reject creation with an error.* Rejected — surfaces as invocation failure, bad UX.
- *Idle TTL + periodic sweep.* Rejected — user explicitly chose to omit.

### D4. Fire-and-forget dispose with shutdown drain

`sb.dispose()` during eviction is not awaited by the caller that triggered it. The store tracks pending dispose promises in a `Set<Promise<void>>`; `sandboxStore.dispose()` (process shutdown path) awaits them all before returning.

**Rationale.** The calling path is a cold-start invocation already — it should not also pay worker-thread teardown latency. Steady-state teardown happens concurrently with the new sandbox's build. Shutdown drain prevents dangling promises from escaping the process.

### D5. Eviction observability = one structured log line

On eviction: `logger.info({ owner, sha, reason: "lru", ageMs, runCount }, "sandbox evicted")`. Tracked per-entry in the store: creation timestamp and a cumulative run counter incremented at each `get()` hit.

**Rationale.** Eviction is an ops signal, not a user-visible event. Logs are greppable, zero UI work, and do not risk violating SECURITY.md R-7 (reserved event-kind prefixes like `sandbox.evicted` would need care; avoiding an event sidesteps the concern entirely).

### D6. Unresolved-promise entries are skipped by the sweeper

A cache entry can be a `Promise<Sandbox>` that has not yet resolved — for example, the entry just inserted by the current `get()` miss. The sweeper does not await unresolved promises; it skips them and moves on. An unresolved entry is at MRU anyway (just inserted), so it would never be the LRU victim in practice, but the skip makes the sweeper robust if concurrent misses race.

### D7. Configuration surface

Add to `packages/runtime/src/config.ts`:

```ts
SANDBOX_MAX_COUNT: z.string().default("10").transform(Number).pipe(z.number().int().positive())
```

Non-secret; no `createSecret` wrapping. Default `10`. Documented as "maximum resident sandboxes; soft cap — may be exceeded temporarily when every cached sandbox is mid-run." Wired from `Config` into `createSandboxStore({ maxCount })`.

### Sequence: invocation under LRU pressure

```
caller              executor                 sandboxStore              sandbox
  │                   │                          │                        │
  │──invoke(o,r,w)───▶│                          │                        │
  │                   │──get(o, w.sha, src)─────▶│                        │
  │                   │                          │ cache hit on (o,w.sha) │
  │                   │                          │ move entry to MRU      │
  │                   │                          │ increment runCount     │
  │                   │◀──Promise<Sandbox>───────│                        │
  │                   │                          │                        │
  │                   │ state = sandboxState.get(sb) ?? initState(sb)     │
  │                   │ await state.runQueue.run(...)                     │
  │                   │──run(name, ctx)─────────────────────────────────▶ │ isActive=true
  │                   │◀──RunResult────────────────────────────────────── │ isActive=false
  │                   │                          │                        │
  │◀──InvokeResult────│                          │                        │

 (later, unrelated owner o2 triggers a fresh sandbox)

  │──invoke(o2,…)────▶│──get(o2, w2.sha, src2)──▶│                        │
  │                   │                          │ cache miss; build new  │
  │                   │                          │ cache.set(MRU); size > cap
  │                   │                          │ sweep():               │
  │                   │                          │   LRU entry E:         │
  │                   │                          │     await? NO (resolved)
  │                   │                          │     E.sandbox.isActive?│
  │                   │                          │     → false            │
  │                   │                          │   cache.delete(E.key)  │
  │                   │                          │   pending.add(         │
  │                   │                          │     E.sandbox.dispose())│
  │                   │                          │   logger.info({...})   │
  │                   │                          │                        │
  │                   │◀──Promise<Sandbox>───────│                        │
```

## Risks / Trade-offs

- **Cold-start latency under churn.** If traffic regularly spans more than `SANDBOX_MAX_COUNT` distinct `(owner, sha)` pairs, every access thrashes. → Configurable via `SANDBOX_MAX_COUNT`; deployments with large owner cardinality can raise it. Log line lets operators detect thrash.

- **All-active cap overshoot.** Under a traffic spike where every cached sandbox is mid-run, the cache grows unboundedly for the duration of the spike. → Accepted: the soft-cap semantics are explicit; worst case is bounded by concurrent-invocation capacity, which other limits already bound. A hard cap (reject or queue) was considered and rejected in D3.

- **Serialization regression risk.** Moving the runQueue key from `(owner, repo, sha)` string to `Sandbox` instance could in theory under-serialize if `sandboxStore.get()` ever returned distinct sandboxes for the same key concurrently. → It does not: the store caches the `Promise<Sandbox>` itself, so concurrent misses await the same promise. Covered by a targeted test.

- **Runaway guest renders slot unevictable.** A guest that holds `isActive === true` forever consumes a permanent slot. → Pre-existing concern (it would also hold a slot under the current unbounded design); not a regression. Tracked separately.

- **Eviction log cardinality.** One log line per eviction, tagged with `owner` and `sha`. Under heavy churn this could be noisy. → Acceptable — `info` level, one line, no payload, easily filterable.

- **Tests need a way to force eviction without relying on wall-clock or real worker spawns.** → The store can be constructed with an injected `sandboxFactory` (already the case) and a test `maxCount`; tests drive eviction by making miss calls past the cap.
