## RENAMED Requirements

- FROM: `### Requirement: Event source via filesystem polling`
- TO: `### Requirement: Event source via the persisted event store`

## MODIFIED Requirements

### Requirement: Event source via the persisted event store

`state.events` and `.waitForEvent` SHALL source committed invocation events from the spawned child's libSQL database (`<persistencePath>/events.db`) by opening a **second** `@libsql/client` read connection on that file (WAL mode permits concurrent readers alongside the live runtime) and querying the `events` table. The framework SHALL NOT copy or snapshot the database file, and SHALL NOT subscribe to runtime log lines for invocation events. Only committed events are observable — events still held in the EventStore's in-memory accumulator for an in-flight invocation are not yet on disk and therefore are not visible to the harness (consistent with the `event-store` accumulator/commit-on-terminal model).

#### Scenario: Events read from the libSQL database

- **WHEN** an `.expect` callback reads `state.events`
- **THEN** the framework SHALL query the `events` table via a second `@libsql/client` read connection on `<persistencePath>/events.db`
- **AND** SHALL return the parsed events

#### Scenario: No log-line subscription for events

- **WHEN** the runtime emits an `invocation.completed` log line
- **THEN** the framework SHALL NOT use that line as a sync point for `.waitForEvent`
- **AND** the test's view of events SHALL come exclusively from reads of the libSQL database

### Requirement: 19 end-to-end tests

The framework SHALL ship the following end-to-end tests, each testing one invariant that cannot be covered by in-process or unit tests:

1. Sealed secret round-trip + log redaction
2. Cold start from the libSQL event store (committed invocations remain queryable across graceful restart)
3. Graceful SIGTERM drain (in-flight invocation surfaces as a `trigger.error{kind:"shutdown"}` synthetic terminal in the archive after respawn)
4. Health endpoint shape
5. Workflow re-upload + sandbox eviction log line
6. Multi-backend reconfigure (one workflow registers http + cron)
7. Sandbox LRU eviction under count pressure (`SANDBOX_MAX_COUNT=2`)
8. Cross-owner 404 isolation (API + invocations view)
9. Local login + signout (Playwright)
10. Invocations view renders invocation row (Playwright)
11. Trigger UI manual-fire (Playwright)
12. SQL TLS handshake against embedded-postgres
13. SQL `statement_timeout` cancellation
14. Plain env literal round-trip
15. httpTrigger protocol adapter (headers, query, body, response shape, 422)
16. cronTrigger fires (real wall-clock)
17. fetch SSRF guard rejects loopback
18. sendMail happy path + SMTP password log redaction
19. Owner/repo scoping (same workflow name under multiple `(owner, repo)` tuples)
20. wsTrigger protocol adapter

The previous "SIGKILL crash recovery (engine_crashed event after respawn)" test is removed: the per-event WAL is gone and SIGKILL during an in-flight invocation deliberately loses it — there is no `engine_crashed` synthetic terminal to assert on. The former "CHECKPOINT survives restart" test is also removed: libSQL has no application-visible checkpoint cycle to exercise. The graceful-shutdown contract is exercised by test #3 (SIGTERM synthesises `trigger.error{kind:"shutdown"}`); the durable round-trip contract is exercised by test #2 (cold start from the libSQL event store).

#### Scenario: Each test exists

- **WHEN** the suite is fully implemented
- **THEN** every test in the list SHALL exist under `packages/tests/test/`
- **AND** each SHALL pass under `pnpm test:e2e`

#### Scenario: Each test is single-feature, E2E-only

- **WHEN** a test is added to the suite
- **THEN** the test SHALL exercise exactly one runtime invariant whose failure mode requires the spawn → upload → fire → archive lifecycle
