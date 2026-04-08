## ADDED Requirements

### Requirement: WorkQueue implements BusConsumer with dequeue

The WorkQueue SHALL implement the `BusConsumer` interface and additionally expose a `dequeue(signal?: AbortSignal): Promise<RuntimeEvent>` method. It SHALL be created via a factory function `createWorkQueue(): WorkQueue`.

#### Scenario: Factory creates WorkQueue

- **WHEN** `createWorkQueue()` is called
- **THEN** the returned object implements `BusConsumer` (handle + bootstrap)
- **AND** exposes a `dequeue()` method

### Requirement: handle() buffers only pending events

`handle(event)` SHALL buffer the event only when `event.state === "pending"`. Events with any other state SHALL be ignored. If there are waiters blocked on `dequeue()`, the first waiter SHALL be resolved with the event immediately instead of buffering.

#### Scenario: Pending event is buffered

- **GIVEN** a WorkQueue with no waiters
- **WHEN** `handle({ state: "pending", ... })` is called
- **THEN** the event is added to the internal buffer

#### Scenario: Non-pending events are ignored

- **GIVEN** a WorkQueue
- **WHEN** `handle({ state: "processing", ... })` is called
- **THEN** the event is NOT buffered
- **AND** no waiters are resolved

#### Scenario: Pending event resolves waiting dequeue

- **GIVEN** a WorkQueue with an empty buffer and one pending `dequeue()` call
- **WHEN** `handle({ state: "pending", ... })` is called
- **THEN** the pending `dequeue()` promise resolves with the event
- **AND** the event is NOT added to the buffer

### Requirement: bootstrap() buffers pending and processing events

`bootstrap(events, options)` SHALL buffer events with state `"pending"` or `"processing"`. Events with terminal states (done/failed/skipped) SHALL be ignored. Processing events are included because they represent work interrupted by a crash that needs retry.

#### Scenario: Bootstrap buffers pending events

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "pending"}, {state: "done"}])` is called
- **THEN** only the pending event is buffered

#### Scenario: Bootstrap buffers processing events for retry

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "processing"}])` is called
- **THEN** the processing event is buffered (it was mid-flight when the process crashed)

#### Scenario: Bootstrap ignores terminal events

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "done"}, {state: "failed"}, {state: "skipped"}])` is called
- **THEN** no events are buffered

### Requirement: Blocking dequeue with AbortSignal

`dequeue(signal?: AbortSignal): Promise<RuntimeEvent>` SHALL return the next buffered event if one exists. If the buffer is empty, it SHALL block until an event becomes available via `handle()` or `bootstrap()`. Multiple concurrent `dequeue()` calls SHALL be served in FIFO order. The optional `AbortSignal` SHALL allow cancellation of a pending dequeue.

#### Scenario: Dequeue returns buffered event

- **GIVEN** a WorkQueue with one buffered event
- **WHEN** `dequeue()` is called
- **THEN** the event is returned immediately

#### Scenario: Dequeue blocks when buffer is empty

- **GIVEN** a WorkQueue with an empty buffer
- **WHEN** `dequeue()` is called
- **THEN** the returned promise does not resolve
- **AND** when `handle({ state: "pending", ... })` is subsequently called
- **THEN** the promise resolves with that event

#### Scenario: Multiple dequeues served in FIFO order

- **GIVEN** a WorkQueue with an empty buffer
- **AND** two `dequeue()` calls are pending
- **WHEN** two events arrive via `handle()`
- **THEN** the first dequeue resolves with the first event
- **AND** the second dequeue resolves with the second event

#### Scenario: Dequeue cancelled via AbortSignal

- **GIVEN** a WorkQueue with an empty buffer
- **WHEN** `dequeue(signal)` is called with an AbortSignal
- **AND** the signal is aborted before an event arrives
- **THEN** the promise rejects with an error where `error.name` is `"AbortError"`

#### Scenario: Dequeue resolves before abort

- **GIVEN** a WorkQueue with an empty buffer
- **WHEN** `dequeue(signal)` is called with an AbortSignal
- **AND** an event arrives before the signal is aborted
- **THEN** the promise resolves with the event
- **AND** the abort listener is cleaned up

#### Scenario: Aborted dequeue cleans up waiter

- **GIVEN** a WorkQueue with an empty buffer and a pending `dequeue(signal)` call
- **WHEN** the signal is aborted
- **THEN** the waiter is removed from the internal list
- **AND** a subsequently arriving event does not resolve the aborted promise

### Requirement: No enqueue method

The WorkQueue SHALL NOT expose an `enqueue()` method. Events enter the WorkQueue exclusively through `handle()` (runtime) and `bootstrap()` (startup). This ensures all events flow through the bus.

#### Scenario: WorkQueue has no enqueue

- **GIVEN** a WorkQueue instance
- **WHEN** inspecting its public API
- **THEN** no `enqueue` method exists
