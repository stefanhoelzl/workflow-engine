## ADDED Requirements

### Requirement: Shutdown completion log line

The runtime SHALL emit a structured log line `{msg: "shutdown.complete", code, durationMs}` at the end of its shutdown handler, after `Promise.allSettled` of all service stops, immediately before `process.exit(code)`.

#### Scenario: Graceful shutdown emits shutdown.complete

- **GIVEN** a running runtime
- **WHEN** the process receives SIGTERM (or SIGINT) and all services stop cleanly
- **THEN** the runtime SHALL emit a single info-level log line via `runtimeLogger.info("shutdown.complete", {code: 0, durationMs: <total drain time in ms>})`
- **AND** the line SHALL appear on stdout BEFORE the process exits
- **AND** `durationMs` SHALL measure the time from signal receipt (or fatal-error trigger) until just before `process.exit`

#### Scenario: Forced shutdown also emits shutdown.complete

- **GIVEN** a running runtime
- **WHEN** the shutdown sequence completes with a non-zero exit code (e.g. fatal service error)
- **THEN** the runtime SHALL still emit `shutdown.complete` with the appropriate `code` and `durationMs` before exiting
- **AND** the line SHALL be the LAST log line emitted before exit

#### Scenario: Line position is load-bearing for E2E tests

- **WHEN** the e2e SIGTERM-drain test sends SIGTERM and observes the child's stdout
- **THEN** the test SHALL await the `shutdown.complete` line as the synchronization signal that graceful shutdown finished
- **AND** the runtime SHALL guarantee the line is emitted only after all in-flight invocations have either completed or hit the shutdown deadline
