## MODIFIED Requirements

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

### Requirement: runQueue sharing with other triggers

Cron ticks SHALL share the per-`(owner, repo, workflow.sha)` runQueue with all other trigger kinds (HTTP, manual, future kinds). When the runQueue is busy, each cron tick SHALL enqueue `executor.invoke` without coalescing and without dropping. The archive SHALL record one entry per enqueued tick, reflecting every fire.

#### Scenario: Cron tick enqueues behind a long HTTP invocation

- **GIVEN** a workflow in `(acme, foo)` with both a cron trigger (`schedule: "* * * * *"`) and an HTTP trigger
- **AND** an HTTP invocation is in-flight holding the runQueue for 90 seconds
- **WHEN** two cron ticks fire during those 90 seconds
- **THEN** both ticks SHALL produce `executor.invoke` calls that enqueue on the runQueue for `(acme, foo, sha)`
- **AND** both SHALL execute sequentially after the HTTP invocation completes
- **AND** the archive SHALL contain two separate cron invocation entries
