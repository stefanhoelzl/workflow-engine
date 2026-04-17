## Context

`InvocationEvent.ts` is today a single `number` produced by `Date.now()` at each of three emission sites in the sandbox package. The event store persists it as a `TIMESTAMPTZ`, and the dashboard subtracts two such values to display a duration. This layering works but collapses two separable concerns — "when in the real world did this happen" and "how long did the run take" — onto one field with whole-millisecond precision.

The sandbox already maintains a per-run monotonic anchor (`wasiState.anchorNs`, reset at worker init and on every `handleRun`) to implement WASI's `CLOCK_MONOTONIC` for guest code via `clock_time_get`. Guest-observable `performance.now()` works off this anchor and tests confirm it starts near zero and resets per run. The refactor's core insight: reuse that same anchor for event timestamps, so every `InvocationEvent` carries a monotonic reading in addition to its wall-clock time.

Consumers touching `event.ts` today:
- `bridge-factory.ts:buildEvent` (system.* events)
- `worker.ts:installEmitEvent` (action.* events) and `worker.ts:emitTriggerEvent` (trigger.* events)
- `recovery.ts` (synthetic `trigger.error` for crashed invocations, `ts: Date.now()`)
- `event-bus/event-store.ts:eventToRow` (converts numeric `ts` to ISO via `new Date(event.ts).toISOString()`)
- `event-bus/logging-consumer.ts:baseFields` (same ISO conversion for log output)
- `ui/dashboard/middleware.ts` (reads `r.ts`/`t.ts` as startedAt/completedAt)
- `ui/dashboard/page.ts:formatDuration` (subtracts two parsed ISO strings)

Test fixtures across `packages/core`, `packages/runtime`, and `packages/sandbox` use `ts: <number>` with arbitrary values (1, 2, 3 or `Date.parse("...")`); these need a uniform migration.

## Goals / Non-Goals

