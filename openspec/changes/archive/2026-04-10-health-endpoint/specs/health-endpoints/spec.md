## ADDED Requirements

### Requirement: Liveness endpoint
The runtime SHALL expose a `GET /livez` endpoint that always returns HTTP `200` with `Content-Type: application/health+json` and body `{"status":"pass"}`.

#### Scenario: Server is alive
- **WHEN** `GET /livez` is requested
- **THEN** the response status SHALL be `200`
- **AND** the `Content-Type` header SHALL be `application/health+json`
- **AND** the response body SHALL be `{"status":"pass"}`

### Requirement: Readiness endpoint
The runtime SHALL expose a `GET /readyz` endpoint that runs all dependency checks (eventstore, persistence:write, persistence:read, persistence:list, webhooks, domain) sequentially with a hardcoded 5-second per-check timeout. It SHALL return HTTP `200` with `{"status":"pass"}` when all checks pass, or HTTP `503` with `{"status":"fail","checks":{...}}` when any check fails. Unconfigured dependencies (no storage backend, no `BASE_URL`) SHALL be reported as failures.

#### Scenario: All dependencies healthy
- **GIVEN** a storage backend is configured, `BASE_URL` is set, triggers are registered, and all dependencies are responsive
- **WHEN** `GET /readyz` is requested
- **THEN** the response status SHALL be `200`
- **AND** the body SHALL contain `"status":"pass"` with all checks reporting `"status":"pass"`

#### Scenario: Storage backend not configured
- **GIVEN** no storage backend is configured
- **WHEN** `GET /readyz` is requested
- **THEN** the response status SHALL be `503`
- **AND** `persistence:write`, `persistence:read`, and `persistence:list` checks SHALL report `"status":"fail"` with `"output":"no backend configured"`

#### Scenario: BASE_URL not configured
- **GIVEN** `BASE_URL` is not set
- **WHEN** `GET /readyz` is requested
- **THEN** the response status SHALL be `503`
- **AND** `webhooks` and `domain` checks SHALL report `"status":"fail"` with `"output":"BASE_URL not configured"`

#### Scenario: Dependency check times out
- **GIVEN** a dependency takes longer than 5 seconds to respond
- **WHEN** `GET /readyz` is requested
- **THEN** the timed-out check SHALL report `"status":"fail"` with `"output":"timeout after 5000ms"`
- **AND** the `observedValue` SHALL be `5000` and `observedUnit` SHALL be `"ms"`

#### Scenario: Readiness accepts no query parameters
- **WHEN** `GET /readyz?timeout=1000` is requested
- **THEN** the timeout parameter SHALL be ignored
- **AND** the hardcoded 5-second timeout SHALL be used

### Requirement: IETF health check endpoint
The runtime SHALL expose a `GET /healthz` endpoint following the IETF Health Check Response Format (draft-inadarei-api-health-check-06). Without query parameters, it SHALL behave identically to `/livez`. With query parameters, it SHALL run the requested deep checks sequentially.

#### Scenario: Shallow health check (no params)
- **WHEN** `GET /healthz` is requested without query parameters
- **THEN** the response SHALL be identical to `GET /livez`: HTTP `200`, `{"status":"pass"}`

#### Scenario: Single deep check requested
- **WHEN** `GET /healthz?eventstore=true` is requested
- **THEN** only the eventstore check SHALL run
- **AND** the response SHALL include `"checks":{"eventstore":[...]}`

#### Scenario: Multiple deep checks requested
- **WHEN** `GET /healthz?eventstore=true&persistence=true&domain=true&webhooks=true` is requested
- **THEN** all requested checks SHALL run sequentially
- **AND** each check result SHALL appear in the `"checks"` object

#### Scenario: Custom timeout
- **WHEN** `GET /healthz?eventstore=true&timeout=2000` is requested
- **THEN** the per-check timeout SHALL be `2000ms` instead of the default `5000ms`

#### Scenario: All requested checks pass
- **WHEN** deep checks are requested and all pass
- **THEN** the response status SHALL be `200` with `"status":"pass"`

#### Scenario: Any requested check fails
- **WHEN** deep checks are requested and at least one fails
- **THEN** the response status SHALL be `503` with `"status":"fail"`

### Requirement: IETF response format
All health endpoint responses SHALL use `Content-Type: application/health+json`. The response body SHALL be a JSON object with a `status` field (`"pass"` or `"fail"`). When deep checks are performed, the response SHALL include a `checks` object where each key is a check name and each value is an array containing a single object with `status`, `componentType`, and optionally `observedValue`, `observedUnit`, and `output` fields.

#### Scenario: Check result with observed value
- **GIVEN** a deep check completes successfully in 3ms
- **THEN** the check result SHALL include `"status":"pass"`, `"observedValue":3`, `"observedUnit":"ms"`

#### Scenario: Check result with failure output
- **GIVEN** a deep check fails with message "no backend configured"
- **THEN** the check result SHALL include `"status":"fail"`, `"output":"no backend configured"`

#### Scenario: Check result with timeout
- **GIVEN** a deep check times out after 5000ms
- **THEN** the check result SHALL include `"status":"fail"`, `"observedValue":5000`, `"observedUnit":"ms"`, `"output":"timeout after 5000ms"`

### Requirement: Eventstore deep check
The eventstore check SHALL execute `SELECT count(*) FROM events` via the EventStore `query` property using Kysely's `fn.countAll()`. It SHALL report `componentType: "datastore"` and the query duration in milliseconds as `observedValue`.

