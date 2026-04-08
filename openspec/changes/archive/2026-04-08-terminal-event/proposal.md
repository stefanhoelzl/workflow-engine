## Why

The RuntimeEvent `state` field conflates lifecycle progress with outcome. Consumers like persistence and work-queue independently re-derive which states are "terminal" (`done || failed || skipped`), scattering state-machine semantics across the codebase instead of encoding them in the type itself.

## What Changes

- **BREAKING**: Split `state` into two fields: `state` (pending | processing | done) for lifecycle and `result` (succeeded | failed | skipped) for outcome, present only when `state === "done"`.
- **BREAKING**: The `error` field is now required when `result === "failed"` and absent otherwise, enforced at the Zod schema level via a union of object variants.
- Terminal detection simplifies from a 3-way OR to `event.state === "done"`.
- All emit sites in the scheduler, context, and triggers update to the new shape.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `events`: The RuntimeEvent lifecycle model changes from five flat states to a state/result split. The "Rich event metadata" and "Five-state lifecycle model" requirements are replaced.
- `persistence`: Terminal-state detection in `handle()` and `recover()` simplifies to check `state === "done"` instead of a 3-way OR. Spec scenarios referencing `state: "failed"` / `state: "skipped"` update to `state: "done", result: "failed"` / `state: "done", result: "skipped"`.

## Impact

- **Runtime event-bus**: `RuntimeEventSchema` in `event-bus/index.ts` becomes a Zod union of four object variants (ActiveEvent, SucceededEvent, SkippedEvent, FailedEvent).
- **Scheduler**: All `bus.emit({ ...event, state: "done" | "failed" | "skipped" })` call sites change to include `result`.
- **Persistence**: `isTerminal` check simplifies; file routing logic unchanged.
- **Work-queue**: No change needed (`event.state !== "pending"` still works).
- **EventStore (DuckDB)**: Schema needs a `result` column and `state` column values narrowed.
- **Context / EventFactory**: Emit helpers update to new shape.
- **Tests**: All event fixtures and assertions update to new field structure.
- **No migration**: Archived events on disk retain old shape; they are never re-parsed by the runtime.
