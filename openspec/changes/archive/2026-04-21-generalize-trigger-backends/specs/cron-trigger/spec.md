## MODIFIED Requirements

### Requirement: Cron TriggerSource native implementation

The runtime SHALL implement a `TriggerSource<"cron">` at `packages/runtime/src/triggers/cron.ts`. The source SHALL maintain per-entry `setTimeout` handles keyed on `(tenant, descriptor.name)`, stored internally so that `reconfigure(tenant, entries)` can clear only the specified tenant's timers without touching other tenants'.

On `reconfigure(tenant, entries)`, the source SHALL cancel every pending timer for that tenant and re-arm from scratch using the provided entries. An empty `entries` array SHALL leave the tenant with no timers.

For each entry, the source SHALL compute the next fire time using `cron-parser`'s `nextDate(now, tz)`. If the computed delay `Δ` exceeds 24 hours, the source SHALL clamp the `setTimeout` to 24 hours and, on wake, recompute `Δ` from the current clock before re-arming. On fire, the source SHALL call `entry.fire({})` and, regardless of the invocation outcome (`{ok: true}` or `{ok: false}`), SHALL compute and arm the next tick from the current clock.

The source SHALL NOT call `executor.invoke` directly. The empty `{}` input is validated against `descriptor.inputSchema` (which is `{}` for cron by construction) inside the `fire` closure by the registry's `buildFire` helper.

`start()` and `stop()` SHALL be no-op scaffolding; all scheduling state is managed via `reconfigure()`. `stop()` SHALL cancel every pending timer across all tenants.

The source's `reconfigure` SHALL return `Promise<ReconfigureResult>`. For in-memory timer scheduling there are no user-config error cases — invalid cron syntax is caught at manifest-parse time by the `@core` Zod schema, not during reconfigure. The cron source SHALL therefore always return `{ok: true}` unless an unexpected exception occurs (which throws to signal backend-infra failure).

#### Scenario: reconfigure cancels and rearms for one tenant

- **GIVEN** a cron source with armed timers for tenants `acme` (triggers A, B) and `globex` (trigger C)
- **WHEN** `reconfigure("acme", [entryA])` is called
- **THEN** `acme`'s timers for A and B SHALL be cancelled
- **AND** a fresh timer SHALL be armed for A
- **AND** `globex`'s timer for C SHALL NOT be affected

#### Scenario: Tick fires entry.fire with empty input

- **GIVEN** an armed cron trigger whose next fire is now
- **WHEN** the timer fires
- **THEN** the source SHALL call `entry.fire({})` exactly once
- **AND** the source SHALL arm the next tick regardless of the returned `InvokeResult` outcome

#### Scenario: stop cancels all timers across tenants

- **GIVEN** a cron source with N armed timers spread across multiple tenants
- **WHEN** `stop()` is called
- **THEN** all N timers SHALL be cancelled
- **AND** no further ticks SHALL fire

#### Scenario: reconfigure returns ok for in-memory scheduling

- **GIVEN** a cron source receiving a valid `reconfigure(tenant, entries)` call
- **WHEN** the timers are armed successfully
- **THEN** the source SHALL resolve to `{ok: true}`
- **AND** the source SHALL NOT return `{ok: false}` for cases caught earlier in the pipeline (invalid cron syntax, invalid tz — those are Zod-validation failures at manifest parse)

### Requirement: Manual fire via /trigger UI bypasses the source

The `/trigger` UI's "Run now" action for a cron trigger SHALL resolve the corresponding `TriggerEntry` from the cron source's internal index (via a small read-only accessor) and call `entry.fire({})`. The cron source SHALL NOT be involved in the manual fire path beyond exposing the entry. Scheduled timers SHALL continue to run in parallel with manual fires; a manual fire during a pending scheduled tick SHALL produce a separate invocation via the runQueue.

#### Scenario: Run now produces an invocation without disturbing the schedule

- **GIVEN** a cron trigger with a scheduled timer armed for 60 seconds in the future
- **WHEN** the user clicks "Run now" in the trigger UI
- **THEN** `entry.fire({})` SHALL be called exactly once
- **AND** the armed timer SHALL NOT be cancelled or rescheduled
- **AND** when the armed timer fires, a second `entry.fire({})` call SHALL occur
