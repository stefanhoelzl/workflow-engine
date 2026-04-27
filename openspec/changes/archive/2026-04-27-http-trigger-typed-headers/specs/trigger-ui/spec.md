## MODIFIED Requirements

### Requirement: Event submission

The system SHALL accept `POST /trigger/<tenant>/<workflow>/<trigger>` with a JSON body and dispatch the trigger via the shared executor, returning a kind-agnostic JSON envelope that distinguishes success, validation failure, and infrastructure failure by HTTP status class. The response body SHALL be JSON for every outcome (success and failure), enabling a kind-agnostic client-side dialog to key its visual treatment on status class alone.

The endpoint SHALL accept dispatches for every registered trigger kind, including HTTP. For an HTTP descriptor the POSTed JSON body SHALL be either:

- a bare object — treated as the `body` field of the `HttpTriggerPayload`; the `headers` slot SHALL default to `{}`; or
- an envelope `{ body: <bare>, headers?: <Record<string, string>> }` — the server SHALL extract `body` and `headers` from the envelope.

The handler SHALL then construct the full payload as `{ body, headers: <extracted or {}>, url: "/webhooks/<tenant>/<workflow>/<trigger>", method: descriptor.method }` before calling `fire`. For non-HTTP kinds the POSTed JSON body SHALL be used as the trigger input directly. In every case the constructed input SHALL be validated against `descriptor.inputSchema` by the shared `buildFire` path; validation includes the headers slot when the descriptor declares one.

The handler SHALL construct a `DispatchMeta` from the request's authenticated session and pass it as the second argument to `entry.fire`. The dispatch SHALL have `source: "manual"` for every successful `/trigger/*` dispatch. When the request carries an authenticated user, `dispatch.user` SHALL be `{ name, mail }` sourced from the session (`c.get("user")`). When no authenticated user is present, `dispatch.user` SHALL be omitted while `source` remains `"manual"` — authentication is binary per `auth/spec.md`, and there is no `authOpen` / open-mode sentinel user fallback. In production this branch is unreachable because `sessionMw` on `/trigger/*` redirects unauthenticated requests to `/login` before the handler runs; it exists solely for tests that exercise the handler with a stub session middleware that omits `user`.

The endpoint SHALL be mounted behind `requireTenantMember`; dispatches for tenants the user is not a member of SHALL return `404` identical to an unknown trigger response (see the "Unknown trigger" scenario).

#### Scenario: Successful submission for non-HTTP trigger

- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/<trigger>` for a non-HTTP descriptor with a payload that validates against the trigger's `inputSchema`
- **THEN** the server SHALL invoke the executor for that trigger with the parsed payload as input
- **AND** the response SHALL have status `2xx` with a JSON body containing `{"ok": true, "output": <executor output>}`

#### Scenario: Successful submission for HTTP trigger with server-side payload wrapping (bare body)

- **GIVEN** an HTTP descriptor `{ kind: "http", method: "POST", name: "webhook" }` registered under `tenant/workflow` with no `request.headers` schema declared
- **WHEN** a POST request is sent to `/trigger/tenant/workflow/webhook` with JSON body `{"x": 1}` (a bare object — no `body`/`headers` envelope keys present)
- **THEN** the server SHALL construct `input = { body: {"x": 1}, headers: {}, url: "/webhooks/tenant/workflow/webhook", method: "POST" }`
- **AND** the server SHALL validate `input` against `descriptor.inputSchema` via `buildFire`
- **AND** the server SHALL call `entry.fire(input, dispatch)` where `dispatch` is derived from the session
- **AND** the response SHALL have status `2xx` with a JSON body containing `{"ok": true, "output": <executor output>}` on success

#### Scenario: Successful submission for HTTP trigger with declared headers (envelope)

- **GIVEN** an HTTP descriptor with `request: { headers: z.object({ "x-trace-id": z.string() }) }` declared
- **WHEN** a POST request is sent to `/trigger/tenant/workflow/webhook` with JSON body `{ "body": {"x": 1}, "headers": {"x-trace-id": "abc"} }`
- **THEN** the server SHALL construct `input = { body: {"x": 1}, headers: {"x-trace-id": "abc"}, url: "/webhooks/tenant/workflow/webhook", method: "POST" }`
- **AND** validation SHALL succeed
- **AND** the response SHALL have status `2xx`

#### Scenario: HTTP trigger envelope missing required header returns 422

- **GIVEN** an HTTP descriptor with `request: { headers: z.object({ "x-trace-id": z.string() }) }` declared
- **WHEN** a POST request is sent to `/trigger/tenant/workflow/webhook` with JSON body `{ "body": {"x": 1} }` (no `headers` key, or with empty `headers: {}`)
- **THEN** the server SHALL return `422` with `issues` referencing the missing `headers["x-trace-id"]`
- **AND** the executor SHALL NOT be invoked

#### Scenario: Payload validation failure

- **WHEN** a POST request is sent with a payload that fails the trigger's `inputSchema` (or with a non-JSON body)
- **THEN** the response SHALL have status `4xx` (specifically `422` for a schema validation failure) with a JSON body containing a top-level `error` field
- **AND** the body MAY include an `issues` array describing field-level violations

#### Scenario: Infrastructure failure

- **WHEN** the executor throws or returns a non-validation failure for a POST request
- **THEN** the response SHALL have status `5xx` (specifically `500` for internal errors) with a JSON body containing a top-level `error` field
- **AND** the body MAY include a `details` object describing the failure

#### Scenario: Unknown trigger

- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/<trigger>` where no such trigger is registered for the given tenant + workflow
- **THEN** the response SHALL have status `404`
- **AND** the response SHALL NOT reveal whether the tenant or the workflow exists

