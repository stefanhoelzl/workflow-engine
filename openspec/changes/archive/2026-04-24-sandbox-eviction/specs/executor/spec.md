## MODIFIED Requirements

### Requirement: Per-workflow serialization via runQueue

The executor SHALL maintain one runQueue per live `Sandbox` instance (held in a `WeakMap<Sandbox, SandboxState>` so its lifetime equals the sandbox's). The runQueue SHALL ensure that at most one trigger invocation runs at a time against a given sandbox. The runQueue SHALL be a Promise-chain serializer that does not lose subsequent invocations on prior failure (failures unblock the queue).

Because `sandboxStore.get(owner, workflow.sha, …)` returns the same `Sandbox` for every call with the same `(owner, workflow.sha)` key (caching the `Promise<Sandbox>` itself), two concurrent invocations of the same `(owner, workflow.sha)` resolve to the same runQueue and therefore serialize. Invocations on distinct `(owner, workflow.sha)` pairs, or on the same `(owner, workflow.sha)` across a sandbox eviction boundary (where the sandbox has been disposed and the next invocation cold-starts a replacement), SHALL use distinct runQueues and MAY run in parallel with any residual work from the prior sandbox.

#### Scenario: Two invocations of the same workflow serialize

- **GIVEN** tenant `t1`, workflow `w1`, with two triggers `ta` and `tb`
- **WHEN** `executor.invoke(t1, w1, ta, pa)` and `executor.invoke(t1, w1, tb, pb)` are called concurrently
- **THEN** the second invocation's handler SHALL not begin executing until the first completes (success or failure)

#### Scenario: Two workflows run in parallel

- **GIVEN** tenant `t1`, workflows `w1` and `w2` each with one trigger
- **WHEN** invocations on `w1` and `w2` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel (each in its own sandbox)

#### Scenario: Two tenants run in parallel

- **GIVEN** tenants `tA` and `tB` each with a registered workflow whose bundles hash to identical shas
- **WHEN** invocations on `tA` and `tB` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel, each against its tenant-scoped sandbox

#### Scenario: Failure unblocks the queue

- **GIVEN** tenant `t1`, workflow `w1`, whose invocation `i1` fails
- **WHEN** invocation `i2` is dispatched immediately after
- **THEN** `i2` SHALL begin executing rather than being blocked by `i1`'s failure

#### Scenario: runQueue is reclaimed when sandbox is evicted

- **GIVEN** a sandbox that has served some invocations and is then evicted by the sandbox cache
- **WHEN** the sandbox instance becomes unreachable
- **THEN** the executor's `SandboxState` entry (including its runQueue) SHALL be reclaimed by GC along with the sandbox
- **AND** no string-keyed runQueue map SHALL retain a reference to it

## ADDED Requirements

### Requirement: Sandbox cache is bounded by SANDBOX_MAX_COUNT

The runtime SHALL bound the resident count of `(owner, workflow.sha)` sandboxes at the value of the `SANDBOX_MAX_COUNT` configuration variable (see `runtime-config/spec.md`). The bound SHALL be enforced on cache insertion: after a cache miss that adds a new entry, the store SHALL iterate entries in least-recently-used order and evict entries until the size is at most `SANDBOX_MAX_COUNT` or no evictable candidate remains. An entry is evictable iff its `Promise<Sandbox>` has resolved and the resolved sandbox's `isActive` is `false`.

The bound is a soft cap. If every cached entry is active or still building, the cache SHALL be permitted to exceed `SANDBOX_MAX_COUNT` temporarily rather than block or reject the caller. The excess SHALL be reclaimed by the next eviction pass once an entry becomes evictable.

A cache hit SHALL mark its entry as most-recently-used (moving it to the MRU end of the insertion order). Eviction SHALL NOT use wall-clock time, idle TTL, or a background sweeper; reclamation is driven exclusively by creation-miss cap pressure.

Evicting an entry SHALL remove it from the cache synchronously and SHALL invoke `sandbox.dispose()` without awaiting its resolution on the caller's critical path. The store SHALL track pending dispose promises internally and SHALL await them during its own `dispose()` on process shutdown.

Every eviction SHALL emit one structured log entry at `info` level containing the evicted `(owner, sha)`, the reason `"lru"`, the entry's age since creation in milliseconds, and the cumulative run count observed on that entry. The store SHALL NOT emit events onto the invocation bus to report eviction.

#### Scenario: Eviction drops the least recently used idle sandbox

- **GIVEN** `SANDBOX_MAX_COUNT=2` and the cache holds two resolved, idle sandboxes `A` and `B` with `A` less recently used than `B`
- **WHEN** a third distinct `(owner, sha)` triggers a cache miss and a new sandbox `C` is built
- **THEN** the store SHALL delete `A` from the cache
- **AND** SHALL invoke `A.dispose()` fire-and-forget
- **AND** the cache SHALL contain exactly `B` and `C` after the sweep
- **AND** a structured log entry SHALL be emitted with `reason: "lru"`, the evicted owner and sha, plus `ageMs` and `runCount` fields

#### Scenario: Active sandboxes are skipped by the sweeper

- **GIVEN** `SANDBOX_MAX_COUNT=1` and the cache holds one resolved sandbox `A` with `A.isActive === true`
- **WHEN** a second distinct `(owner, sha)` triggers a cache miss and a new sandbox `B` is built
- **THEN** the store SHALL NOT evict `A`
- **AND** the cache SHALL hold both `A` and `B` (size 2, exceeding the soft cap)
- **AND** `A.dispose()` SHALL NOT have been called

#### Scenario: Cache hit promotes the entry to MRU

- **GIVEN** `SANDBOX_MAX_COUNT=2` and the cache holds two resolved, idle sandboxes `A` and `B` with `A` less recently used than `B`
- **WHEN** a caller triggers `sandboxStore.get(…)` for `A`'s `(owner, sha)` key (a cache hit)
- **AND** a subsequent distinct `(owner, sha)` triggers a cache miss causing eviction
- **THEN** the eviction victim SHALL be `B`, not `A`

#### Scenario: Unresolved building entries are skipped by the sweeper

- **GIVEN** a cache miss whose `Promise<Sandbox>` has not yet resolved
- **WHEN** the sweeper iterates cache entries
- **THEN** the unresolved entry SHALL be skipped as not evictable
- **AND** the sweeper SHALL proceed to the next entry without awaiting the unresolved promise

#### Scenario: Shutdown drains pending dispose promises

- **GIVEN** the store has initiated one or more fire-and-forget `sandbox.dispose()` calls from prior evictions that have not yet resolved
- **WHEN** `sandboxStore.dispose()` is called during process shutdown
- **THEN** the returned promise SHALL not settle until every tracked pending dispose promise has settled
