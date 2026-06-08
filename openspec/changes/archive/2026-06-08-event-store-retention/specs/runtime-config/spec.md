## ADDED Requirements

### Requirement: EVENT_STORE_RETENTION_DAYS config variable

The config SHALL parse `EVENT_STORE_RETENTION_DAYS` as a non-negative integer number of days and expose it on the config object (as `eventStoreRetentionDays`). When unset, it SHALL default to `0`. A value of `0` (or unset) SHALL disable EventStore retention entirely — no pruning is scheduled. A value greater than `0` SHALL enable retention with that window; periods longer than a month are expressed in days (e.g. six months = `180`). A non-numeric value SHALL be rejected by config parsing.

The prune interval SHALL be derived from this value (see the `event-store` capability); there is NO separate interval configuration variable.

This value gates a maintenance behavior only; it does not gate authentication or authorization.

#### Scenario: Default disables retention

- **WHEN** `EVENT_STORE_RETENTION_DAYS` is not set
- **THEN** the config value SHALL be `0`
- **AND** the EventStore SHALL NOT schedule pruning

#### Scenario: Override sets the retention window

- **WHEN** `EVENT_STORE_RETENTION_DAYS=90` is provided
- **THEN** the config value SHALL be `90`

#### Scenario: Non-numeric value rejected

- **WHEN** `EVENT_STORE_RETENTION_DAYS=forever` is provided
- **THEN** config parsing SHALL throw
