## ADDED Requirements

### Requirement: Capability deprecated

The `recovery` capability SHALL be considered deprecated and is retained as a
tombstone only. The runtime SHALL NOT scan `pending/` at startup, replay
events, or synthesise an `engine_crashed` terminal. SIGKILL during an in-flight
invocation SHALL deliberately lose the invocation; SIGTERM SHALL drain via the
`event-store` capability's "SIGTERM drain" requirement, which synthesises a
`trigger.error{kind:"shutdown"}` terminal for each in-flight invocation.

#### Scenario: No recovery scan on startup

- **WHEN** the runtime boots against an existing persistence directory
- **THEN** the runtime SHALL NOT iterate `pending/` files
- **AND** the runtime SHALL NOT emit synthetic `engine_crashed` terminal events

## REMOVED Requirements

### Requirement: One-shot startup recovery function

**Reason**: There is nothing to recover at startup. With per-event durability removed, in-flight invocations live only in RAM and are lost on unclean termination by design. There is no `pending/` directory to scan, no orphan reconciliation, and no archive-cleanup case (because archives are not written as separate files anymore — DuckLake owns the durable layer atomically per commit).

**Migration**: Delete `packages/runtime/src/recovery.ts` and remove the `await recover(...)` call from `main.ts`. The runtime boots by opening the DuckLake catalog and starting the HTTP server; there is no recovery scan in between.

### Requirement: EventStore bootstraps from archive scan independently

**Reason**: The EventStore bootstrap is now "open the DuckLake catalog file" — there is no archive scan whose order vs. recovery needs to be specified. Cold start is constant-time and does not iterate per-invocation files.

**Migration**: Remove the `bootstrapFromArchive` step. The new `createEventStore` factory's resolution Promise represents catalog readiness.

### Requirement: Recovery runs before HTTP server starts

**Reason**: There is no recovery to run, so there is no ordering concern. The catalog must be open before the HTTP server starts (so `/readyz` and dashboard queries work), but that is captured by the `event-store` factory contract, not by a recovery requirement.

**Migration**: `main.ts` continues to await `createEventStore(...)` before starting Hono, but no `recover()` call is needed.
