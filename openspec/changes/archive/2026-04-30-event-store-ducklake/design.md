## Context

The runtime currently has three bus consumers fanning out from each `bus.emit(event)`:

1. **`persistence`** (strict) — writes `pending/{id}/{seq}.json` per event, then on terminal flushes `archive/{id}.json` (a JSON array of all events for that invocation) and removes the pending prefix. Strict consumer: a thrown rejection is runtime-fatal.
2. **`event-store`** (best-effort) — in-memory DuckDB indexed by `(id, seq)` plus `(owner, repo)`. At boot, runs `scanArchive()` which reads every `archive/*.json` file and bulk-inserts. Powers the dashboard via Kysely.
3. **`logging-consumer`** (best-effort) — emits one `invocation.started` / `.completed` / `.failed` log line per terminal kind.

`recovery.ts` runs once at boot, after the EventStore archive bootstrap, and reconciles orphan `pending/` files: events whose ids are already archived are dropped (archive-cleanup); events without an archive are replayed through the bus and a synthetic `trigger.error{kind: "engine_crashed"}` is emitted to close them out.

This shape works correctly but does not scale. Cold start cost is `O(N archived invocations × per-file backend latency)` because `scanArchive` reads each JSON in turn. In-memory DuckDB holds the full history; RAM grows linearly with traffic since the start of time. On S3 the per-file GET latency dominates (~30 ms p50 prod), so a million archived invocations is roughly an 8-hour bootstrap. Two unrelated parts of the codebase (`event-bus`, `recovery`) exist almost entirely to coordinate two consumers and to reconcile crash residues from the per-event WAL — neither earns its keep once the storage shape changes.

## Goals / Non-Goals

**Goals:**

- Replace the linear-in-N archive bootstrap with constant-time cold start, so RAM scales with the *query working set* not the *full history*.
- Keep full event history queryable indefinitely with the same Kysely surface (`EventStore.query(scopes)`) the dashboard consumes today.
- Use battle-tested infrastructure for the durable archive: DuckLake v1.0 (catalog DB + Parquet on S3), not custom file layouts.
- Eliminate scaffolding that no longer pays for itself: the bus abstraction (one consumer left), the recovery scan path (no per-event WAL), the `logging-consumer` consumer (the executor already discriminates on `event.kind`).
- Trim `StorageBackend` to its actual remaining callers and surface a typed locator so EventStore can configure DuckLake without re-parsing config envs.
- Make the single-writer assumption explicit and load-bearing in the K8s manifest, not implicit and hopeful.

**Non-Goals:**

- Multi-writer correctness or HA. The runtime is single-writer by deployment contract; if HA is ever wanted, switching the DuckLake catalog to Postgres unlocks it natively.
- Per-event durability for in-flight invocations. SIGKILL during an invocation now loses it. This is a deliberate regression in exchange for the per-event-S3-PUT we no longer pay.
- Live-progress dashboard view. Invocations are short-lived and only appear after they terminate.
- Time-travel queries. Snapshots expire on every `CHECKPOINT`.
- Defence against zombie pods, force-deletes, or operator-mistake `replicas: 2` via runtime fencing. S2 and UpCloud Object Storage do not implement `If-Match` conditional PUT; the K8s `Recreate` strategy is the only fence and is documented as load-bearing.

## Decisions

### Adopt DuckLake v1.0 as the archive format

DuckLake separates a small SQL catalog (DuckDB file in our case) from immutable Parquet data files in S3. A write transaction stages rows (≤ 10 inline in the catalog, larger writes spill to a fresh Parquet file via S3 multipart PUT), then atomically commits a snapshot row in the catalog. Readers see snapshot-isolated views; concurrent writers serialize via the catalog DB. Compaction (`CHECKPOINT`) merges small Parquets and flushes inlined rows.

Layout (DuckLake nests data under `<DATA_PATH>/<schema>/<table>/`; `main` is the default schema, `events` is the table name):

