## MODIFIED Requirements

### Requirement: Cron trigger schedule field

For trigger entries with `type: "cron"`, the manifest SHALL require:

- `schedule`: `string` — a non-empty cron expression. The manifest layer SHALL NOT constrain the grammar beyond non-emptiness; the runtime cron source's `CronExpressionParser.parse` (cron-parser) is the authoritative grammar check. Schedules MAY be 5-field, 6-field (with seconds), or any other form `cron-parser` accepts. Schedules MAY also be a workflow-secret sentinel reference.
- `tz`: `string` — an IANA timezone identifier (validated via the "IANA timezone validation" requirement) or a workflow-secret sentinel reference.
- `inputSchema`: JSON Schema for the empty input object.
- `outputSchema`: JSON Schema for `unknown`.

#### Scenario: Cron trigger entry accepts 5-field schedule

- **GIVEN** a cron trigger with `schedule: "0 2 * * *"` and `tz: "Europe/Berlin"`
- **WHEN** the manifest is parsed
- **THEN** the entry SHALL be accepted with `schedule: "0 2 * * *"` and `tz: "Europe/Berlin"`

#### Scenario: Cron trigger entry accepts 6-field schedule

- **GIVEN** a cron trigger with `schedule: "* * * * * *"` (every-second) and `tz: "UTC"`
- **WHEN** the manifest is parsed
- **THEN** the entry SHALL be accepted; `cron-parser` is the runtime authority for the grammar

#### Scenario: Cron trigger with empty schedule fails

- **WHEN** a manifest contains a cron trigger with `schedule: ""`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `schedule` field as required to be non-empty

#### Scenario: Cron trigger with unparseable schedule reaches the runtime

- **GIVEN** a manifest containing a cron trigger with `schedule: "not a cron"`
- **WHEN** the manifest is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed (the manifest layer is permissive)
- **AND** the runtime cron source's `CronExpressionParser.parse` SHALL throw on first arm, surfacing as a `cron.schedule-invalid` log line and a no-op for that entry's timer
