# Sandbox Specification

## Purpose

Securely execute untrusted user-provided JavaScript actions in isolated V8 environments, preventing access to host resources while providing a minimal, typed API for computation and event emission.

## Requirements

### Requirement: Isolate-per-invocation

The system SHALL create a fresh `isolated-vm` V8 Isolate for every action invocation.

#### Scenario: Clean state between invocations

- GIVEN an action that writes to a variable in module scope
- WHEN the action is invoked twice with different event payloads
- THEN each invocation sees only its own state
- AND no data leaks between invocations

### Requirement: Memory limit enforcement

The system SHALL enforce an 8 MB heap memory limit per isolate.

#### Scenario: Action exceeds memory limit

- GIVEN an action that allocates a very large array
- WHEN the allocation exceeds 8 MB
- THEN the isolate is terminated
- AND the event is moved to `failed/`
- AND a `system.error` event is emitted

### Requirement: Execution timeout

The system SHALL enforce a 30-second execution timeout per action invocation.

#### Scenario: Action enters infinite loop

- GIVEN an action containing `while (true) {}`
- WHEN 30 seconds elapse
- THEN the isolate is terminated
- AND the event is moved to `failed/`
- AND a `system.error` event is emitted

### Requirement: JSON-only data boundary

The system SHALL only transfer JSON-serializable data across the isolate boundary.

#### Scenario: Host injects event data

- GIVEN an event with payload `{ "orderId": "123", "total": 42 }`
- WHEN the action reads `ctx.data`
- THEN it receives a plain JSON object with the same structure
- AND no host references, prototypes, or functions are accessible

### Requirement: Minimal host API

The system SHALL expose only `ctx.data` and `ctx.emit(eventType, payload)` to sandboxed actions in v1.

#### Scenario: Action attempts to access host APIs

- GIVEN an action that references `process`, `require`, `fs`, `fetch`, or `globalThis.constructor`
- WHEN the action executes
- THEN a `ReferenceError` is thrown inside the isolate
- AND the host process is unaffected

### Requirement: Synchronous emit bridge

The system SHALL implement `ctx.emit()` as a synchronous callback from the isolate to the host via `isolated-vm`'s `applySync`.

#### Scenario: Action emits an event

- GIVEN an action that calls `ctx.emit('order.parsed', { orderId: '123', total: 42 })`
- WHEN the call executes
- THEN the host collects the emitted event in a list
- AND the emitted events are enqueued after the action completes successfully
- AND emitted events are discarded if the action throws
