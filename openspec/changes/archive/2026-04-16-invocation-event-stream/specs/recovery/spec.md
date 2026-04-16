## MODIFIED Requirements

### Requirement: One-shot startup recovery function

On startup, the recovery function SHALL scan `pending/` for orphaned event files. For each unique invocation id found, it SHALL:
1. Load all existing events for that invocation into the event bus (so they reach the event store)
2. Synthesize a `trigger.error` event with `error: { kind: "engine_crashed", message: "Process died mid-invocation" }`, seq = max existing seq + 1, ref = 0
3. Emit the synthetic event to the bus (which triggers persistence to archive all files for that invocation)

#### Scenario: Crashed pending invocations swept on startup
- **WHEN** `pending/` contains event files for invocation `evt_abc` (e.g., `evt_abc_0.json`, `evt_abc_1.json`)
- **THEN** recovery SHALL emit all existing events to the bus, synthesize a `trigger.error` event, emit it, and the persistence consumer SHALL archive all files to `archive/evt_abc/`

#### Scenario: Empty pending is a no-op
- **WHEN** `pending/` contains no event files
- **THEN** recovery SHALL complete without emitting any events

### Requirement: Recovery runs before HTTP server starts

The recovery sweep SHALL complete before the HTTP server binds its port, ensuring all orphaned invocations are resolved before new traffic arrives.

#### Scenario: Recovery completes before port bind
- **WHEN** the runtime starts
- **THEN** the recovery function SHALL be awaited before the HTTP listener is created
