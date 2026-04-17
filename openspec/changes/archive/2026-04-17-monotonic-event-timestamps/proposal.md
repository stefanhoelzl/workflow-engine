## Why

`InvocationEvent.ts` is currently `Date.now()` — whole-millisecond wall-clock time. That is too coarse to measure sandbox execution accurately (many actions complete in under a millisecond, so `terminal.ts − request.ts` reads as `0`), and wall-clock readings are vulnerable to NTP jumps and leap smears. The event store and dashboard conflate two distinct concerns into one field: "when in real time did this happen" and "how long did the sandbox spend on it."

Splitting those concerns unblocks accurate per-invocation profiling (duration, per-action latency) without losing the ability to list invocations by real-world time.

## What Changes

- **BREAKING** `InvocationEvent.ts` is redefined from "milliseconds since Unix epoch (`Date.now()`)" to "integer microseconds since the most recent `sandbox.run()` anchor (from `performance.now()`)." Values reset to ≈ 0 at the start of each run and are monotonic within a run. Meaningful only within the invocation; not orderable across invocations.
- **BREAKING** `InvocationEvent.at` is added — an ISO 8601 wall-clock timestamp string with millisecond precision (`new Date().toISOString()`). Every event carries one.
- The sandbox bridge owns a single run anchor. `bridge.resetAnchor()` fires at worker init and at every `handleRun`. `bridge.tsUs()` returns `Math.round((performance.now() − anchor) × 1000)` as an integer. `wasiState.anchorNs` is removed; WASI's monotonic clock reads the bridge's anchor.
- All three event-emission sites (`worker.installEmitEvent`, `worker.emitTriggerEvent`, `bridge.buildEvent`) write `at = new Date().toISOString()` and `ts = bridge.tsUs()`.
- The event-store DuckDB schema changes: `ts TIMESTAMPTZ` is replaced by two columns — `at TIMESTAMPTZ` (from `event.at`) and `ts BIGINT` (µs from `event.ts`). Dashboard ordering switches to `ORDER BY at DESC, id DESC`.
- The dashboard's invocation list renders "started" from `at`, computes duration from `terminal.ts − request.ts` (monotonic µs), and formats it with a smart unit (`<1 ms → "N µs"`, `<1 s → "N.N ms"`, `<60 s → "N.N s"`, else `"N.N min"`).
- The logging consumer reads `event.at` directly for the log entry timestamp (no conversion).
- Recovery's synthetic `trigger.error` event carries `at: new Date().toISOString()` and `ts: events.at(-1)?.ts ?? 0`, so a crashed run's duration reads as "how far it got before we lost it."
- **BREAKING** No migration for existing persisted data. Local `pending/` and `archive/` directories and the DuckDB index must be wiped on upgrade.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `invocations`: redefine the `ts` field on `InvocationEvent` (now per-run monotonic µs) and add the `at` field (ISO wall-clock).
- `sandbox`: require a per-run monotonic anchor owned by the bridge, shared between event emission and the WASI monotonic clock.
- `recovery`: specify `at` and `ts` values for the synthetic `trigger.error` event emitted for a crashed pending invocation.
- `event-store`: replace the single `ts TIMESTAMPTZ` column with `at TIMESTAMPTZ` + `ts BIGINT` (µs) and update dashboard-facing ordering.
- `logging-consumer`: change the timestamp field in log entries to read from `event.at` directly.
- `dashboard-list-view`: render "started" from `at`, duration from monotonic `ts` diff with a smart-unit format.

## Impact

- Affected code
  - `packages/core/src/index.ts` — `InvocationEvent` interface gains `at`, `ts` semantics change
  - `packages/sandbox/src/bridge-factory.ts` — bridge owns anchor; `buildEvent` writes new fields
  - `packages/sandbox/src/worker.ts` — `installEmitEvent` and `emitTriggerEvent` write new fields; `handleRun` calls `bridge.resetAnchor()`
  - `packages/sandbox/src/wasi.ts` — `wasiState.anchorNs` removed; `wasiClockTimeGet` reads bridge anchor
  - `packages/runtime/src/event-bus/event-store.ts` — DuckDB DDL + `eventToRow` + query column references
  - `packages/runtime/src/event-bus/logging-consumer.ts` — `baseFields` reads `event.at`
  - `packages/runtime/src/recovery.ts` — synthetic event gains `at`, reuses last `ts`
  - `packages/runtime/src/ui/dashboard/middleware.ts` — `startedAt: r.at`, `completedAt: t?.at`, duration from `ts`
  - `packages/runtime/src/ui/dashboard/page.ts` — `formatDuration` smart-unit; `formatTimestamp` unchanged signature
  - Tests across `packages/core`, `packages/sandbox`, `packages/runtime` using `ts: <number>` fixtures — migrate to a shared `makeEvent({ at?, ts? })` helper.
- No API changes to public workflow SDK, manifest schema, or webhook contract.
- No infrastructure / deploy / security-invariant changes.
- Operational: one-time wipe of `pending/`, `archive/`, and the event-store index on upgrade (documented in tasks).
