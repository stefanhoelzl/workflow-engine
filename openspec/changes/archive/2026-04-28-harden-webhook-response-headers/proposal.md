## Why

Workflow handlers can return arbitrary headers from `httpTrigger` responses, with no platform-side allow-list. A workflow can plant `Set-Cookie` on the engine origin (session fixation against logged-in dashboard users), emit `Location` for off-domain phishing redirects, or override the platform's own security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) and weaken every other response on the same origin. The post-2026-04-26 typed-headers refactor improved request-side hygiene but left the response-side workflow-controlled. Findings #4 (request) is mitigated; finding #5 (response) is not.

## What Changes

- Define a single, exported `RESERVED_RESPONSE_HEADERS` set in `@workflow-engine/core`, alongside `HttpTriggerResult`.
- **Build-time**: `wfe upload` (via `buildWorkflows`) hard-rejects any `httpTrigger` whose `response.headers` zod schema declares a reserved name. Failure surfaces as a `BuildWorkflowsError` with the offending header name; no bundle is emitted.
- **Runtime**: `serializeHttpResult` strips reserved headers from the workflow-supplied response and emits a single `trigger.exception` (`name: "http.response-header-stripped"`, `input: { stripped: [<lowercased names>] }`) per response. The HTTP response goes out without the stripped headers; status, body, and non-reserved headers are unchanged.
- Reserved set covers two threat classes in one list:
  - **Cross-tenant / external-attacker:** `set-cookie`, `set-cookie2`, `location`, `refresh`, `clear-site-data`, `authorization`, `proxy-authenticate`, `www-authenticate`.
  - **Platform security/transport invariants:** `content-security-policy`, `content-security-policy-report-only`, `strict-transport-security`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `cross-origin-embedder-policy`, `permissions-policy`, `server`, `x-powered-by`.
- Comparison is case-insensitive; declared and runtime keys are lowercased before lookup.
- New `SECURITY.md` invariant: build-time validation MUST have a runtime counterpart on the workflow→runtime contract; the SDK runs in tenant-controlled environments and cannot be load-bearing for security boundaries.
- **Note on Content-Type / XSS (finding #5 sub-issue):** already covered by the existing global `secureHeadersMiddleware` (CSP `default-src 'none'; script-src 'self'` + `X-Content-Type-Options: nosniff`), which applies to `/webhooks/*`. This proposal adds no new headers for that path; it only ensures the workflow cannot *unset* them by overriding from the response (the platform-invariant entries above).

## Capabilities

### New Capabilities

(none — this hardens existing capabilities rather than introducing a new one)

### Modified Capabilities

- `http-trigger`: response-shape contract gains a reserved-headers section. `response.headers` zod schemas MUST NOT declare reserved names (build-time rejection). Handler return values containing reserved names have those names stripped and emit `trigger.exception` (runtime).
- `http-security`: response-side reserved-headers strip becomes part of the defense-in-depth surface. Adds the new R-rule that build-time guards on the workflow→runtime contract MUST have runtime counterparts.

## Impact

- **Code:**
  - `packages/core/src/index.ts` — adds `RESERVED_RESPONSE_HEADERS` and `isReservedResponseHeader` next to `HttpTriggerResult`; both join the public `export {}` block.
  - `packages/sdk/src/cli/build-workflows.ts` — `extractHttpTriggerJsonSchemas` walks declared `response.headers` JSON Schema property names and throws `BuildWorkflowsError` on any reserved match.
  - `packages/runtime/src/triggers/http.ts` — `serializeHttpResult` partitions the workflow's `headers` into kept vs reserved, drops reserved, calls `entry.exception(...)` once per response when any were stripped.
- **Tests:**
  - `packages/core` unit test for the set + helper (case-insensitive).
  - `packages/sdk` unit test for build-time rejection (lowercase + capitalized).
  - `packages/runtime` unit tests: single reserved header stripped + exception fired; multiple reserved headers → single exception with all names; non-reserved headers pass through unchanged.
  - `packages/tests` e2e: `wfe upload` with reserved-header schema → non-zero exit + error message in stderr.
- **Author-visible / migration:** Authors who currently declare reserved headers in `response.headers` schemas will see `wfe upload` fail until they remove them; they have no working production deployment that depends on these headers (request-side header refactor on 2026-04-26 was the breaking introduction, response-side schemas are new). Authors who emit reserved headers from their handler code see those headers silently dropped at runtime and a `trigger.exception` row appear in their dashboard. No state wipe, no rebuild required for unaffected tenants.
- **Manifest format:** unchanged. The SDK still emits `triggers[].response.headers` as JSON Schema; the build check is a validation step, not a shape change. Pre-existing manifests without `response.headers` declarations remain valid (runtime check still applies to their handler output).
- **Operator-visible:** new `trigger.exception` rows in dashboards for workflows that emit reserved headers; existing exception-pill UI handles them with no changes.
- **Out of scope (separate proposals if desired):**
  - `__Host-`-prefix rename of the platform `session` cookie (independent change, broader migration).
  - Per-owner subdomain for `/webhooks/*` (ingress/DNS work).
  - `Content-Security-Policy: sandbox` on `/webhooks/*` responses as additional defense-in-depth (cheap, but additive — can land separately).
  - Build/runtime checks on `request.headers` (the request side already strips undeclared headers; declaring `authorization`/`cookie` is intentional author behaviour, not in scope).
