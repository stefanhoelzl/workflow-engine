## MODIFIED Requirements

### Requirement: bootstrap() bulk inserts events

`bootstrap(events, options)` SHALL INSERT all provided events into the events table. The `pending` option SHALL be ignored — EventStore inserts all events regardless of whether they come from `pending/` or `archive/`.

#### Scenario: Bootstrap inserts pending batch

- **GIVEN** an EventStore
- **WHEN** `bootstrap([evt1, evt2], { pending: true })` is called
- **THEN** two rows exist in the events table

#### Scenario: Bootstrap inserts archive batch

- **GIVEN** an EventStore
- **WHEN** `bootstrap([evt1, evt2, evt3], { pending: false })` is called
- **THEN** three rows exist in the events table

#### Scenario: Bootstrap with empty array

- **GIVEN** an EventStore
- **WHEN** `bootstrap([], { pending: true })` is called
- **THEN** no rows are added