**Goals:**
- Give every event two orthogonal time axes: `at` (ISO wall-clock, every event) and `ts` (integer µs since the run's anchor, every event).
- Preserve sub-millisecond precision in duration measurements inside the dashboard.
- Keep the event-store queryable in the existing style (`ORDER BY at DESC` replaces `ORDER BY ts DESC`); avoid new abstractions.
- Keep event emission cheap: no VM round-trip per event.
- Eliminate the duplicated monotonic-clock state between `wasiState.anchorNs` and (implicit) event-side wall-clock.

**Non-Goals:**
- Migrating existing persisted data. Dev-only system; `pending/`, `archive/`, and the in-memory DuckDB index are wiped on upgrade.
- Introducing Zod validation for `InvocationEvent`. It remains a TypeScript interface.
- Changing the public workflow SDK, manifest schema, or webhook contract.
- Exposing a new sandbox API surface. The anchor is an internal concern of `@workflow-engine/sandbox`; guests continue to see `performance.now()` unchanged.
- Supporting duration histograms, flame graphs, or any new UI beyond the existing invocation list.

## Decisions

### Decision: Split `ts` into two fields — `at` (wall-clock) and `ts` (monotonic)

Rename the current wall-clock field to `at: string` (ISO 8601 with milliseconds, produced by `new Date().toISOString()`). Introduce `ts: number` with new semantics: integer microseconds since the current run's anchor.

**Alternatives considered:**
- Keep one field, promote it to float ms. Rejected: conflates the two concerns (sub-ms precision is useless for ordering across invocations; ISO wall-clock is useless for fine-grained duration math). Also breaks the contract readers have built up: "bigger ts = later in time."
- Add a third field (`durationUs` on terminal events). Rejected: moves derivation out of the consumers that need it. Requires terminal events to look backwards at the request event. Brittle.

**Why `at`, not `date` or `startedAt`:** `date` suggests either a JS `Date` object or a calendar day; `startedAt` is wrong for mid-run events (they haven't started, they're in-flight). `at` pairs cleanly with `ts` ("at wall, ts mono") and reads short at call sites.

**Why integer µs, not float ms:** user preference; quantization at 1 µs still captures everything `performance.now()` can observe on Node (underlying `process.hrtime` is ns but OS grain is ~1 µs on Linux). `Math.round((performance.now() − anchor) × 1000)` is a cheap conversion, and `BIGINT` in DuckDB is a tidy column type.

### Decision: Single anchor on the bridge

The bridge owns the run anchor. Add `bridge.resetAnchor()` and `bridge.tsUs()`; expose `bridge.anchorNs()` so WASI's `clock_time_get(MONOTONIC)` can do its BigInt math without converting from µs.

```
┌─────────────────────────────────────────────────────────────────┐
│                  BRIDGE-OWNED RUN ANCHOR                        │
└─────────────────────────────────────────────────────────────────┘

  worker init          ── bridge.resetAnchor()  (captures perfNowNs)
                            │
                            ▼
  handleRun            ── bridge.resetAnchor()  (per-run reset)
                            │
               ┌────────────┼────────────┬──────────────┐
               ▼            ▼            ▼              ▼
         installEmit    emitTrigger   buildEvent    wasiClock
         Event          Event         (bridge)      _time_get
         (worker.ts)    (worker.ts)                 (wasi.ts)
               │            │            │              │
               ▼            ▼            ▼              ▼
           bridge.tsUs()  bridge.tsUs()  bridge.tsUs()  bridge.anchorNs()
                                                        (BigInt math)

  Result: one source of truth. Two writes (init + handleRun) instead
  of four (init + handleRun × two state locations).
```

**Alternatives considered:**
- Keep `wasiState.anchorNs`, export a reader helper that bridge imports. Rejected: state lives in `worker.ts` while `bridge-factory.ts` reaches across a module boundary every event. Two writes, two readers, easy to drift.
- Per-emission-site anchors. Rejected: each site does its own `perfNowNs()` at reset, all claiming "start of run" — they will drift by the overhead between resets, and the WASI clock will not match what events report.

**Why the bridge:** the bridge is already the object shared by all three emission sites and is already reachable from `wasi.ts` (`wasiState.bridge` is set in worker init). It has the right lifetime (one per sandbox worker) and already tracks the run context.

### Decision: Recovery copies the last replayed event's `ts`

Recovery's synthetic `trigger.error` is the only event emitted outside a sandbox run. It has no bridge, no anchor, no "µs since run start" to report honestly.

Choice: `ts = events.at(-1)?.ts ?? 0`, `at = new Date().toISOString()`.

Interpretation: for a crashed run, `terminal.ts − request.ts` reads as "how far the run got before we lost contact," which is the most informative thing we can surface. Not strictly the execution time, but a useful lower bound with clear semantics.

**Alternatives considered:**
- `ts: null` (make the field optional). Rejected: forces every consumer — event store schema, dashboard duration math, JSON serialization — to branch on a nullable field for one edge case.
- `ts: 0`. Rejected: indistinguishable from "finished instantly." Bad UX.
- Compute from wall-clock delta between the replayed first event's `at` and now, converted to µs. Rejected: fabricates precision we don't have, and makes a recovered run's displayed duration include engine downtime, which isn't meaningful.

### Decision: DuckDB schema swaps one column for two

Current: `ts TIMESTAMPTZ` (populated from `new Date(event.ts).toISOString()`).
New: `at TIMESTAMPTZ` (populated from `event.at` directly — no conversion) and `ts BIGINT` (populated from `event.ts`, µs as integer).

Dashboard ordering: `ORDER BY at DESC, id DESC`. The `id` tiebreak is deterministic (invocation ids are unique); `seq` wouldn't help because the dashboard's selection projects only the `trigger.request` rows (all seq 0).

Dashboard duration: `(terminal.ts − request.ts)` read as BIGINT µs, then formatted with a smart-unit function.

Duration format: `<1 000 µs → "N µs"` (integer µs, no decimal), `<1 000 000 µs → "N.N ms"` (one decimal), `<60 000 000 µs → "N.N s"` (one decimal), else `"N.N min"` (one decimal). Smart unit surfaces sub-ms precision only when it's informative.

### Decision: Test-fixture migration via a shared `makeEvent` helper

Rather than edit every `ts: 1` / `ts: Date.parse("...")` fixture across 10+ test files, introduce a `makeEvent(overrides)` helper in the core test utilities. Defaults:
- `at: "2026-04-16T10:00:00.000Z"` (fixed ISO)
- `ts: 0` (request-like baseline; terminal-side tests pass explicit `ts: 1000`, `ts: 2000` etc.)

Tests override only the fields they care about. Adding any future timestamp-adjacent field requires editing only the helper.

## Risks / Trade-offs

- **Risk**: A consumer out of scope still reads `event.ts` as wall-clock (e.g., a downstream service consuming archive files). **Mitigation**: In-tree consumers are enumerated in the proposal's Impact section; grep for `event.ts` / `.ts *:` confirms coverage. No external archive consumers exist (dev-only deployment).
- **Risk**: Recovery's "last ts" convention is subtle; a reader may assume terminal `ts` always reflects real execution time. **Mitigation**: Capture the convention in the recovery spec as an explicit requirement ("recovery's synthetic event's `ts` mirrors the last recorded event's `ts`") with an accompanying scenario. Call it out in `design.md` (this file).
- **Risk**: The anchor moving to the bridge creates a small coupling (`wasi.ts` now reads `bridge.anchorNs()`; the bridge object is already reachable via `wasiState.bridge`). **Mitigation**: This replaces an equivalent coupling (wasi.ts already writes into `wasiState.anchorNs` from outside). The new shape is simpler — one direction of data flow instead of two.
- **Risk**: Smart-unit duration format complicates rendering tests. **Mitigation**: Unit-test the formatter in isolation; middleware/page tests supply known µs values and assert formatted strings at a few boundaries.
- **Trade-off**: Recovery's synthetic `ts` is a white lie (not "since run start" — the run is gone). Accepting it keeps the contract "ts is always a number" and the schema non-nullable. Documented.
- **Trade-off**: No migration for persisted data. Upgrade is destructive. Acceptable for a dev-only system; flagged in tasks.

## Migration Plan

1. **Ship all code changes in one PR.** The change touches two packages (sandbox, runtime) plus core's shared type — there is no intermediate state where the shape is coherent.
2. **On deploy / local upgrade:** operator wipes `pending/` and `archive/` prefixes under the storage backend and restarts the runtime. Dashboards bootstrap empty from the now-empty archive. Tasks document the wipe step.
3. **No rollback script** — revert the PR; running it against the already-wiped data works.

## Open Questions

None blocking. Closed during explore-mode discussion: field naming (`at`), integer unit (µs), anchor location (bridge), recovery `ts` semantics (copy last), tiebreak (`id`), ordering column (`at`), duration format (smart unit).
