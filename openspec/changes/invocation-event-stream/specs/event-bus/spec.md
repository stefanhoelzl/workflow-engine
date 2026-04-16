## MODIFIED Requirements

### Requirement: BusConsumer interface for invocation lifecycle

A `BusConsumer` SHALL expose a `handle(event: InvocationEvent): Promise<void>` method. `InvocationEvent` is imported from `@workflow-engine/core` and replaces the previous `InvocationLifecycleEvent` union (`StartedEvent | CompletedEvent | FailedEvent`). Consumers receive individual events (one per bridge call, action, or trigger transition) rather than coarse lifecycle transitions.

`InvocationEvent` SHALL carry: `kind` (EventKind), `id` (invocation correlation id), `seq` (monotonic integer within invocation), `ref` (related seq or null), `ts` (epoch millis), `workflow` (workflow name), `workflowSha` (bundle SHA-256 hash), `name` (trigger/action/method name). Optional fields: `input` (on `*.request`), `output` (on `*.response`), `error` (on `*.error` — object with `message`, `stack`, and optional `issues`).

`EventKind` SHALL be a string union of nine values: `trigger.request`, `trigger.response`, `trigger.error`, `action.request`, `action.response`, `action.error`, `system.request`, `system.response`, `system.error`.

#### Scenario: Consumer receives an invocation event
- **WHEN** the bus emits an `InvocationEvent` (any kind)
- **THEN** each registered consumer's `handle` method SHALL be called with that event

#### Scenario: Event kind discriminator
- **WHEN** an event is created
- **THEN** its `kind` field SHALL be one of the nine valid `EventKind` values

#### Scenario: Events are self-contained
- **WHEN** a `system.response` event is read in isolation
- **THEN** it SHALL contain `workflow`, `workflowSha`, `name`, `id`, `seq`, `ref`, `ts`, and `output` — sufficient to identify what workflow, what bundle version, and what method produced it

### Requirement: EventBus interface

An `EventBus` SHALL expose `emit(event: InvocationEvent): Promise<void>`. It SHALL fan out each event to all consumers sequentially.

#### Scenario: Emit fans out to all consumers in order
- **WHEN** `bus.emit(event)` is called
- **THEN** each consumer's `handle()` SHALL be awaited in registration order before the next is called

#### Scenario: Consumer error propagates
- **WHEN** a consumer's `handle` throws
- **THEN** subsequent consumers SHALL NOT be called and `bus.emit` SHALL reject with the error

## REMOVED Requirements

### Requirement: Events are immutable
**Reason**: The new event model is inherently immutable — events are individual rows, never updated. The concept of state transitions creating new objects is replaced by paired request/response events.
**Migration**: No migration needed. Consumers that checked `event.kind` for `started`/`completed`/`failed` now check for `trigger.request`/`trigger.response`/`trigger.error` or other event kinds.
