## ADDED Requirements

### Requirement: /webhooks/* responses MUST strip workflow-supplied platform-reserved headers

Responses produced by the HTTP `TriggerSource` for `/webhooks/*` SHALL be filtered against the platform-owned reserved header list (`RESERVED_RESPONSE_HEADERS` exported from `@workflow-engine/core`). Reserved names supplied by the workflow handler SHALL NOT reach the wire. The reserved list covers two threat classes:

- Cross-tenant cookie injection / session fixation / external redirect / browser auth-dialog UI: `set-cookie`, `set-cookie2`, `location`, `refresh`, `clear-site-data`, `authorization`, `proxy-authenticate`, `www-authenticate`.
- Override of platform security/transport invariants set by `secureHeadersMiddleware`: `content-security-policy`, `content-security-policy-report-only`, `strict-transport-security`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `cross-origin-embedder-policy`, `permissions-policy`, `server`, `x-powered-by`.

The filter SHALL be case-insensitive and SHALL emit a single `trigger.exception` event per response when any reserved header is stripped (event shape defined by `http-trigger` spec). The HTTP response itself SHALL be returned to the caller with the reserved headers absent; the response SHALL NOT be downgraded to `500` because of the strip.

#### Scenario: Set-Cookie planted by a workflow does not reach the wire

- **GIVEN** a `POST /webhooks/<owner>/<repo>/<workflow>/<trigger>` request
- **AND** a workflow handler that returns `{ status: 200, headers: { "set-cookie": "session=attacker; Path=/" } }`
- **WHEN** the response is written
- **THEN** the wire response SHALL contain no `Set-Cookie` header
- **AND** the platform `session` cookie on the engine origin SHALL be unchanged for any subsequent dashboard request from the same browser

#### Scenario: Workflow cannot weaken the global CSP

- **GIVEN** a workflow handler that returns `{ headers: { "content-security-policy": "default-src *" } }`
- **WHEN** the response is written
- **THEN** the wire response's `Content-Security-Policy` SHALL be the value set by `secureHeadersMiddleware` (per the existing "Content-Security-Policy MUST start from default-src 'none'" requirement)
- **AND** the workflow's value SHALL NOT appear on the wire

#### Scenario: Workflow cannot strip nosniff

- **GIVEN** a workflow handler that returns `{ headers: { "x-content-type-options": "" } }` or omits/overrides the platform-set value
- **WHEN** the response is written
- **THEN** the wire response SHALL still carry `X-Content-Type-Options: nosniff` from the global middleware

### Requirement: Build-time guards on the workflow→runtime contract MUST have a runtime counterpart

Any security-bearing constraint enforced by the SDK build pipeline against workflow source SHALL also be enforced at the runtime host boundary. The SDK runs in tenant-controlled environments (developer machines, CI runners) and CAN be forked, replaced, modified, or bypassed. Build-time enforcement is developer-experience; runtime enforcement is the security boundary. The reserved-response-header check is the canonical example: build-time rejection in `extractHttpTriggerJsonSchemas` is paired with runtime stripping in the HTTP `TriggerSource`.

#### Scenario: Tenant ships a bundle that bypassed the SDK build check

- **GIVEN** an out-of-tree builder or a forked SDK that does NOT implement the build-time reserved-headers check
- **AND** a workflow whose response handler emits `{ headers: { "set-cookie": "x" } }`
- **WHEN** the workflow is uploaded and its trigger fires
- **THEN** the runtime SHALL strip the reserved header and emit `trigger.exception`
- **AND** the wire response SHALL NOT carry `Set-Cookie`
