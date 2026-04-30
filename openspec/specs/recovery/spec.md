# Recovery Specification

## Purpose

Provide startup recovery for crashed pending invocations and EventStore bootstrapping from the archive.
## Requirements
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

