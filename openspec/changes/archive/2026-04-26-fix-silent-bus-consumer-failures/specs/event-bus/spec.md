## MODIFIED Requirements

### Requirement: BusConsumer interface for invocation lifecycle

The system SHALL define a `BusConsumer` interface with three members:

- `readonly name: string` — short, stable identifier used in structured logs (`bus.consumer-failed { consumer: <name> }` and `runtime.fatal { consumer: <name> }`). Production wiring uses `"persistence"`, `"event-store"`, `"logging"`.
- `readonly strict: boolean` — durability tier flag. `true` means a `handle` rejection is a runtime-fatal condition (the bus logs `runtime.fatal` and terminates the process); `false` means the bus logs and skips the consumer, leaving subsequent consumers to run normally.
- `handle(event: InvocationEvent): Promise<void>` — called for each event at runtime.

`InvocationEvent` SHALL be a discriminated union over `kind` as defined in the `invocations` capability spec and the `@workflow-engine/core` `EventKind` union. The three invocation lifecycle kinds are `"trigger.request"` (invocation start), `"trigger.response"` (successful terminal), and `"trigger.error"` (failed terminal). Non-lifecycle kinds (`action.*`, `fetch.*`, `timer.*`, `console.*`, `wasi.*`, `system.*`) also flow through the bus; consumers SHALL filter by `kind` for logic that applies only to lifecycle events.

Events reaching `handle` SHALL already be fully widened by the executor's `sb.onEvent` receiver: runtime-owned fields (`tenant`, `workflow`, `workflowSha`, `invocationId`, and on `trigger.request` only `meta.dispatch`) are stamped before emission and SHALL NOT be re-stamped or mutated by consumers. Sandbox-owned intrinsic fields (`seq`, `ref`, `ts`, `at`, `id`) are likewise immutable on receipt.

The `bootstrap` method on `BusConsumer` SHALL be removed in v1; consumers that need startup data (like EventStore) SHALL read from persistence's `scanArchive()` directly during their own initialization.

#### Scenario: Consumer receives lifecycle event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit({ kind: "trigger.request", id, workflow, trigger, at, ts, input, meta: { dispatch: { source: "trigger" } } })` is called
- **THEN** the consumer's `handle` SHALL be called with that event

#### Scenario: Consumer declares name and strict tier

- **GIVEN** the persistence consumer factory and the event-store consumer factory
- **THEN** the persistence consumer SHALL expose `name === "persistence"` and `strict === true`
- **AND** the event-store consumer SHALL expose `name === "event-store"` and `strict === false`

### Requirement: EventBus interface

The system SHALL define an `EventBus` interface with one method:

- `emit(event: InvocationEvent): Promise<void>` — fan out an event to all consumers.

The bus SHALL dispatch synchronously through registered consumers in registration order. `emit` SHALL await each consumer's `handle` call in sequence.

The bus SHALL wrap each consumer's `handle` in a try/catch:

- On a thrown rejection, the bus SHALL log a structured `bus.consumer-failed` entry at `error` level including the consumer's `name` and the thrown error (`{ message, stack }` at minimum).
- If the failing consumer's `strict` flag is `false`, the bus SHALL continue with the next consumer. `emit` SHALL resolve normally after the last consumer (regardless of how many best-effort failures occurred).
- If the failing consumer's `strict` flag is `true`, the bus SHALL terminate the runtime: it SHALL log a structured `runtime.fatal` entry at `error` level with `reason: "bus-strict-consumer-failed"` and contextual fields drawn from the failing event (`id`, `kind`, `seq`, `owner`, `workflowSha`, plus the underlying `error`) and the failing consumer (`consumer: <name>`); it SHALL schedule `process.exit(1)` via `setImmediate` so the current microtask queue drains (logger flush, in-flight HTTP response writes) before the process dies; and it SHALL NOT resolve `emit`, so callers' downstream `await bus.emit(...)` parks forever (matching the production semantics that no further work runs on a doomed process).

