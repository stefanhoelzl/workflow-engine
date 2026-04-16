## Context

The persistence consumer today implements a per-event archive model. For each invocation with `N` events:

```
during invocation:       pending/{id}_{seq}.json  (1 backend.write per event)
on terminal event:       for each seq:
                           backend.read(pending/{id}_{seq}.json)
                           backend.write(archive/{id}/{seq}.json)
                           backend.remove(pending/{id}_{seq}.json)
```

On an FS backend the post-invocation cost is negligible. On S3 it is `3N` HTTP requests per invocation — the read-write-remove loop dominates. As invocations grow in event count, S3 request cost scales linearly.

The event store reads archived events on startup via `scanArchive()` to bootstrap an in-memory DuckDB index. Recovery scans the `pending/` prefix and replays events through the bus, appending a synthetic `trigger.error` (`kind: "engine_crashed"`) so persistence archives the crashed invocation. The main runtime wires these together in this order:

```
1. backend.init()
2. createEventStore({ persistence: { backend } }); await initialized  (bootstrap)
3. createPersistence(backend)
4. createExecutor
5. recover({ backend }, bus)
6. server.start()
```

The existing `persistence/spec.md` describes a `pending/<id>.json` / `archive/<id>.json` scalar-file layout. This does not match the actual code (per-event files). The spec drifted; this change brings it back in line.

## Goals / Non-Goals

**Goals:**
- Reduce S3 request cost at invocation finalization from `3N` to a small constant (target: `~2` S3 calls regardless of event count).
- Preserve the mid-invocation crash trail — pending files are still written per event, so a crash leaves a replayable record.
- Keep `scanArchive()` and `scanPending()` external contracts unchanged (still yield `InvocationEvent`).
- Correct spec drift so `persistence/spec.md` matches the code.

**Non-Goals:**
- Date-prefixed archive keys (`archive/YYYY/MM/{id}.json`). Flat `archive/{id}.json` is fine up to ~tens of thousands of invocations; revisit with partitioning + an index file if LIST cost during bootstrap becomes noticeable.
- Archive retention / cold-storage policy. Archive grows unbounded in this change. Revisit when startup walk time matters.
- Appendable pending (single pending file per invocation, appended per event). S3 has no append primitive; full-rewrite-per-event would make cost worse. Only revisit if we move off S3.
- Parallelism in pending writes. The bus awaits consumers sequentially today; batching would require bus changes. Out of scope.
- Migration of any existing archive files. Local dev re-inits each restart; prod has no invocations in the old format that must be preserved. Old-format files are ignored (not read, not deleted).

## Decisions

### D1: Single archive file per invocation

**Decision:** Write `archive/{id}.json` containing a JSON array of `InvocationEvent`, in seq order, including the terminal event.

**Alternatives considered:**
- Object wrapper `{ id, events }`: allows schema versioning later. Rejected — YAGNI; the array form is symmetric with the existing per-event JSON and the array is self-describing via its elements.
- JSONL (one event per line): streamable parse, appendable in principle. Rejected — we only write the file once at terminal, so streaming parse has no benefit; JSON array is more idiomatic.

**Rationale:** Simplest form that satisfies the goal. `scanArchive` reads one file per invocation and yields each element of the array, preserving the caller contract.

### D2: Keep pending per-event; nest under id directory

**Decision:** Pending layout becomes `pending/{id}/{seq}.json` with `seq` zero-padded to 6 digits on write. Parsers accept any digit width.

**Alternatives considered:**
- Flat `pending/{id}_{seq}.json` (today): fine but `removePrefix` on S3 would need to filter by prefix-pattern rather than a clean directory. Rejected for ergonomics.
- One pending file per invocation, appended: discussed under Non-Goals. Rejected — S3 can't append without rewriting.

**Rationale:** Keeps the per-event crash trail (required for mid-invocation recovery) while making cleanup a single prefix operation. Padding makes S3 `ListObjectsV2` order (UTF-8 binary = lexical) match numerical order and improves human inspection. Correctness does not depend on padding — recovery sorts by `event.seq` numerically after parsing.

### D3: In-memory event accumulator

