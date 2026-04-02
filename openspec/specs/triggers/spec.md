# Triggers Specification

## Purpose

Receive external stimuli and convert them into typed events in the queue. Triggers are built into the platform runtime and are not user-extensible in v1.

## Requirements

### Requirement: HTTP trigger

The system SHALL provide a built-in HTTP trigger that listens for requests matching a configured method and path.

#### Scenario: Incoming POST request

- GIVEN an HTTP trigger configured for `POST /orders` emitting `order.received`
- WHEN a POST request arrives at `/orders` with a JSON body
- THEN the JSON body is used as the event payload
- AND the event is enqueued with a new correlation ID and trace ID
- AND fan-out creates one event file per subscribed action

### Requirement: Static response

The system SHALL return a preconfigured static response for all HTTP trigger requests.

#### Scenario: Trigger responds immediately

- GIVEN an HTTP trigger configured with `response: { status: 202, body: { accepted: true } }`
- WHEN a request arrives
- THEN the response `202 { "accepted": true }` is returned immediately
- AND event processing happens asynchronously via the queue

### Requirement: JSON body parsing

The system SHALL parse incoming HTTP request bodies as JSON. Non-JSON requests are rejected.

#### Scenario: Non-JSON request body

- GIVEN an HTTP trigger receives a request with `Content-Type: text/plain`
- WHEN the body cannot be parsed as JSON
- THEN the trigger returns `400 Bad Request`
- AND no event is enqueued

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code.

#### Scenario: Trigger binds server port

- GIVEN the runtime starts with an HTTP trigger configured
- WHEN the runtime initializes
- THEN it binds the configured HTTP server port
- AND registers routes for all configured HTTP triggers