```
S3 backend (PERSISTENCE_S3_BUCKET=…):
  s3://<bucket>/events.duckdb                          catalog
  s3://<bucket>/events/                                DATA_PATH
    main/events/owner=<owner>/repo=<repo>/ducklake-<uuid>.parquet

FS backend (PERSISTENCE_PATH=…):
  <root>/events.duckdb
  <root>/events/main/events/owner=…/repo=…/...parquet
```

The events table is created **without** a `PRIMARY KEY` or `UNIQUE` constraint — DuckLake does not support either. Idempotency is enforced at the application layer by the accumulator-evict-on-success pattern: each terminal commit is one DuckLake transaction, the accumulator entry is dropped only after the commit Promise resolves, and retries occur only when the commit Promise *rejects*. The narrow window where this could double-write is "DuckLake committed but the client failed to receive the success response and retried" — accepted as a rare ambiguous case, not a hot-path concern.

Catalog at top-level next to its data tree; the names share the `events` prefix; `LIST events/` for partition scans never has to filter past the catalog file.

`PARTITION BY (owner, repo)` matches the dominant query predicate. The `EventStore.query` allow-list mechanism (`auth/scopes.ts`) already enforces `(owner, repo)` scoping; partition pruning reduces typical query scans to one repo's files. Cross-`(owner, repo)` admin queries scan all partitions but DuckDB prunes them efficiently via Parquet stats.

**Alternatives considered:**

- *DuckDB `.duckdb` file on S3 read-write*: not feasible. S3 has no partial-byte-write API; DuckDB's storage format requires it. `ATTACH 's3://…/db.duckdb'` works READ_ONLY only ([duckdb#10967](https://github.com/duckdb/duckdb/issues/10967)).
- *Roll a custom Parquet + manifest scheme*: same shape as DuckLake but home-grown. We would re-implement atomic manifest updates, compaction, snapshot semantics, and bootstrap. Months of work to match v1.0 correctness; rejected.
- *Iceberg via DuckDB*: DuckDB has read support for Iceberg; write support is still maturing. Sensible only if we needed interop with non-DuckDB engines, which we do not.

### DuckLake catalog as a DuckDB file round-tripped through the storage backend

The catalog is a single DuckDB file. EventStore opens a local working copy under the runtime's persistence root. On each commit (terminal event) the runtime mutates the catalog locally (which writes the snapshot row + any inlined rows + any new Parquet file pointers), then PUTs the catalog file back to S3 (or syncs it locally for the FS backend). Cold start: GET catalog → ATTACH → ready.

**Alternatives considered:**

- *Postgres catalog*: enables DuckLake's native multi-writer story (Postgres serializability rejects conflicting commits with "failed to serialize" → caller retries). Adds a managed Postgres dependency the project does not currently have. Rejected for now; flagged as the natural HA path.
- *SQLite catalog*: marginally smaller; adds a SQLite dependency for no real win over DuckDB-file. Rejected.

### Single `EventStore` consumer; delete `event-bus`, `persistence`, `recovery`, `logging-consumer`

With DuckLake as the durable archive, the strict-vs-best-effort tier disappears: there is one storage layer, owned by one consumer. The bus's fatal-exit-on-strict-throw machinery has nothing to coordinate. The `recovery.ts` scan path has no `pending/` files to reconcile because in-flight events live in RAM, not on disk. The `logging-consumer` shape (best-effort, swallow errors) is two operations (`info` on `trigger.request`/`response`, `error` on `trigger.error`) that the executor's `onEvent` widener — which already discriminates on `event.kind` to stamp dispatch metadata — can do inline.

The result is one consumer, one call site:

```
sandbox plugins/trigger.ts ──▶ executor onEvent (widen + log lifecycle)
                                     │
                                     ▼
                               eventStore.record(event)
                                     │
                                     ├─ accumulate in Map<id, Event[]>
                                     └─ on terminal → DuckLake transaction
```

`EventStore.record` is the new `handle` (renamed because the bus-consumer vocabulary is gone).

**Alternatives considered:**

