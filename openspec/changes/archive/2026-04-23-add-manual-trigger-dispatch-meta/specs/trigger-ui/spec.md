## MODIFIED Requirements

### Requirement: Event submission

The system SHALL accept `POST /trigger/<tenant>/<workflow>/<trigger>` with a JSON body and dispatch the trigger via the shared executor, returning a kind-agnostic JSON envelope that distinguishes success, validation failure, and infrastructure failure by HTTP status class. The response body SHALL be JSON for every outcome (success and failure), enabling a kind-agnostic client-side dialog to key its visual treatment on status class alone.

The endpoint SHALL accept dispatches for every registered trigger kind, including HTTP. For an HTTP descriptor the POSTed JSON body SHALL be treated as the body field of the `HttpTriggerPayload`, and the handler SHALL construct the full payload as `{ body: <posted JSON>, headers: {}, url: "/webhooks/<tenant>/<workflow>/<trigger>", method: descriptor.method }` before calling `fire`. For non-HTTP kinds the POSTed JSON body SHALL be used as the trigger input directly. In every case the constructed input SHALL be validated against `descriptor.inputSchema` by the shared `buildFire` path.

The handler SHALL construct a `DispatchMeta` from the request's authenticated session and pass it as the second argument to `entry.fire`. The dispatch SHALL have `source: "manual"` for every successful `/trigger/*` dispatch. When the request carries an authenticated user, `dispatch.user` SHALL be `{ name, mail }` sourced from the session (e.g. `c.get("user")`). When no authenticated user is present but the request is in open-mode dev (`c.get("authOpen") === true`), `dispatch.user` SHALL be populated with the sentinel `{ name: "local", mail: "" }` so downstream consumers (dashboard chip tooltip) have a non-empty attribution. When neither an authenticated user nor the open-mode flag is set, `dispatch.user` SHALL be omitted while `source` remains `"manual"`.

The endpoint SHALL be mounted behind `requireTenantMember`; dispatches for tenants the user is not a member of SHALL return `404` identical to an unknown trigger response (see the "Unknown trigger" scenario).

#### Scenario: Successful submission for non-HTTP trigger

- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/<trigger>` for a non-HTTP descriptor with a payload that validates against the trigger's `inputSchema`
- **THEN** the server SHALL invoke the executor for that trigger with the parsed payload as input
- **AND** the response SHALL have status `2xx` with a JSON body containing `{"ok": true, "output": <executor output>}`

#### Scenario: Successful submission for HTTP trigger with server-side payload wrapping

- **GIVEN** an HTTP descriptor `{ kind: "http", method: "POST", name: "webhook" }` registered under `tenant/workflow`
- **WHEN** a POST request is sent to `/trigger/tenant/workflow/webhook` with JSON body `{"x": 1}`
- **THEN** the server SHALL construct `input = { body: {"x": 1}, headers: {}, url: "/webhooks/tenant/workflow/webhook", method: "POST" }`
- **AND** the server SHALL validate `input` against `descriptor.inputSchema` via `buildFire`
- **AND** the server SHALL call `entry.fire(input, dispatch)` where `dispatch` is derived from the session
- **AND** the response SHALL have status `2xx` with a JSON body containing `{"ok": true, "output": <executor output>}` on success

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

#### Scenario: Open-mode dispatch attaches a sentinel user

- **GIVEN** the server running in open-mode dev such that `c.get("user")` returns undefined and `c.get("authOpen")` is `true`
- **WHEN** the handler calls `entry.fire(input, dispatch)` for a valid trigger
- **THEN** `dispatch` SHALL equal `{ source: "manual", user: { name: "local", mail: "" } }`

#### Scenario: Cross-tenant dispatch returns 404

- **GIVEN** an authenticated user who is not a member of tenant `acme`
- **WHEN** the user sends `POST /trigger/acme/<workflow>/<trigger>` for any registered trigger
- **THEN** the response SHALL have status `404`
- **AND** the response SHALL NOT reveal whether the tenant or the workflow exists

## ADDED Requirements

### Requirement: HTTP trigger cards submit through /trigger/*

Trigger cards rendered on the `/trigger/*` UI page for HTTP descriptors SHALL POST their form value to `/trigger/<tenant>/<workflow>/<trigger>` and SHALL NOT POST directly to the public `/webhooks/<tenant>/<workflow>/<trigger>` ingress. The card's user-visible meta text MAY continue to surface the canonical webhook URL (e.g. `"POST /webhooks/..."`) as documentation of the public endpoint external callers use; that presentation MUST NOT change the submit destination.

Non-HTTP kinds (cron, future mail, …) SHALL continue to POST to `/trigger/<tenant>/<workflow>/<trigger>` as today. The client-side submit procedure (`/static/trigger-forms.js`) SHALL remain kind-agnostic and SHALL route every Submit through the `data-trigger-url` attribute supplied by the server-rendered card.

External callers (non-UI) SHALL continue to POST to `/webhooks/<tenant>/<workflow>/<trigger>` unchanged; that ingress SHALL remain unauthenticated per `http-security` / SECURITY.md §3 and SHALL continue to produce `meta.dispatch = { source: "trigger" }`.

#### Scenario: HTTP trigger card submit URL points at /trigger/*

- **GIVEN** an HTTP descriptor `{ kind: "http", method: "POST", name: "webhook" }` registered under `acme/w`
- **WHEN** the `/trigger/*` page renders a card for that descriptor
- **THEN** the card's `data-trigger-url` attribute SHALL be `/trigger/acme/w/webhook`
- **AND** the card's `data-trigger-method` attribute SHALL be `POST`
- **AND** the submit button click handler in `/static/trigger-forms.js` SHALL POST to that URL

#### Scenario: Cron trigger card submit URL unchanged

- **GIVEN** a cron descriptor registered under `acme/w` with name `nightly`
- **WHEN** the `/trigger/*` page renders a card for that descriptor
- **THEN** the card's `data-trigger-url` attribute SHALL be `/trigger/acme/w/nightly`

#### Scenario: External webhook ingress unchanged

- **GIVEN** the same HTTP descriptor registered under `acme/w`
- **WHEN** an external caller POSTs to `/webhooks/acme/w/webhook`
- **THEN** the request SHALL be handled by the existing public webhook ingress
- **AND** no authentication SHALL be required on that path
- **AND** the resulting invocation's `trigger.request` event SHALL carry `meta.dispatch = { source: "trigger" }`