#### Scenario: Authenticated dispatch populates user

- **GIVEN** an authenticated session `{ name: "Jane Doe", mail: "jane@example.com" }` on the dispatching request
- **WHEN** the handler calls `entry.fire(input, dispatch)` for a valid trigger
- **THEN** `dispatch` SHALL equal `{ source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`

#### Scenario: Dispatch without a user omits dispatch.user

- **GIVEN** a test that mounts the trigger handler with a stub `sessionMw` that does not call `c.set("user", …)` so `c.get("user")` returns undefined
- **WHEN** the handler calls `entry.fire(input, dispatch)` for a valid trigger
- **THEN** `dispatch` SHALL equal `{ source: "manual" }` with no `user` field

#### Scenario: Cross-tenant dispatch returns 404

- **GIVEN** an authenticated user who is not a member of tenant `acme`
- **WHEN** the user sends `POST /trigger/acme/<workflow>/<trigger>` for any registered trigger
- **THEN** the response SHALL have status `404`
- **AND** the response SHALL NOT reveal whether the tenant or the workflow exists

## ADDED Requirements

### Requirement: HTTP trigger cards render header inputs from the manifest schema

The trigger card rendered on `/trigger/*` for an HTTP descriptor whose `inputSchema.properties.headers` declares one or more properties SHALL render header inputs alongside the body inputs, derived from the same Jedison schema-form pipeline used today for the `body` slot. Cards for HTTP descriptors with no declared headers schema (i.e. `headers` is an empty-properties object) SHALL render only the body form, identical to today.

The card's submit handler SHALL POST a JSON envelope `{ body, headers }` (rather than a bare body) when the headers schema is non-empty. When the headers schema is empty, the submit handler MAY POST a bare body (today's behaviour) — both forms SHALL be accepted by the server-side endpoint per the "Event submission" requirement.

#### Scenario: Card renders header inputs when schema declares header properties

- **GIVEN** an HTTP descriptor with `headers: z.object({ "x-trace-id": z.string() })` registered under `acme/w/webhook`
- **WHEN** the user expands the trigger card on `/trigger/acme/w/`
- **THEN** the card SHALL render an input field labelled `x-trace-id`
- **AND** the card SHALL render a body form derived from `inputSchema.properties.body` as today

#### Scenario: Card renders body-only when no headers schema declared

- **GIVEN** an HTTP descriptor with no `request.headers` schema declared (composed `headers` is `{ type: "object", properties: {}, additionalProperties: false }`)
- **WHEN** the user expands the trigger card
- **THEN** the card SHALL render only the body form
- **AND** the card SHALL NOT render any header input fields

#### Scenario: Card submits envelope when headers are declared

- **GIVEN** an HTTP descriptor with declared headers schema and a user-filled card with body `{ "x": 1 }` and header value `x-trace-id: abc`
- **WHEN** the user clicks Submit
- **THEN** the card SHALL POST `{ "body": { "x": 1 }, "headers": { "x-trace-id": "abc" } }` to `/trigger/acme/w/webhook`