- *Keep an in-memory hot-tail DuckDB for live-progress dashboard view*: rejected at design time. Invocations are short-lived; the live-view UX gain is small relative to the complexity of unioning two query surfaces. Cold start would also have to reconstruct the live tail from somewhere, undoing the simplification.
- *Keep the bus abstraction as ~10 lines of fan-out for future extensibility*: rejected per the project's "no premature abstractions" stance. Future observability hooks (metrics, OTel) have different shapes (counters, spans) than `BusConsumer.handle(event)` and would not consume the bus interface anyway.

### Terminal-only durability; SIGKILL loses in-flight; SIGTERM drains

Per-event durability via `pending/{id}/{seq}.json` already paid one S3 PUT per event. Removing that WAL halves write amplification and removes the orphan-pending reconciliation that gave `recovery.ts` its only job. The cost is that an unclean process death (SIGKILL, OOM, force-delete) loses any invocations that hadn't yet hit `trigger.response` or `trigger.error`. Since this runtime's invocations are short-lived (HTTP per-request, IMAP per-mail, cron per-fire, manual per-trigger), the in-flight loss window is small.

SIGTERM remains graceful: stop accepting new triggers, drain in-flight executors, synthesise `trigger.error { reason: "shutdown" }` for any invocation that doesn't naturally complete in time, commit each. Bounded by `terminationGracePeriodSeconds`.

### Commit-per-terminal with bounded retry-then-drop

On each terminal event the EventStore runs a single DuckLake transaction (`INSERT INTO events VALUES …` for the whole accumulated event list, then a catalog-file commit, then PUT catalog back to S3). On transient failure (network, 5xx) it retries with exponential backoff (default 5 attempts, ~30 s total). On exhaustion it logs `event-store.commit-dropped { id, owner, repo, attempts, error }`, evicts the invocation from RAM, and continues. The runtime survives sustained S3 outages without exiting; the trade-off is silent loss of completed-but-uncommitted invocations during the outage window — surfaced in `SECURITY.md` and `docs/upgrades.md`.

**Alternatives considered:**

- *Spill failed commits to `orphans/{id}.json` and reconcile next boot*: re-introduces a small WAL that we just removed. The user explicitly preferred retry-then-drop over orphan reconciliation.
- *Strict-consumer style fatal-exit on commit failure*: every transient S3 hiccup would crash the runtime. Worse availability than retry-then-drop.

### Background `CHECKPOINT` driven by timer + size thresholds

DuckLake accumulates inlined catalog rows (cheap to write, but they grow the catalog file that gets PUT on every commit) and small Parquet files (one per terminal commit, in the worst case). Without compaction, catalog size and S3 file count grow linearly. `CHECKPOINT` flushes inlines into Parquet, merges small files, applies deletion vectors, and updates the catalog. Snapshots expire on every checkpoint (no time-travel retention) so the merged-away files become reclaimable.

Triggers (logical OR):

- `EVENT_STORE_CHECKPOINT_INTERVAL_MS` elapsed since last run (default 1 h)
- inlined-row count over `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS` (default 100 000)
- catalog file size over `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES` (default 10 MiB)

Runs in the same DuckDB connection on the writer, off the commit hot path, skips when there is no work.

**Alternatives considered:**

- *Separate Kubernetes CronJob*: would need its own writer fence vs the runtime; with single-writer-by-deployment that is tricky. Keeping CHECKPOINT inside the writer is simpler.
- *On-every-Nth-commit*: predictable load proportional to traffic but adds latency to occasional commits. Background timer + thresholds gives the same behaviour with smoother latency.

### `Recreate` deployment strategy is the only writer fence

S2 (local development) and UpCloud Object Storage (production) do not advertise support for the AWS S3 `If-Match` conditional-PUT semantics that DuckLake's natural concurrency control would otherwise depend on (DuckLake itself relies on the catalog database's transaction system, which assumes a *shared* DB for concurrency — our DuckDB-file-via-S3 model has no shared transaction system). The runtime therefore commits the catalog with an unconditional PUT.

To prevent split-brain, the K8s manifest is locked down:

