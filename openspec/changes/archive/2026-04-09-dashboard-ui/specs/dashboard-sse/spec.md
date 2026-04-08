## ADDED Requirements

### Requirement: SSE BusConsumer
The system SHALL provide a new `BusConsumer` implementation that tracks changed correlationIds and notifies connected SSE clients.

#### Scenario: Consumer receives event
- **WHEN** the EventBus dispatches an event to the SSE consumer
- **THEN** the consumer records the event's `correlationId` as changed

#### Scenario: Consumer registered on EventBus
- **WHEN** the runtime initializes
- **THEN** the SSE consumer is registered as a consumer on the EventBus alongside Persistence, WorkQueue, and EventStore

### Requirement: SSE endpoint
The system SHALL serve a Server-Sent Events stream at `GET /dashboard/events`.

#### Scenario: SSE connection
- **WHEN** a browser requests `GET /dashboard/events`
- **THEN** the response has `Content-Type: text/event-stream`
- **THEN** the connection is held open for streaming

#### Scenario: Multiple clients
- **WHEN** multiple browsers connect to `GET /dashboard/events`
- **THEN** each client receives the same update fragments independently

### Requirement: Debounced updates
The system SHALL debounce change notifications with a 1-second window before pushing updates to clients.

#### Scenario: Rapid state transitions
- **WHEN** multiple events for the same correlationId transition state within 1 second
- **THEN** only one SSE push is sent after the debounce window, containing the latest state

#### Scenario: Multiple correlationIds change
- **WHEN** events for different correlationIds change within the same 1-second window
- **THEN** a single SSE push contains updated fragments for all changed correlationIds

### Requirement: OOB HTML fragment push
The system SHALL push server-rendered HTML fragments via SSE using HTMX out-of-band swap.

#### Scenario: Entry row update
- **WHEN** an event state change affects a correlationId's aggregate state, event count, or last event time
- **THEN** the SSE push includes an updated entry row fragment with `hx-swap-oob="true"` and a matching element ID

#### Scenario: Header stats update
- **WHEN** any event state changes
- **THEN** the SSE push includes an updated header stats fragment with current pending/failed/done counts

#### Scenario: Open timeline update
- **WHEN** an event state changes for a correlationId that has an expanded timeline in the browser
- **THEN** the SSE push includes an updated SVG timeline fragment for that correlationId

#### Scenario: Filter dropdown update
- **WHEN** a new initial event type appears (a root event with a type not previously seen)
- **THEN** the SSE push includes an updated filter dropdown fragment with the new option
