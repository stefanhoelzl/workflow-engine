# Cron Trigger Specification

## Purpose

Define the `cronTrigger` SDK factory and its runtime `TriggerSource` implementation. Cron triggers fire workflow invocations on a fixed schedule expressed as a standard 5-field cron expression in an IANA timezone. The cron source shares the per-`(tenant, workflow.sha)` runQueue with other trigger kinds; missed ticks across restarts are silent by design; horizontal scaling is out of scope for v1.
## Requirements
### Requirement: cronTrigger factory creates branded CronTrigger

The SDK SHALL export a `cronTrigger(config)` factory that returns a `CronTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/cron-trigger")` AND callable as `() => Promise<unknown>`. Invoking the callable SHALL run the user-supplied `handler()` and return its result (the return value is discarded by the cron source but preserved for callable-style usage in tests).

The config SHALL require:
- `schedule`: string — a standard 5-field cron expression. The SDK SHALL constrain this field at the TypeScript type level using `ts-cron-validator`'s `validStandardCronExpression` template-literal type so invalid expressions fail at compile time.
- `handler`: `() => Promise<unknown>` — async handler invoked on every tick.

The config SHALL accept optional:
- `tz`: string — an IANA timezone identifier. If omitted, the SDK factory SHALL resolve the default at construction time via `Intl.DateTimeFormat().resolvedOptions().timeZone`. Because the vite-plugin evaluates workflow bundles in Node (`node:vm`) to discover branded exports, this resolution happens on the build host and the resulting `tz` reflects the build host's IANA zone (not the QuickJS `"UTC"` default). No AST transform is required.

The returned value SHALL expose `schedule`, `tz`, `inputSchema`, `outputSchema` as readonly own properties. `inputSchema` SHALL be `z.object({})` (cron handlers receive no payload). `outputSchema` SHALL be `z.unknown()`. The captured `handler` SHALL NOT be exposed as a public property.

#### Scenario: cronTrigger returns branded callable

- **GIVEN** `const t = cronTrigger({ schedule: "0 9 * * *", handler: async () => {} })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[CRON_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.schedule`, `t.tz`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: cronTrigger callable invokes the handler

- **GIVEN** `const t = cronTrigger({ schedule: "* * * * *", handler: async () => "ok" })`
- **WHEN** `await t({})` is called
- **THEN** the handler SHALL be invoked and the return value SHALL be `"ok"`

#### Scenario: Handler receives empty payload

- **WHEN** a cron tick fires and the handler is invoked
- **THEN** the handler SHALL be called with no arguments (or an empty `{}` payload)
- **AND** the handler signature `() => Promise<unknown>` SHALL satisfy the author contract

#### Scenario: Invalid schedule fails at TypeScript compile time

- **GIVEN** `cronTrigger({ schedule: "not a cron", handler: async () => {} })`
- **WHEN** the workflow file is type-checked
- **THEN** TypeScript SHALL reject the call with a type error on the `schedule` argument

### Requirement: Cron TriggerSource native implementation

The runtime SHALL implement a `TriggerSource<"cron">` at `packages/runtime/src/triggers/cron.ts`. The source SHALL maintain per-entry `setTimeout` handles keyed on `(owner, repo, descriptor.name)`, stored internally so that `reconfigure(owner, repo, entries)` can clear only the specified `(owner, repo)`'s timers without touching other scopes'.

On `reconfigure(owner, repo, entries)`, the source SHALL cancel every pending timer for that `(owner, repo)` pair and re-arm from scratch using the provided entries. An empty `entries` array SHALL leave the `(owner, repo)` with no timers. Sibling repos under the same owner SHALL NOT be affected.

For each entry, the source SHALL compute the next fire time using `cron-parser`'s `nextDate(now, tz)`. If the computed delay `Δ` exceeds 24 hours, the source SHALL clamp the `setTimeout` to 24 hours and, on wake, recompute `Δ` from the current clock before re-arming. On fire, the source SHALL call `entry.fire({})` and, regardless of the invocation outcome (`{ok: true}` or `{ok: false}`), SHALL compute and arm the next tick from the current clock.

The source SHALL NOT call `executor.invoke` directly. The empty `{}` input is validated against `descriptor.inputSchema` (which is `{}` for cron by construction) inside the `fire` closure by the registry's `buildFire` helper.

`start()` and `stop()` SHALL be no-op scaffolding; all scheduling state is managed via `reconfigure()`. `stop()` SHALL cancel every pending timer across all `(owner, repo)` pairs.

The source's `reconfigure` SHALL return `Promise<ReconfigureResult>`. For in-memory timer scheduling there are no user-config error cases — invalid cron syntax is caught at manifest-parse time by the `@core` Zod schema. The cron source SHALL therefore always return `{ok: true}` unless an unexpected exception occurs (which throws to signal backend-infra failure).

#### Scenario: reconfigure cancels and rearms for one (owner, repo)

- **GIVEN** a cron source with armed timers for `(acme, foo)` (triggers A, B) and `(acme, bar)` (trigger C)
- **WHEN** `reconfigure("acme", "foo", [entryA])` is called
- **THEN** `(acme, foo)`'s timers for A and B SHALL be cancelled
- **AND** a fresh timer SHALL be armed for A
- **AND** `(acme, bar)`'s timer for C SHALL NOT be affected

#### Scenario: Sibling scope unaffected across reconfigure