```
replicas: 1
strategy: { type: Recreate }
terminationGracePeriodSeconds: 90
# no HPA, no PDB tolerating > 1 replica
```

`Recreate` tears down Pod-old completely before scheduling Pod-new — there is no temporal overlap. `terminationGracePeriodSeconds: 90` covers the SIGTERM drain plus a margin for the catalog PUTs that flush in-flight invocations. The single-writer property is therefore a *deployment contract*: violating it (e.g. `replicas: 2`) silently corrupts the catalog. This is documented in `SECURITY.md` and `docs/upgrades.md`.

**Alternatives considered:**

- *ETag fence (If-Match conditional PUT)*: rejected because S2 ignores `If-Match` (verified in `mojatter/s2` source) and UpCloud's docs do not list conditional writes among supported features. A fence that only works in some environments is worse than no fence + clear documentation.
- *Custom S3-object lease*: re-invents Chubby. TTL-based locks without a CAS primitive are not safe; rejected as false safety.
- *StatefulSet with stable identity*: equivalent to `Recreate` for our purposes (no PVC needed; the storage backend already lives in S3 / FS). `Recreate` on a Deployment is the lighter-weight expression of the same intent.

### `StorageBackend` shrinks; adds `locator()`

After the deletions, `StorageBackend` callers reduce to `workflow-registry.ts` (tarball write/read/list) and `EventStore` (which talks to DuckLake directly, not through the K/V interface). The remaining methods are:

```ts
interface StorageBackend {
  init(): Promise<void>;
  write(path: string, data: Uint8Array): Promise<void>;       // was writeBytes
  read(path: string): Promise<Uint8Array>;                     // was readBytes
  list(prefix: string): AsyncIterable<string>;
  locator(): StorageLocator;
}

type StorageLocator =
  | { kind: "fs"; root: string }
  | { kind: "s3"; bucket: string; endpoint: string; region: string;
      accessKeyId: Secret; secretAccessKey: Secret;
      urlStyle: "path" | "virtual"; useSsl: boolean };
```

`locator()` is the "what kind of backend am I, and how do you talk directly to me?" accessor. EventStore uses it to compose the DuckLake `ATTACH 'ducklake:…'` and `CREATE SECRET (TYPE S3, …)` SQL. `Secret` carries through; `.reveal()` is called only at the SQL composition site, matching the existing boundary discipline.

The string-variant `read`/`write` and the unused `remove`, `removePrefix`, `move` methods are dropped. Their only callers were the deleted persistence consumer, the deleted recovery scan, the deleted health sentinel, and `scripts/prune-legacy-storage.ts` (also deleted). The byte-variant methods take the names `read` / `write`.

**Alternatives considered:**

- *EventStore reads config envs directly*: works but duplicates the FS-vs-S3 branch. Two consumers reading the same envs is no worse than one in principle, but it scatters the "how is the backend configured?" answer.
- *Pass `{ catalogPath, dataPath, s3Secret }` to EventStore from `main.ts`*: pushes the FS-vs-S3 branch into wiring. Same logic, less cohesive home.

### Executor owns lifecycle log emission

The executor's `onEvent` widener already branches on `event.kind === "trigger.request"` to stamp dispatch metadata. Adding the same kind-discriminated log emission at the same site is symmetric and keeps EventStore narrowly about durable storage and queries. Result is two clean log streams:

```
Application lifecycle log  (executor)
  invocation.started      on trigger.request
  invocation.completed    on trigger.response
  invocation.failed       on trigger.error

Archive health log         (EventStore)
  event-store.commit-ok        each successful catalog round-trip
  event-store.commit-retry     each retry attempt
  event-store.commit-dropped   retries exhausted
  event-store.checkpoint-run   each compaction
  event-store.checkpoint-skip  no work
```

A user grepping "did my workflow run?" hits the lifecycle stream; an operator investigating "is the archive healthy?" hits the EventStore stream. The logging is best-effort: a logger error must not propagate past the log call.

## Risks / Trade-offs

