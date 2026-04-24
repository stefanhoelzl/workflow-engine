## ADDED Requirements

### Requirement: Cron trigger descriptor fields support secret sentinels

The `CronTriggerDescriptor` manifest fields that are typed `string` — specifically `schedule` and `tz` — MAY carry one or more sentinel substrings produced by the SDK's build-time `SecretEnvRef` resolution. The cron TriggerSource SHALL receive fully-resolved plaintext strings in these fields via `reconfigure(owner, repo, entries)`; the workflow-registry performs the substitution before dispatch (see `workflow-registry` spec: "Registry resolves secret sentinels before reconfiguring backends").

The cron TriggerSource SHALL NOT itself parse, match, or otherwise recognize sentinel substrings. Its contract remains "receive already-resolved strings and schedule timers accordingly." The descriptor Zod schema is unchanged; `schedule` and `tz` remain `z.string()`.

#### Scenario: Cron TriggerSource receives plaintext schedule from sentinel reference

- **GIVEN** a workflow with `env: { S: env({ secret: true }) }` and `cronTrigger({ schedule: wf.env.S, tz: "UTC", … })`
- **AND** the CLI uploaded the workflow with `process.env.S = "*/5 * * * *"`
- **WHEN** the registry installs the workflow
- **THEN** `cronTriggerSource.reconfigure` SHALL receive an entry whose `descriptor.schedule` equals `"*/5 * * * *"`
- **AND** the cron source SHALL register a timer keyed on that schedule string

#### Scenario: Cron TriggerSource never observes sentinel bytes

- **GIVEN** any workflow declaring cron triggers with sentinel-referenced schedules
- **WHEN** `cronTriggerSource.reconfigure` is called
- **THEN** no string field reachable from the entries argument SHALL contain the byte sequence `\x00secret:`