- **GIVEN** a cron source with armed timers for `(alice, utils)` and `(alice, tools)`
- **WHEN** `reconfigure("alice", "utils", [])` is called
- **THEN** all `(alice, utils)` timers SHALL be cancelled
- **AND** `(alice, tools)` timers SHALL remain armed unchanged

#### Scenario: Tick fires entry.fire with empty input

- **GIVEN** an armed cron trigger whose next fire is now
- **WHEN** the timer fires
- **THEN** the source SHALL call `entry.fire({})` exactly once
- **AND** the source SHALL arm the next tick regardless of the returned `InvokeResult` outcome

#### Scenario: stop cancels all timers across scopes

- **GIVEN** a cron source with N armed timers spread across multiple `(owner, repo)` pairs
- **WHEN** `stop()` is called
- **THEN** all N timers SHALL be cancelled
- **AND** no further ticks SHALL fire
### Requirement: Missed ticks on restart are silent

On process restart (or fresh `reconfigure(view)` without prior state), the cron source SHALL compute `nextDate(now, tz)` for each entry and arm `setTimeout` for that instant. Ticks that would have fired before `now` SHALL NOT be fired. The source SHALL NOT emit a "missed tick" lifecycle event, SHALL NOT log per-missed-tick warnings, and SHALL NOT persist `lastFiredAt` state.

#### Scenario: Tick scheduled for 09:00 is lost across a 09:00-spanning restart

- **GIVEN** a cron trigger with `schedule: "0 9 * * *"` in `tz: "UTC"`
- **AND** the engine was down from 08:59 to 09:02 UTC
- **WHEN** the engine restarts and the cron source runs `reconfigure(view)`
- **THEN** the source SHALL compute `nextDate(09:02 UTC, "UTC")` which resolves to tomorrow 09:00
- **AND** the source SHALL arm a timer for tomorrow 09:00
- **AND** no invocation SHALL fire for today's 09:00 tick
- **AND** no missed-tick event SHALL be emitted to the event bus

### Requirement: runQueue sharing with other triggers

Cron ticks SHALL share the per-`(owner, repo, workflow.sha)` runQueue with all other trigger kinds (HTTP, manual, future kinds). When the runQueue is busy, each cron tick SHALL enqueue `executor.invoke` without coalescing and without dropping. The archive SHALL record one entry per enqueued tick, reflecting every fire.

#### Scenario: Cron tick enqueues behind a long HTTP invocation

- **GIVEN** a workflow in `(acme, foo)` with both a cron trigger (`schedule: "* * * * *"`) and an HTTP trigger
- **AND** an HTTP invocation is in-flight holding the runQueue for 90 seconds
- **WHEN** two cron ticks fire during those 90 seconds
- **THEN** both ticks SHALL produce `executor.invoke` calls that enqueue on the runQueue for `(acme, foo, sha)`
- **AND** both SHALL execute sequentially after the HTTP invocation completes
- **AND** the archive SHALL contain two separate cron invocation entries
### Requirement: DST semantics inherited from cron-parser

Cron tick computation SHALL delegate to `cron-parser`'s `nextDate(now, tz)`, which handles DST transitions as follows: local times that do not exist (spring-forward skipped hour) SHALL resolve to the next existing instant; local times that occur twice (fall-back repeated hour) SHALL fire exactly once. The runtime SHALL NOT wrap or alter this behavior.

#### Scenario: Spring-forward skipped local time

- **GIVEN** a trigger with `schedule: "0 2 * * *"` in `tz: "Europe/Berlin"`
- **AND** the current day is the DST spring-forward day where 02:00 does not exist
- **WHEN** the source computes the next fire
- **THEN** the next fire SHALL resolve to the same day's 03:00 local (the next existing instant matching the schedule)

#### Scenario: Fall-back repeated local time fires once

- **GIVEN** a trigger with `schedule: "0 2 * * *"` in `tz: "Europe/Berlin"`
- **AND** the current day is the DST fall-back day where 02:00 occurs twice
- **WHEN** the source computes fires across the transition
- **THEN** 02:00 SHALL fire exactly once (not twice)

### Requirement: Single-instance scheduling assumption

Cron triggers SHALL assume exactly one runtime instance. Running ≥2 instances with overlapping tenant views will fire every tick ≥2 times. The spec intentionally does not require leader-election or distributed coordination; horizontal scaling of the runtime is out of scope for v1.

#### Scenario: Two runtime instances double-fire

- **GIVEN** two runtime instances A and B, both loaded with the same tenant bundle containing a cron trigger
- **WHEN** a scheduled tick time arrives
- **THEN** both A and B SHALL fire `executor.invoke` independently
- **AND** the spec SHALL NOT require deduplication

### Requirement: Manual fire via /trigger UI bypasses the source

The `/trigger` UI's "Run now" action for a cron trigger SHALL resolve the corresponding `TriggerEntry` from the cron source's internal index (via a small read-only accessor) and call `entry.fire({})`. The cron source SHALL NOT be involved in the manual fire path beyond exposing the entry. Scheduled timers SHALL continue to run in parallel with manual fires; a manual fire during a pending scheduled tick SHALL produce a separate invocation via the runQueue.

#### Scenario: Run now produces an invocation without disturbing the schedule

- **GIVEN** a cron trigger with a scheduled timer armed for 60 seconds in the future
- **WHEN** the user clicks "Run now" in the trigger UI
- **THEN** `entry.fire({})` SHALL be called exactly once
- **AND** the armed timer SHALL NOT be cancelled or rescheduled
- **AND** when the armed timer fires, a second `entry.fire({})` call SHALL occur
