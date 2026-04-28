## ADDED Requirements

### Requirement: Reserved response header names are platform-owned

The platform SHALL reserve a fixed list of HTTP response header names that workflow handlers MUST NOT set on `/webhooks/*` responses. The list SHALL be exported from `@workflow-engine/core` as `RESERVED_RESPONSE_HEADERS: ReadonlySet<string>` and consumed by both the SDK build pipeline and the runtime HTTP `TriggerSource`.

The reserved list SHALL contain (lowercased canonical form):

- Cross-origin / cross-tenant attack class: `set-cookie`, `set-cookie2`, `location`, `refresh`, `clear-site-data`, `authorization`, `proxy-authenticate`, `www-authenticate`.
- Platform security/transport invariants (the platform sets these via `secureHeadersMiddleware` and the workflow MUST NOT override them): `content-security-policy`, `content-security-policy-report-only`, `strict-transport-security`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `cross-origin-embedder-policy`, `permissions-policy`, `server`, `x-powered-by`.

The core SHALL also export `isReservedResponseHeader(name: string): boolean` which lowercases its argument before lookup. `Content-Type` SHALL NOT be reserved (workflow-controlled by design, default-injected by the runtime when omitted). `Cache-Control` SHALL NOT be reserved (workflow-controlled).

#### Scenario: Lookup is case-insensitive

- **GIVEN** the exported `isReservedResponseHeader` helper
- **WHEN** called with `"Set-Cookie"`, `"SET-COOKIE"`, or `"set-cookie"`
- **THEN** every call SHALL return `true`

#### Scenario: Non-reserved names return false

- **GIVEN** a header name not in the reserved set, e.g. `"x-app-version"`, `"content-type"`, `"cache-control"`
- **WHEN** `isReservedResponseHeader` is called
- **THEN** the call SHALL return `false`

### Requirement: Build-time rejection of reserved response-header schemas

The SDK workflow build pipeline (the `buildWorkflows` core invoked by `wfe upload` and `wfe build`) SHALL reject any `httpTrigger` whose `response.headers` zod schema declares a property whose name is a reserved response header (case-insensitive). The rejection SHALL fail the build with a `BuildWorkflowsError` whose message names the workflow file, the trigger export name, and the offending header name. No bundle and no manifest SHALL be emitted for a workflow that fails this check.

The build check SHALL inspect the JSON Schema produced from the `response.headers` zod schema (the same JSON Schema that ships in the manifest) by walking `properties.*` keys and lowercasing each before comparison. Schemas without a `properties` object (e.g. `z.record(z.string(), z.string())` or other open-record forms) SHALL pass the build check unchanged; the runtime strip remains load-bearing for those cases.

#### Scenario: Schema declaring lowercase reserved name fails build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "set-cookie": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL throw `BuildWorkflowsError`
- **AND** the message SHALL name the workflow, the trigger export name, and `"set-cookie"`
- **AND** no `<workflow>.js` artifact SHALL be returned in the build result

#### Scenario: Schema declaring capitalized reserved name fails build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "Set-Cookie": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL throw `BuildWorkflowsError` mentioning `"Set-Cookie"` (or its lowercased form) as a reserved header

#### Scenario: Schema with non-reserved keys passes build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "x-app-version": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL succeed and the manifest SHALL contain the `response.headers` JSON Schema

#### Scenario: Open-record response-headers schema bypasses static check

- **GIVEN** a workflow whose `response.headers` zod schema produces a JSON Schema without a `properties` object (e.g. a `z.record(...)` form)
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL succeed (no static keys to check)
- **AND** the runtime strip SHALL still remove reserved names from any handler response that includes them

### Requirement: Runtime stripping of reserved response headers

The HTTP `TriggerSource` SHALL strip reserved response headers from the workflow handler's returned `headers` before writing the HTTP response. The strip SHALL be performed in the response-shaping path that constructs the wire envelope (currently `serializeHttpResult`), AFTER the existing default-`content-type` injection logic. Comparison SHALL be case-insensitive.

When at least one reserved header is stripped, the `TriggerSource` SHALL invoke `entry.exception({ kind: "trigger.exception", name: "http.response-header-stripped", input: { stripped: <sorted lowercased names> } })` exactly once per response. `entry.exception` is the per-trigger callable bound to `executor.fail` by the registry's `buildException` helper. The HTTP response SHALL be written and returned to the caller regardless of the exception emission's outcome — the strip succeeds first.

The HTTP response status, body, and non-reserved headers SHALL be unchanged by the strip. Stripping SHALL NOT cause the response to become a `500`; the caller observes a successful response that simply lacks the reserved headers the workflow attempted to set.

#### Scenario: Single reserved header stripped, exception emitted

- **GIVEN** a handler returning `{ status: 200, body: { ok: true }, headers: { "set-cookie": "session=x", "x-app": "v1" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL be `200` with body `{"ok":true}`, header `x-app: v1`, and NO `set-cookie` header
- **AND** `entry.exception` SHALL be invoked exactly once with `{ kind: "trigger.exception", name: "http.response-header-stripped", input: { stripped: ["set-cookie"] } }`

#### Scenario: Multiple reserved headers produce one exception

- **GIVEN** a handler returning `{ headers: { "set-cookie": "x", "location": "https://evil/", "x-frame-options": "ALLOWALL", "x-trace": "abc" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL include `x-trace: abc` and SHALL NOT include `set-cookie`, `location`, or `x-frame-options`
- **AND** `entry.exception` SHALL be invoked exactly once with `input.stripped` equal to `["location", "set-cookie", "x-frame-options"]` (sorted, lowercased)

#### Scenario: Case-insensitive strip

- **GIVEN** a handler returning `{ headers: { "Set-Cookie": "x", "LOCATION": "https://evil/" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL include neither `Set-Cookie` nor `LOCATION`
- **AND** `input.stripped` SHALL be `["location", "set-cookie"]`

#### Scenario: No reserved headers means no exception

- **GIVEN** a handler returning `{ headers: { "x-app-version": "1.0", "x-trace": "abc" } }`
- **WHEN** the response is serialised
- **THEN** both headers SHALL be on the wire response
- **AND** `entry.exception` SHALL NOT be invoked for this response

#### Scenario: Strip preserves status, body, content-type

- **GIVEN** a handler returning `{ status: 201, body: "ok", headers: { "set-cookie": "x" } }` and no author content-type
- **WHEN** the response is serialised
- **THEN** the wire response SHALL be `201` with body `"ok"` and `content-type: text/plain; charset=UTF-8`
- **AND** `set-cookie` SHALL NOT be present
