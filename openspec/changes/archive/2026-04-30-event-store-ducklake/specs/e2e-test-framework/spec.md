## MODIFIED Requirements

### Requirement: 19 end-to-end tests

The framework SHALL ship the following end-to-end tests, each testing one invariant that cannot be covered by in-process or unit tests:

1. Sealed secret round-trip + log redaction
2. Cold start from DuckLake catalog (committed invocations remain queryable across graceful restart)
3. Graceful SIGTERM drain (in-flight invocation surfaces as a `trigger.error{kind:"shutdown"}` synthetic terminal in the archive after respawn)
4. Health endpoint shape
5. Workflow re-upload + sandbox eviction log line
6. Multi-backend reconfigure (one workflow registers http + cron)
7. Sandbox LRU eviction under count pressure (`SANDBOX_MAX_COUNT=2`)
8. Cross-owner 404 isolation (API + dashboard)
9. Local login + signout (Playwright)
10. Dashboard renders invocation row (Playwright)
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
21. CHECKPOINT survives restart (multiple invocations across DuckLake checkpoint cycles remain queryable after respawn)

The previous "SIGKILL crash recovery (engine_crashed event after respawn)" test is removed. Under `event-store-ducklake`, the per-event WAL is gone and SIGKILL during an in-flight invocation deliberately loses it — there is no `engine_crashed` synthetic terminal to assert on. The graceful-shutdown contract is exercised by the rewritten test #3 (SIGTERM synthesises `trigger.error{kind:"shutdown"}`); the durable round-trip contract is exercised by the new test #2 (cold start from catalog).

#### Scenario: Each test exists

- **WHEN** the suite is fully implemented
- **THEN** every test in the list SHALL exist under `packages/tests/test/`
- **AND** each SHALL pass under `pnpm test:e2e`

#### Scenario: Each test is single-feature, E2E-only

- **WHEN** a test is added to the suite
- **THEN** the test SHALL exercise exactly one runtime invariant whose failure mode requires the spawn → upload → fire → archive lifecycle
- **AND** the assertion SHALL be on the resulting `state.events` (or `state.fetches` / `state.responses`) shape — not on an in-process detail that would be cheaper to unit-test
