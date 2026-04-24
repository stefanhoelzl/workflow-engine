## Why

Sandboxes currently live for the entire process lifetime. Each distinct `(owner, workflow.sha)` that has ever fired keeps a worker thread + QuickJS VM resident until graceful shutdown, with no eviction. Re-uploading a workflow orphans the old SHA's sandbox but does not dispose it. Over long-running deployments — especially dev/CI churn, where every push produces a new SHA — resident memory grows without bound. There is also a parallel leak in the executor: `queues: Map<string, RunQueue>` is string-keyed by `(owner, repo, sha)` and never reclaimed, so even after a sandbox would be evicted, its queue would stay behind.

## What Changes

- Cap the sandbox cache at a configurable size (default 10) and evict on creation-miss using an LRU policy. Eviction skips entries whose sandbox is actively running a guest (`sandbox.isActive === true`) and skips entries still building (`Promise<Sandbox>` unresolved). Cap is soft — if every candidate is active, the cache is allowed to temporarily exceed the cap rather than block or reject the caller.
- Expose `isActive: boolean` on the `Sandbox` public interface (the internal `runActive` flag already exists in `packages/sandbox/src/sandbox.ts`; this change lifts it into the contract).
- Consolidate per-sandbox executor state (`wired`, `emitTails`, `activeMeta`, and the string-keyed `queues` map) into a single `WeakMap<Sandbox, SandboxState>` whose entries hold the per-sandbox `RunQueue`. Serialization identity becomes the sandbox instance rather than the `(owner, repo, sha)` string.
- Add the `SANDBOX_MAX_COUNT` environment variable (default `10`, non-secret) to `createConfig`.
- Emit a structured log line per eviction: `{owner, sha, reason: "lru", ageMs, runCount}`. No event-bus event, no dashboard surfacing.
- Fire-and-forget `sb.dispose()` during eviction; `sandboxStore.dispose()` on shutdown drains any still-pending dispose promises.

**Explicitly out of scope** (documented here so a future change does not assume otherwise): idle TTL, background sweepers, per-owner fairness quotas, memory-pressure-based eviction, runaway-guest watchdogs, stale-SHA push from `workflow-registry`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox`: add `isActive` to the `Sandbox` interface contract.
- `executor`: replace per-`(tenant, workflow.sha)` string-keyed runQueue map with per-sandbox runQueue stored in a consolidated `SandboxState` WeakMap; serialization key becomes the sandbox instance. Observable serialization semantics (same workflow invocations serialize; different workflows parallelize) unchanged. Adds requirement for LRU-bounded sandbox cache with active-aware eviction.
- `runtime-config`: add `SANDBOX_MAX_COUNT` integer env var, default `10`, non-secret.

## Impact

- **Code.** `packages/sandbox/src/sandbox.ts` (expose `isActive`), `packages/runtime/src/sandbox-store.ts` (LRU + sweep + logging), `packages/runtime/src/executor/index.ts` (consolidate state into WeakMap, drop `queues` map), `packages/runtime/src/config.ts` (`SANDBOX_MAX_COUNT`), plus tests in both runtime and sandbox packages.
- **Observable behaviour.** Sandboxes may be disposed between invocations under cache pressure; the next trigger on an evicted workflow pays a cold-start (worker spawn + QuickJS init + plugin init + guest module eval). Logged via structured log.
- **Memory.** Resident sandbox count bounded at approximately `SANDBOX_MAX_COUNT`; stale-SHA entries (orphaned by re-upload) naturally sink to LRU and get reclaimed under cap pressure. RunQueue lifetime now equals sandbox lifetime — the `queues: Map<string, RunQueue>` leak is closed.
- **Security.** No SECURITY.md invariants change. R-4 (plugin `onRunFinished` cleanup) continues to hold because eviction only targets `isActive === false` sandboxes. R-8/R-9 (runtime-owned event stamping) is unchanged — the stamp site in `sb.onEvent` moves into `SandboxState` but remains runtime-side. R-10 (no guest state persistence between runs) is strictly strengthened: evicted sandboxes cannot retain guest state, full stop.
- **APIs.** `Sandbox.isActive` is a new read-only field on the public interface of `@workflow-engine/sandbox`. No breaking change — this is an addition.
- **Dependencies.** None added or removed.
- **Infrastructure.** None. This is runtime-internal; no K8s, Traefik, or cluster changes.