- **Silent loss of completed-but-uncommitted invocations during sustained storage outages** → bounded retry (5 attempts, ~30 s) plus explicit `event-store.commit-dropped` log line; documented in `SECURITY.md` and `docs/upgrades.md` so operators know the failure mode is real and observable.
- **SIGKILL/OOM during an invocation loses it entirely** → accepted regression vs the per-event WAL. Mitigated by the fact that invocations in this system are short-lived; SIGTERM remains graceful and the dominant shutdown path.
- **Single-writer is a deployment contract, not a runtime guarantee** → the manifest enforces it (`replicas: 1`, `Recreate`), the spec calls it out as load-bearing, and `SECURITY.md` documents the consequence of override (silent catalog corruption). Future HA requires switching the DuckLake catalog to Postgres.
- **DuckLake v1.0 is two weeks old at proposal time (released 2026-04-13)** → the spec is now backward-compatibility-guaranteed. Reference implementation is in DuckDB v1.5.2+. Risk is implementation bugs at edge conditions; mitigation is bucket versioning on the prod S3 bucket so a corrupted catalog can be rolled back.
- **Catalog PUT latency bounds throughput** → ~28 commits/sec at p50 prod S3 latency, ~5/sec at p99. Sufficient for the workload class this runtime targets (cron + webhooks + manual triggers, single-tenant per deploy). If profiling later shows saturation, batched commits within a short window are an additive enhancement; the spec leaves the door open.
- **Brief 60–90 s deploy gap** → already present today (single replica). Webhook senders that retry on 5xx (GitHub, Stripe) absorb it transparently. Cron firings that overlap the gap are missed — same behaviour as today.
- **DuckLake extension load adds startup cost** → measured in tens of ms; well under the cold-start budget freed by skipping the archive scan.
- **Test coverage for SIGKILL is intentionally not added** → user explicitly chose not to codify the regression as a spec; the absence of `pending/` recovery code is a stronger guarantee than a test asserting the absence of behaviour.

## Migration Plan

1. **Pre-deploy** (operator, per environment):
   - Enable bucket versioning on the persistence bucket (S3 / UpCloud Object Storage). This is cheap and provides catalog rollback if DuckLake misbehaves.
   - Drain any in-flight invocations against the old runtime.
   - Wipe legacy archive artefacts: `rm -rf <root>/{archive,pending}` for FS, or `aws s3 rm s3://<bucket>/{archive,pending}/ --recursive` for S3.
2. **Deploy** the new runtime image.
3. **Verify** via dev probes (catalog round-trip, manual trigger appears in dashboard after terminal). Cold-start time should be sub-second irrespective of historical traffic.
4. **Rollback** (if needed): redeploy the prior image. The new code does not write to `archive/` or `pending/`, so a rollback to the old code finds an empty archive on disk and starts fresh — no historical data, but no corruption either. If catalog corruption is detected, restore the catalog from bucket versioning.

The cutover is *hard*: there is no compatibility path between the old per-invocation-JSON archive and the new DuckLake archive. Historical data from before the deploy is not migrated; the operator accepts this loss as part of the upgrade. This matches the project's existing precedent (see `docs/upgrades.md` for the prior `(owner, repo)` split that wiped storage similarly).

## Open Questions

- **UpCloud Object Storage `CreateSecret` URL_STYLE behaviour**: production deploy needs a smoke test to confirm DuckLake's S3 client (within the DuckDB extension) talks to UpCloud correctly. Likely needs `URL_STYLE 'path'` and a custom `ENDPOINT`; both supported by the extension. Verify before locking the production manifest.
- **DuckLake `CHECKPOINT` cost at large catalog sizes**: defaults are conservative (1 h timer, 10 MiB catalog threshold). After deploy, `event-store.checkpoint-run` log line includes durations and sizes — tune the env vars based on observed traffic.
- **Concurrent reads during CHECKPOINT**: DuckLake's snapshot-isolation contract says queries see the pre-checkpoint snapshot until the new one commits. Verify dashboard query latency is unaffected during a CHECKPOINT under realistic load.