#### Scenario: Eventstore check passes
- **GIVEN** the event store is responsive
- **WHEN** the eventstore check runs
- **THEN** it SHALL return `"status":"pass"` with the query duration in ms

#### Scenario: Eventstore check fails
- **GIVEN** the event store query throws an error
- **WHEN** the eventstore check runs
- **THEN** it SHALL return `"status":"fail"` with the error message in `"output"`

### Requirement: Persistence write deep check
The persistence:write check SHALL write a sentinel file to `.healthz/sentinel` on the storage backend. It SHALL report `componentType: "datastore"` and the write duration in milliseconds. If no storage backend is configured, it SHALL report `"status":"fail"` with `"output":"no backend configured"`.

#### Scenario: Persistence write succeeds
- **GIVEN** a storage backend is configured and responsive
- **WHEN** the persistence:write check runs
- **THEN** it SHALL write to `.healthz/sentinel` and return `"status":"pass"` with write duration

#### Scenario: No storage backend configured
- **WHEN** the persistence:write check runs without a configured backend
- **THEN** it SHALL return `"status":"fail"` with `"output":"no backend configured"`

### Requirement: Persistence read deep check
The persistence:read check SHALL read the `.healthz/sentinel` file from the storage backend. It SHALL report `componentType: "datastore"` and the read duration in milliseconds. If no storage backend is configured, it SHALL report `"status":"fail"` with `"output":"no backend configured"`.

#### Scenario: Persistence read succeeds
- **GIVEN** a storage backend is configured and `.healthz/sentinel` exists
- **WHEN** the persistence:read check runs
- **THEN** it SHALL read `.healthz/sentinel` and return `"status":"pass"` with read duration

#### Scenario: No storage backend configured
- **WHEN** the persistence:read check runs without a configured backend
- **THEN** it SHALL return `"status":"fail"` with `"output":"no backend configured"`

### Requirement: Persistence list deep check
The persistence:list check SHALL call `list("pending/")` on the storage backend and consume the async iterator. It SHALL report `componentType: "datastore"` and the list duration in milliseconds. If no storage backend is configured, it SHALL report `"status":"fail"` with `"output":"no backend configured"`.

#### Scenario: Persistence list succeeds
- **GIVEN** a storage backend is configured
- **WHEN** the persistence:list check runs
- **THEN** it SHALL list `pending/` and return `"status":"pass"` with list duration

#### Scenario: No storage backend configured
- **WHEN** the persistence:list check runs without a configured backend
- **THEN** it SHALL return `"status":"fail"` with `"output":"no backend configured"`

### Requirement: Webhooks deep check
The webhooks check SHALL fetch `BASE_URL + "/webhooks/"` and verify the response status is `204`. It SHALL report `componentType: "component"` and the response duration in milliseconds. If `BASE_URL` is not configured, it SHALL report `"status":"fail"` with `"output":"BASE_URL not configured"`.

#### Scenario: Webhooks check passes
- **GIVEN** `BASE_URL` is set and triggers are registered
- **WHEN** the webhooks check runs
- **THEN** it SHALL return `"status":"pass"` with response duration

#### Scenario: Webhooks endpoint returns 503
- **GIVEN** `BASE_URL` is set but no triggers are registered
- **WHEN** the webhooks check runs
- **THEN** it SHALL return `"status":"fail"` with `"output"` containing the unexpected status

#### Scenario: BASE_URL not configured
- **WHEN** the webhooks check runs without `BASE_URL`
- **THEN** it SHALL return `"status":"fail"` with `"output":"BASE_URL not configured"`

### Requirement: Domain deep check
The domain check SHALL fetch `BASE_URL + "/healthz"` and verify: the response status is `200` AND the parsed response body contains `"status":"pass"`. It SHALL report `componentType: "system"` and the response duration in milliseconds. If `BASE_URL` is not configured, it SHALL report `"status":"fail"` with `"output":"BASE_URL not configured"`. The check SHALL respect the protocol in `BASE_URL` (HTTP or HTTPS).

#### Scenario: Domain check passes
- **GIVEN** `BASE_URL` is set and the service is reachable
- **WHEN** the domain check runs
- **THEN** it SHALL return `"status":"pass"` with response duration

#### Scenario: Domain check fails on non-200 status
- **GIVEN** `BASE_URL` is set but the service returns a non-200 status
- **WHEN** the domain check runs
- **THEN** it SHALL return `"status":"fail"` with `"output"` containing the unexpected status

#### Scenario: Domain check fails on invalid body
- **GIVEN** `BASE_URL` is set and returns HTTP 200 but body does not contain `"status":"pass"`
- **WHEN** the domain check runs
- **THEN** it SHALL return `"status":"fail"` with `"output"` indicating unexpected response body

#### Scenario: BASE_URL not configured
- **WHEN** the domain check runs without `BASE_URL`
- **THEN** it SHALL return `"status":"fail"` with `"output":"BASE_URL not configured"`

### Requirement: Health middleware factory
The health endpoints SHALL be implemented as a Hono middleware factory `healthMiddleware(deps)` in `packages/runtime/src/health.ts`. It SHALL accept dependencies: `eventStore` (EventStore), `storageBackend` (StorageBackend | undefined), and `baseUrl` (string | undefined). It SHALL return a `Middleware` compatible with `createServer`.

#### Scenario: Middleware mounts all health routes
- **GIVEN** a health middleware created with all dependencies
- **WHEN** mounted in the Hono app
- **THEN** `/livez`, `/readyz`, and `/healthz` SHALL all be routable
