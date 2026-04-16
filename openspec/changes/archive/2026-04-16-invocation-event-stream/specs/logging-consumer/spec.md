## MODIFIED Requirements

### Requirement: Logging consumer logs invocation lifecycle

The logging consumer SHALL log at `info` level on `trigger.request` (invocation started) and `trigger.response` (invocation completed). It SHALL log at `error` level on `trigger.error` (invocation failed). All other event kinds (`action.*`, `system.*`) SHALL be silently ignored — they are too verbose for structured logs.

#### Scenario: trigger.request logged at info
- **WHEN** `handle()` receives a `trigger.request` event
- **THEN** it SHALL log at `info` level with fields: `id`, `workflow`, trigger `name`

#### Scenario: trigger.response logged at info
- **WHEN** `handle()` receives a `trigger.response` event
- **THEN** it SHALL log at `info` level with fields: `id`, `workflow`, trigger `name`

#### Scenario: trigger.error logged at error
- **WHEN** `handle()` receives a `trigger.error` event
- **THEN** it SHALL log at `error` level with fields: `id`, `workflow`, trigger `name`, `error`

#### Scenario: action and system events are not logged
- **WHEN** `handle()` receives an `action.request`, `system.response`, or any non-trigger event
- **THEN** it SHALL return without logging
