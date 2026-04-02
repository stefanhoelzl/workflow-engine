# Scheduler Specification

## Purpose

Process events from the queue by loading action code into sandboxed isolates, managing concurrency, and handling success/failure outcomes.

## Requirements

### Requirement: Concurrent processing

The system SHALL process up to N events in parallel, where N is a configurable global concurrency limit.

#### Scenario: Concurrency limit reached

- GIVEN a concurrency limit of 10
- AND 10 actions are currently executing
- WHEN a new event is available in the pending list
- THEN the scheduler waits until a slot frees up before starting the next execution

### Requirement: Processing lifecycle

The system SHALL follow this lifecycle for each event: dequeue → mark processing → execute in isolate → ack or fail → enqueue emitted events.

#### Scenario: Successful action execution

- GIVEN a pending event targeting `parseOrder`
- WHEN the scheduler picks it up
- THEN the file is renamed from `pending/` to `processing/`
- AND a fresh isolate is created with 8 MB heap and 30s timeout
- AND the action handler is compiled and executed
- AND on success, the file is renamed to `done/`
- AND any emitted events are enqueued to `pending/`

#### Scenario: Failed action execution

- GIVEN a pending event targeting `parseOrder`
- WHEN the action throws an error
- THEN the file is renamed to `failed/`
- AND a `system.error` event is enqueued
- AND any events emitted before the throw are discarded

### Requirement: No retry

The system SHALL NOT retry failed actions in v1. Failed events are moved directly to `failed/`.

### Requirement: Isolate disposal

The system SHALL dispose the V8 Isolate after every action execution, regardless of success or failure.

#### Scenario: Memory reclamation

- GIVEN an action that allocates 7 MB of data
- WHEN the action completes
- THEN the isolate is disposed
- AND the 7 MB is reclaimed by the host process

### Requirement: Structured logging

The system SHALL log every event lifecycle transition as a structured JSON line including: event ID, event type, action name, correlation ID, trace ID, duration, outcome (success/failure), and error message if applicable.

#### Scenario: Log output for successful execution

- GIVEN event `evt_001` targeting `parseOrder` completes in 12ms
- THEN a log line is emitted containing `{"eventId":"evt_001","action":"parseOrder","status":"done","durationMs":12,"correlationId":"corr_...","traceId":"trace_..."}`
