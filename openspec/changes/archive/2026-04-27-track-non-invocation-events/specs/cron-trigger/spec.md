## ADDED Requirements

### Requirement: Cron arm-time failure emits trigger.exception

When the cron source's `arm()` function calls `computeNextDelay(descriptor.schedule, descriptor.tz, now)` and that call throws (invalid schedule that escaped manifest-parse validation, unsupported timezone string, DST corner case rejected by the underlying parser), the source SHALL — in addition to the existing `logger.error("cron.schedule-invalid", ...)` — invoke `entry.exception({ name: "cron.schedule-invalid", error: { message }, input: { schedule: descriptor.schedule, tz: descriptor.tz } })` exactly once per failed `arm()` invocation. The timer SHALL remain unarmed (existing behaviour) and the entry SHALL NOT fire until the next successful `reconfigure()` provides a valid schedule.

Because `arm()` is the single shared entry point for cold boot, post-fire re-arm, and `reconfigure()`-triggered re-arm, this single emission site covers all three paths. No additional emission sites SHALL be added.

`entry.exception` is the per-trigger callable bound to `executor.fail` by the registry's `buildException` helper (see `executor/spec.md` "Executor.fail emits trigger.exception leaf events"). The cron source SHALL NOT emit `trigger.exception` events directly via the bus.

#### Scenario: Cold-boot arm with invalid timezone emits trigger.exception

- **GIVEN** a registered cron entry with `tz: "Not/A_Zone"` that escapes manifest validation
- **WHEN** the runtime boots and the cron source attempts to `arm()` the entry
- **THEN** `computeNextDelay` SHALL throw
- **AND** `logger.error("cron.schedule-invalid", ...)` SHALL be called
- **AND** `entry.exception({ name: "cron.schedule-invalid", error: { message: <…> }, input: { schedule, tz: "Not/A_Zone" } })` SHALL be called exactly once
- **AND** no `setTimeout` SHALL be armed for the entry
- **AND** the bus SHALL receive exactly one `trigger.exception` event with `name: "cron.schedule-invalid"`

#### Scenario: Re-upload swapping in a bad schedule emits trigger.exception

- **GIVEN** a previously-armed cron entry whose `(owner, repo)` is reconfigured with a new descriptor whose schedule causes `computeNextDelay` to throw
- **WHEN** `reconfigure(owner, repo, [newEntry])` runs and arms the new entry
- **THEN** the prior timer SHALL be cancelled (existing behaviour)
- **AND** `entry.exception({ name: "cron.schedule-invalid", ... })` SHALL be called exactly once for the new entry
- **AND** no fresh timer SHALL be armed for the new entry

#### Scenario: Post-fire re-arm catching a hot-swapped bad schedule emits trigger.exception

- **GIVEN** a cron entry whose schedule was hot-swapped to an invalid value while the previous tick was firing
- **WHEN** the post-fire re-arm path calls `arm()` and `computeNextDelay` throws
- **THEN** `entry.exception({ name: "cron.schedule-invalid", ... })` SHALL be called exactly once
- **AND** no fresh timer SHALL be armed for the entry
