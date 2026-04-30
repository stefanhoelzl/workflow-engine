## Purpose

Provide a dedicated bus consumer that centralizes all invocation lifecycle logging in a single location.
## Requirements
### Requirement: Capability deprecated

The `logging-consumer` capability SHALL be considered deprecated and is
retained as a tombstone only. The `invocation.started` / `invocation.completed`
/ `invocation.failed` lifecycle log lines are emitted by the executor (see
`executor/log-lifecycle.ts` and the `invocations` capability), not by a
bus consumer. The runtime SHALL NOT export `createLoggingConsumer`.

#### Scenario: No logging-consumer factory exported

- **WHEN** a caller imports from `@workflow-engine/runtime`
- **THEN** there SHALL be no symbol named `createLoggingConsumer`

