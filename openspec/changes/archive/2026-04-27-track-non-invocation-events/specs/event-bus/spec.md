## ADDED Requirements

### Requirement: EventKind union extends additively for non-invocation surfaces

The `@workflow-engine/core` `EventKind` union SHALL include `"trigger.rejection"` and `"system.upload"` as discriminated members alongside the existing kinds. These kinds SHALL flow through `BusConsumer.handle(event)` exactly like every other kind: `EventStore` indexes them, `Logging` may format them, `Persistence` MAY archive them per its own rules.

Existing consumers SHALL NOT need a code change to receive these new kinds — they appear as normal `InvocationEvent`s widened by the runtime stamping path. Consumers that filter by `kind` for invocation-lifecycle-specific logic SHALL continue to filter explicitly to `"trigger.request" | "trigger.response" | "trigger.error"` as today.

#### Scenario: New kinds reach existing consumers

- **GIVEN** a `BusConsumer` registered with the bus that handles every event it receives
- **WHEN** the runtime emits a `system.upload` event followed by a `trigger.rejection` event
- **THEN** the consumer's `handle` method SHALL be called once for each event
- **AND** the events SHALL carry the runtime-widened fields (`owner`, `repo`, `workflow`, `workflowSha`, `id`)
