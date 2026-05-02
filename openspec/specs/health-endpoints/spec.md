## Purpose

Expose IETF-shaped HTTP health endpoints (`/livez`, `/healthz`, `/readyz`) so Kubernetes probes and operators can distinguish process liveness, individual dependency health, and aggregate readiness.
## Requirements
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
The eventstore check SHALL execute `eventStore.ping()` (a `SELECT 1` round-trip) against the EventStore. It SHALL report `componentType: "datastore"` and the round-trip duration in milliseconds as `observedValue`.

The check SHALL NOT depend on the contents of the `events` table or on any tenant. A successful ping confirms DB connectivity and read latency without scanning rows.

#### Scenario: Eventstore check passes
- **GIVEN** the event store is responsive
- **WHEN** the eventstore check runs
- **THEN** it SHALL invoke `eventStore.ping()`
- **AND** SHALL return `"status":"pass"` with the round-trip duration in ms as `observedValue`

#### Scenario: Eventstore check fails
- **GIVEN** the event store ping throws an error (DuckDB unavailable or query error)
- **WHEN** the eventstore check runs
- **THEN** it SHALL return `"status":"fail"` with the error message in `"output"`

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

### Requirement: Readiness response includes version.gitSha

The `GET /readyz` response body SHALL include a `version` object whose `gitSha` field reflects the build SHA baked into the running image at build time, sourced from the `APP_GIT_SHA` environment variable. The Dockerfile SHALL accept a `GIT_SHA` build-arg and bake it into the image as `ENV APP_GIT_SHA=${GIT_SHA}`. When `APP_GIT_SHA` is unset (e.g. `pnpm dev` without `GIT_SHA`), `gitSha` SHALL be the literal string `"dev"`.

This contract SHALL be load-bearing for the `ci-workflow` capability's "Staging readiness gate before upload" requirement, which polls `/readyz` until `version.gitSha === <github.sha>` to detect that the auto-update timer has rotated to the new image before running `wfe upload`.

#### Scenario: gitSha matches the built image

- **GIVEN** the image is built with `GIT_SHA=abc123`
- **WHEN** an HTTP client requests `GET /readyz` against the running container
- **THEN** the response body's `version.gitSha` SHALL equal `"abc123"`

#### Scenario: gitSha defaults to "dev" in local development

- **GIVEN** the runtime is started via `pnpm dev` with `APP_GIT_SHA` unset
- **WHEN** an HTTP client requests `GET /readyz`
- **THEN** the response body's `version.gitSha` SHALL equal `"dev"`

#### Scenario: gitSha appears on success and failure responses

- **GIVEN** the readiness endpoint can return `200` (pass) or `503` (fail)
- **WHEN** either response is returned
- **THEN** the body SHALL contain `version.gitSha` regardless of overall status