**Decision:** Persistence maintains `Map<string, InvocationEvent[]>`, pushing each event after its pending write succeeds. On terminal event the archive write serializes the array directly — no re-read of pending files.

**Alternatives considered:**
- Re-read pending files on terminal: preserves today's memory footprint but costs `N` S3 GETs — defeats the optimization.
- Hybrid with fallback: over-engineered for a case that doesn't occur (events are already accumulated via the normal path, and recovery replays through the bus which repopulates the accumulator).

**Rationale:** Events are already in memory transitively (bus consumers, DuckDB rows, logging). Holding them in one more map until terminal is negligible. No memory cap needed for current workloads.

### D4: `removePrefix(prefix)` as the cleanup primitive

**Decision:** Add `removePrefix(prefix: string): Promise<void>` to `StorageBackend`. Semantics: best-effort (logs failures via injected logger, never rejects on partial failure).

- **FS impl:** `fs.rm(path, { recursive: true, force: true })`.
- **S3 impl:** paginated loop — `ListObjectsV2 { Prefix, ContinuationToken }` → `DeleteObjects { Keys }` → follow `NextContinuationToken` until exhausted.

**Alternatives considered:**
- `removeMany(paths: string[])`: saves one LIST on S3 per cleanup (1 DELETE vs 1 LIST + 1 DELETE for N≤1000). Rejected — callers would need to track paths in parallel with the event accumulator; the one-LIST-overhead is worth the caller ergonomics. Both scale as `ceil(N/1000)` DeleteObjects calls, so the extra LIST is constant.
- `exists(path)` + per-key remove: O(N) round-trips per invocation. Rejected.

**Rationale:** Prefix removal matches the nested pending layout cleanly. The invariant required is weak and already holds: **no concurrent writers to a pending prefix during `removePrefix`.** Only the owning persistence consumer writes under `pending/{id}/`, and it stops writing (the terminal event was the last one) before calling `removePrefix`.

### D5: Archive-authoritative recovery rule

**Decision:** At recovery time, for each pending id found via `scanPending()`:

```
alreadyArchived = eventStore has any event for id
if alreadyArchived:
  backend.removePrefix(`pending/${id}/`)   // stale leftovers from crash during cleanup
  continue
// else normal path:
replay events through bus
emit synthetic trigger.error
// persistence consumer handles archive write + removePrefix naturally
```

**Alternatives considered:**
- Idempotent re-archive (always replay, let archive write overwrite): **incorrect.** If crash happened *during* pending cleanup, some pending files were already deleted. Replaying only the leftover subset would rewrite `archive/{id}.json` with fewer events + a synthetic terminal error, destroying the complete archive that exists on disk. The archive-existence check is necessary for correctness.
- Merge-archive-on-write (read existing archive, union with replayed events): works but adds read-merge-write + extra S3 round-trips on every archive write. Rejected as overkill for a recovery edge case.
- Per-id `exists(path)` probe: N HEADs on S3. Rejected in favor of querying the event store, which is already populated.

**Rationale:** Uses the `eventStore` (populated from archive bootstrap that runs before recovery) as the source of truth. If the store has any event for an id, the archive is authoritative and complete — the pending files are stale leftovers. Partial overlap (some pending seqs present in store, others not) is impossible because the archive is written exactly once, on terminal, with the full event list.

This requires `recover` to accept `eventStore` as a dep. Alternative narrower deps (e.g., an `isArchived(id)` function) were considered but rejected — recovery may later need seq-range information from the store, and constructing an `EventStore` in tests is already zero-cost (in-memory DuckDB, no side effects).

### D6: Defensive accumulator clearing

**Decision:** In `archiveInvocation`, clear the in-memory accumulator entry *before* calling `removePrefix`, not after:

```
await backend.write(archivePath(id), JSON.stringify(events))
pendingEvents.delete(id)           // ← defensive: archive is now durable
await backend.removePrefix(pendingPrefix(id))    // best-effort
```

**Alternatives considered:** Clear after `removePrefix` succeeds. Rejected — if `removePrefix` throws, the accumulator entry leaks until process restart, breaking the invariant that `pendingEvents[id]` exists ⟺ `pending/{id}/` has files. Both orderings produce correct archives; the defensive ordering preserves the invariant strictly.

