## ADDED Requirements

### Requirement: Capability deprecated

The `logging-consumer` capability SHALL be considered deprecated and is
retained as a tombstone only. The `invocation.started` / `invocation.completed`
/ `invocation.failed` lifecycle log lines are emitted by the executor (see
`executor/log-lifecycle.ts` and the `invocations` capability), not by a
bus consumer. The runtime SHALL NOT export `createLoggingConsumer`.

#### Scenario: No logging-consumer factory exported

- **WHEN** a caller imports from `@workflow-engine/runtime`
- **THEN** there SHALL be no symbol named `createLoggingConsumer`

## REMOVED Requirements

### Requirement: LoggingConsumer implements BusConsumer

**Reason**: The bus is removed; there are no consumers. Lifecycle log emission moves to the executor's `onEvent` widener, which already discriminates on `event.kind` to stamp dispatch metadata. The logging-consumer module is deleted.

**Migration**: Replace the `createLoggingConsumer(logger)` registration with a small helper `executor/log-lifecycle.ts` invoked inline from the executor. The behaviour (one log line per `trigger.request` / `trigger.response` / `trigger.error`) is preserved verbatim under the `invocations` capability delta.

### Requirement: Logging consumer logs invocation lifecycle

**Reason**: This requirement moves to the `invocations` capability. The executor — which already owns invocation lifecycle bookkeeping — is the natural home for `invocation.started` / `.completed` / `.failed` log line emission.

**Migration**: See the `invocations` capability delta for the new placement and the preserved log shapes.

### Requirement: Only trigger.* lifecycle events are logged

**Reason**: This filtering rule moves to the executor's `log-lifecycle.ts`. Action and system events continue not to be structured-logged at the lifecycle layer; they remain in the events table for the dashboard.

**Migration**: The kind discrimination is preserved verbatim (`if event.kind === "trigger.request" → info; "trigger.response" → info; "trigger.error" → error`).

### Requirement: Logging consumer never throws

**Reason**: The "logging never poisons the strict consumer" property moves to `executor/log-lifecycle.ts`. It MUST wrap log calls in try/catch so that a logger failure cannot prevent the executor from invoking `eventStore.record(event)`.

**Migration**: The new helper preserves the try/catch with a console.error fallback. See the `invocations` capability delta.

### Requirement: Consumer ordering in bus

**Reason**: The bus is removed; there is no ordering of consumers. The order of operations within the executor's `onEvent` widener (record event, then log lifecycle) is documented in the `invocations` capability delta — log emission MUST happen after the durability commit (or its retry-drop resolution), so that a logged lifecycle line implies a corresponding accumulator-or-DuckLake state transition.

**Migration**: No call-site change beyond the executor wiring; the ordering invariant is preserved by sequential code.
