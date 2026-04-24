## ADDED Requirements

### Requirement: Sandbox exposes isActive

The `Sandbox` interface returned by `sandbox(opts)` SHALL expose a read-only `isActive: boolean` property (or getter) that returns `true` iff a `run()` call is currently in flight against the sandbox, and `false` otherwise. The value SHALL be `true` synchronously from the moment `run()` is invoked until the moment its returned promise settles; it SHALL be `false` at every other time, including between runs and after `dispose()`.

This property exists so that out-of-band callers (e.g. a cache reclaiming idle sandboxes) can safely decide whether disposing a sandbox would race an in-flight run. It is a pure read of the sandbox's existing internal concurrent-run guard; it does NOT introduce any new synchronisation, queueing, or refcounting.

#### Scenario: Idle sandbox reports not active

- **GIVEN** a sandbox created via `sandbox(opts)` with no `run()` call in flight
- **WHEN** a caller reads `sandbox.isActive`
- **THEN** it SHALL be `false`

#### Scenario: Running sandbox reports active

- **GIVEN** a sandbox whose `run(name, ctx)` has been invoked and whose returned promise has not yet settled
- **WHEN** a caller reads `sandbox.isActive` between the `run()` call and its resolution
- **THEN** it SHALL be `true`

#### Scenario: Settled run reports not active

- **GIVEN** a sandbox whose `run()` promise has resolved (ok or error)
- **WHEN** a caller reads `sandbox.isActive` after the settlement microtask
- **THEN** it SHALL be `false`
