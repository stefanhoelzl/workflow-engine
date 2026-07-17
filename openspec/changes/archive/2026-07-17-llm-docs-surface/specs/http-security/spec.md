## MODIFIED Requirements

### Requirement: Every HTTP response MUST carry baseline security headers

The runtime SHALL attach the following response headers to every response emitted by the Hono app, regardless of route, status code, or content type:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- `Permissions-Policy` with every browser feature locked to the empty allow-list (`feature=()`), except `clipboard-write=(self)`
- `Content-Security-Policy` as defined in the CSP requirement below
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — subject to the local-deployment gate defined in the HSTS requirement below

#### Scenario: Authenticated HTML route carries every header

- **WHEN** a client requests `/invocations`
- **THEN** the response carries all eight headers listed above with their specified values

#### Scenario: Public webhook response carries every header

- **WHEN** an unauthenticated client posts to `/webhooks/<name>`
- **THEN** the response carries all eight headers (CSP included, even though the response body is JSON)

#### Scenario: API JSON response carries every header

- **WHEN** an authenticated client calls `/api/events`
- **THEN** the response carries all eight headers

#### Scenario: Static asset response carries every header

- **WHEN** a client requests `/static/workflow-engine.css`
- **THEN** the response carries all eight headers

#### Scenario: Liveness probe carries every header

- **WHEN** a client requests `/livez`
- **THEN** the response carries all eight headers

#### Scenario: Public llms.txt index carries every header

- **WHEN** an unauthenticated client requests `/llms.txt`
- **THEN** the response carries all eight headers (CSP included; the text body loads no resources, so `default-src 'none'` is satisfied trivially)

### Requirement: Security-header configuration MUST be unit and integration tested

The runtime SHALL include automated tests that exercise the secure-headers middleware. Unit tests SHALL assert each header's presence and value on a mocked request, and SHALL cover both the `LOCAL_DEPLOYMENT=1` and unset branches. Integration tests SHALL hit at least one route from each family (`/livez`, `/webhooks/*`, `/api/*`, `/invocations`, `/trigger`, `/static/*`, `/llms.txt`) against a running server and assert the full header set.

#### Scenario: Unit test asserts header presence and values

- **WHEN** the unit test suite runs
- **THEN** assertions exist for each header defined in the baseline requirement, the CSP requirement, the HSTS requirement, and the Permissions-Policy requirement

#### Scenario: Unit test covers LOCAL_DEPLOYMENT branch

- **WHEN** the unit test suite runs
- **THEN** at least one test sets `LOCAL_DEPLOYMENT=1` and asserts absence of the `Strict-Transport-Security` header, and at least one test leaves `LOCAL_DEPLOYMENT` unset and asserts its presence

#### Scenario: Integration test covers every route family

- **WHEN** the integration test suite runs
- **THEN** it hits at least one route matching `/livez`, `/webhooks/*`, `/api/*`, `/invocations`, `/trigger`, `/static/*`, and `/llms.txt` and asserts the full baseline header set on each response