This per-consumer isolation SHALL ensure that a best-effort failure in one consumer (e.g. logging-consumer) does not block subsequent consumers from observing the event, while a strict failure (persistence) reliably crashes the runtime so that K8s `CrashLoopBackOff` and recovery-on-next-boot can reconcile state.

The bus is the single owner of the fatal-exit contract for strict-consumer failures. Callers of `bus.emit` SHALL NOT wrap calls in their own `.catch` handlers for the purpose of triggering shutdown; the bus has the durability-tier knowledge and is responsible for acting on it.

#### Scenario: Emit fans out to all consumers in order

- **GIVEN** an EventBus created with consumers `[persistence, eventStore, logging]`
- **WHEN** `bus.emit(event)` is called
- **THEN** persistence.handle(event) SHALL run first
- **AND** eventStore.handle(event) SHALL run after persistence resolves
- **AND** logging.handle(event) SHALL run after eventStore resolves
- **AND** `bus.emit` SHALL resolve only after logging.handle resolves

#### Scenario: Best-effort consumer error is logged and skipped

- **GIVEN** an EventBus with consumers `[A, B, C]` where `B.strict === false`
- **WHEN** `bus.emit(event)` is called
- **AND** `B.handle` throws `new Error("boom")`
- **THEN** the bus SHALL log a structured `bus.consumer-failed` entry at `error` level including `consumer: B.name` and the thrown error
- **AND** `C.handle` SHALL still be called
- **AND** `bus.emit` SHALL resolve normally

#### Scenario: Strict consumer error terminates the runtime

- **GIVEN** an EventBus with consumers `[A, B, C]` where `B.strict === true`
- **WHEN** `bus.emit(event)` is called
- **AND** `B.handle` throws `new Error("storage offline")`
- **THEN** the bus SHALL log a structured `bus.consumer-failed` entry at `error` level including `consumer: B.name` and the thrown error
- **AND** the bus SHALL log a structured `runtime.fatal` entry at `error` level with `reason: "bus-strict-consumer-failed"`, `consumer: B.name`, the failing event's `id`, `kind`, `seq`, `owner`, `workflowSha`, and the underlying `error`
- **AND** the bus SHALL schedule `process.exit(1)` via `setImmediate` (in tests, the injected exit hook SHALL be invoked exactly once)
- **AND** `C.handle` SHALL NOT be called
- **AND** `bus.emit` SHALL NOT resolve — its returned promise stays pending forever (matching the production semantics of "the process is dying")

### Requirement: createEventBus factory

The system SHALL provide a `createEventBus(consumers: BusConsumer[], opts: { logger: Logger }): EventBus` factory function.

- `consumers` SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position.
- `opts.logger` SHALL be required (not optional) — the bus uses it to write the load-bearing `bus.consumer-failed` and `runtime.fatal` log lines.

Consumer order is guidance, not a contract — the event bus itself does not enforce any specific ordering, and no validation runs against the supplied array. The runtime's canonical wiring uses `[persistence, eventStore, logging]` (see `packages/runtime/src/main.ts`) so that persistence observes the event before EventStore indexes it and before the logging consumer emits human-readable output; this ordering is a runtime-integration choice, not a requirement on the event-bus module, and other compositions (tests, subset harnesses, future consumers) are free to pick a different order as long as intra-event serialization is preserved by the bus's internal emit loop.

#### Scenario: Create bus with consumers and logger

- **GIVEN** an array of BusConsumer instances `[persistence, eventStore, logging]` and a Logger instance
- **WHEN** `createEventBus([persistence, eventStore, logging], { logger })` is called
- **THEN** the returned EventBus fans out events to all three consumers in order
- **AND** uses the supplied logger for both `bus.consumer-failed` and `runtime.fatal` lines

#### Scenario: Empty consumer list

- **GIVEN** an empty array and a logger
- **WHEN** `createEventBus([], { logger })` is called
- **THEN** the returned EventBus emits without error (no-op fan-out)
