## ADDED Requirements

### Requirement: Cron triggers listed alongside HTTP triggers

The `/trigger/<tenant>/<workflow>/` UI SHALL list cron triggers in the same list as HTTP triggers. Each cron trigger entry SHALL display at least the trigger name, its `schedule`, and its `tz`.

#### Scenario: Cron trigger appears in the list

- **GIVEN** a tenant with a loaded workflow containing `cronTrigger({ schedule: "0 9 * * *", tz: "UTC", handler })` exported as `daily`
- **WHEN** a user loads `GET /trigger/<tenant>/<workflow>/`
- **THEN** the page SHALL list a trigger entry for `daily`
- **AND** the entry SHALL show `schedule: 0 9 * * *` and `tz: UTC` (or equivalent rendering)

### Requirement: Run now button for cron triggers

For cron trigger entries, the `/trigger` UI SHALL render a "Run now" button in place of a payload-entry form. Clicking the button SHALL issue a POST request that causes the trigger-UI middleware to call `executor.invoke(tenant, workflow, descriptor, {}, bundleSource)` exactly once with the empty payload `{}`. Scheduled cron timers SHALL continue to run independently — the manual fire SHALL NOT cancel or reschedule them.

#### Scenario: Run now dispatches with empty payload

- **GIVEN** a cron trigger `daily` listed in `/trigger/<tenant>/<workflow>/`
- **WHEN** the user clicks "Run now" for `daily`
- **THEN** the UI SHALL POST to the trigger-UI manual-fire endpoint
- **AND** the middleware SHALL call `executor.invoke(tenant, workflow, descriptor, {}, bundleSource)` exactly once
- **AND** the invocation SHALL appear in the archive as an ordinary completed or failed entry

#### Scenario: Run now does not affect scheduled timers

- **GIVEN** a cron trigger with an armed scheduled timer due in 60 seconds
- **WHEN** the user clicks "Run now"
- **THEN** the cron source's pending `setTimeout` SHALL NOT be cancelled
- **AND** when the 60-second timer fires, a second `executor.invoke` SHALL occur

#### Scenario: Run now does not render a payload form

- **WHEN** the `/trigger` UI renders a cron trigger entry
- **THEN** no Jedison form or payload-input element SHALL be present for that entry
- **AND** only a "Run now" control SHALL be rendered
