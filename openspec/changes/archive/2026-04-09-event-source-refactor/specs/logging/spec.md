## ADDED Requirements

### Requirement: Event lifecycle logging via bus consumer

All event lifecycle logging SHALL be performed by a dedicated `LoggingConsumer` bus consumer, not by individual components (ContextFactory, Scheduler, main.ts). This centralizes event logging in a single location.

#### Scenario: No event logging outside LoggingConsumer

- **GIVEN** the full source tree excluding the logging consumer module
- **WHEN** searching for log calls with messages matching `event.emitted`, `event.created`, `action.started`, `action.completed`, `action.failed`, `event.no-match`, `event.fanout`, `event.fanout.skipped`, or `events.recovered`
- **THEN** no matches are found
