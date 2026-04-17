## MODIFIED Requirements

### Requirement: Logging consumer logs invocation lifecycle

The logging consumer SHALL implement `BusConsumer` and SHALL emit one structured pino log entry per invocation lifecycle event. Each log entry SHALL include the invocation `id`, `workflow`, `trigger`, `kind` (`started | completed | failed`), and timestamp. The timestamp field in the log entry SHALL be named `ts` (for continuity with the existing log format) and SHALL be populated directly from `event.at` — i.e. the ISO 8601 string already on the event — without any conversion through `new Date(...)` or similar. `failed` entries SHALL additionally include the serialized error.

The logging consumer SHALL NOT read or emit `event.ts` (the per-run monotonic microsecond value); that field is not meaningful in cross-invocation log streams.

#### Scenario: Started event logged

- **WHEN** the consumer receives `{ kind: "started", id: "evt_a", workflow: "w", trigger: "t", at: "2026-04-17T10:00:00.000Z", ts: 0 }`
- **THEN** the consumer SHALL log a structured entry at `info` level containing `id`, `workflow`, `trigger`, `kind: "started"`, and `ts: "2026-04-17T10:00:00.000Z"` (the ISO string from `event.at`, pass-through)

#### Scenario: Failed event logged with error

- **WHEN** the consumer receives `{ kind: "failed", id: "evt_a", at, ts, error: { message: "boom", stack } }`
- **THEN** the consumer SHALL log a structured entry at `error` level including the serialized error
- **AND** the log entry's `ts` field SHALL equal the event's `at` ISO string

#### Scenario: Monotonic ts is not logged

- **WHEN** the consumer receives any lifecycle event
- **THEN** the emitted log entry SHALL NOT contain the event's `ts` (per-run µs) field under any log key