**Rationale:** Archive write is the point of durability. Once it succeeds, the in-memory copy has no further purpose. Pending cleanup is best-effort; recovery cleans up any leftovers on next startup.

### Cross-component flow

```
Happy path:
  bus.emit(e)                                   (non-terminal)
   └─▶ persistence.handle(e)
        ├─▶ backend.write(pendingPath(id, seq))
        └─▶ pendingEvents[id].push(e)

  bus.emit(terminal)
   └─▶ persistence.handle(terminal)
        ├─▶ backend.write(pendingPath(id, seq))
        ├─▶ pendingEvents[id].push(terminal)
        └─▶ archiveInvocation(id)
             ├─▶ backend.write(archivePath(id), JSON.stringify(events))
             ├─▶ pendingEvents.delete(id)
             └─▶ backend.removePrefix(pendingPrefix(id))   (best-effort)

Startup:
  backend.init()
  eventStore ← createEventStore({ persistence: { backend } })
    └─▶ scanArchive() → DuckDB populated with all archived events
  await eventStore.initialized
  persistence ← createPersistence(backend)
  recover({ backend, eventStore }, bus)
    ├─▶ scanPending() → group by id
    ├─▶ for each (id, events):
    │    ├─▶ eventStore.has(id)?
    │    │    yes → backend.removePrefix(pendingPrefix(id))  (no bus emit)
    │    │    no  → for each ev: bus.emit(ev); bus.emit(synthetic trigger.error)
    └─▶ done
  server.start()
```

### Case analysis on recovery

| State on disk (per id)      | Meaning                                  | Recovery action                                        |
|-----------------------------|------------------------------------------|--------------------------------------------------------|
| pending/{id}/… only         | Crash mid-invocation                     | Replay via bus + synthetic terminal (persistence writes archive + removePrefix) |
| pending/{id}/… + archive/{id}.json | Crash during removePrefix         | eventStore has id → `removePrefix` only, no replay     |
| archive/{id}.json only      | Clean state                              | Nothing to do                                          |

Partial overlap (some pending seqs in store, others not) is impossible by construction: archive is written exactly once on terminal, containing all events.

## Risks / Trade-offs

- **[S3 LIST cost per invocation]** → `removePrefix` adds one `ListObjectsV2` per archived invocation (previously implicit in the per-key delete loop). Net cost is still 2 S3 calls vs today's 3N — mitigated by the win. If this becomes material, switch to `removeMany(knownPaths)` later and track paths alongside events in the accumulator.
- **[Accumulator memory pressure for huge invocations]** → Unbounded event lists per id. Mitigated by the fact that events are already in memory transitively; no real workload today comes close to exhausting memory. If this ever bites, add a soft cap with spill-to-disk fallback in a later change.
- **[Archive write failure leaves accumulator and pending intact]** → On next startup, `scanPending` finds the files, the event store has no events for that id (archive wasn't written), recovery takes the normal replay path and the invocation ends as `engine_crashed`. Correct outcome.
- **[Partial `removePrefix` failure leaves stale pending]** → Archive-authoritative rule handles this on next startup. No data loss, no duplicate emission.
- **[`recovery` now coupled to `EventStore`]** → Tight coupling but honest: recovery genuinely needs to know what's archived, and the event store is the authoritative answer post-bootstrap. Mitigation: construct a real `EventStore` (zero-cost, in-memory) in tests rather than mocking the type.

## Migration Plan

No migration needed. Old-format files (`pending/{id}_{seq}.json`, `archive/{id}/{seq}.json`) are ignored: the new parsers don't match the old path shapes. Local dev wipes its persistence dir each restart in practice; prod has no invocations in flight whose state must be preserved.

Rollback: revert the commit. Any `archive/{id}.json` files written under the new format will be unreadable by the old code (since it expects `archive/{id}/{seq}.json`), so rollback after production use would strand archived invocations until re-deployed. Acceptable: the event store bootstrap would simply fail to read them and continue; logging records the failure.

## Open Questions

None — the design was resolved in the explore session preceding this proposal.
