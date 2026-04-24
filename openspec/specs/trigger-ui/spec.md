# Trigger UI Specification

## Purpose

Provide a web UI at `/trigger` for manually triggering workflow events via auto-generated forms derived from Zod event schemas.
## Requirements
### Requirement: Trigger middleware factory
The system SHALL provide a `triggerMiddleware` factory function that accepts a JSON Schema map (`Record<string, object>`) and an `EventSource`, and returns a standard `Middleware` object (`{ match, handler }`).

#### Scenario: Middleware creation
- **WHEN** `triggerMiddleware(allJsonSchemas, source)` is called
- **THEN** a `Middleware` is returned with `match` set to `"/trigger/*"`

#### Scenario: Middleware integrates with existing server
- **WHEN** the trigger middleware is passed to `createServer` alongside other middleware
- **THEN** `/trigger/*` routes are served from the same Hono server

### Requirement: Event list page

The system SHALL serve an HTML page at `GET /trigger/` listing all defined workflow events by name, rendered with authenticated user identity. Identity SHALL come from the authenticated session (`sessionMw` on `/trigger/*` reads the sealed `session` cookie, unseals it, and sets `c.set("user", UserContext)`). The page SHALL read `c.get("user")` and render the user's display name + email in the shared layout.

The page SHALL NOT read `X-Auth-Request-*` headers — those were stripped by Traefik's `strip-auth-headers` middleware before arrival and are ignored by both the bearer middleware (API) and the session middleware (UI). The `replace-oauth2-proxy` change replaced forward-auth header identity with in-app session identity; this requirement's scenario was updated accordingly.

#### Scenario: Page lists all events with user identity

- **WHEN** a browser requests `GET /trigger/` with a valid sealed `session` cookie whose payload identifies `{ name: "stefan", mail: "stefan@example.com" }`
- **THEN** the response is an HTML document rendered via the shared layout
- **AND** the layout SHALL display `stefan` and `stefan@example.com` in the top-bar user block
- **AND** each event from the JSON Schema map SHALL be listed as a `<details>` element with the event name as the `<summary>`

#### Scenario: JSON Schema embedded per event

- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema
- **THEN** the schema has been processed by `prepareSchema` which promotes `example` values to `default` and labels `anyOf` variants with type titles

#### Scenario: Forged X-Auth-Request-* headers ignored

- **GIVEN** a request to `GET /trigger/` with a valid session cookie for `{ name: "alice" }` AND forged headers `X-Auth-Request-User: attacker`, `X-Auth-Request-Email: attacker@evil.test`
- **WHEN** the page is rendered
- **THEN** the top-bar user block SHALL display `alice` (from the session cookie)
- **AND** SHALL NOT display `attacker` or `attacker@evil.test`

### Requirement: Lazy form initialization
The system SHALL provide a client-side `initForm` procedure in the external JavaScript file (`/static/trigger-forms.js`) that initializes a Jedison form instance when a `<details>` block is first expanded. When the server-rendered trigger card carries no form container (because the trigger's input schema has no `properties` and no `additionalProperties`), no Jedison instance SHALL be created and the card SHALL present only the Submit control.

#### Scenario: First expansion creates form
- **WHEN** a `<details>` block containing a form container is opened for the first time
- **THEN** the embedded JSON Schema is read from the `<script>` element
- **THEN** a Jedison instance is created targeting the form container inside that `<details>` block
- **THEN** the Jedison instance is cached on the DOM element

#### Scenario: Subsequent toggles reuse instance
- **WHEN** a `<details>` block is collapsed and re-opened
- **THEN** no new Jedison instance is created
- **THEN** the previously entered form data is preserved

#### Scenario: Trigger with no user-settable inputs renders no form
- **GIVEN** a trigger whose input schema has neither `properties` nor `additionalProperties`
- **WHEN** the trigger card is rendered on the server
- **THEN** the card's body SHALL NOT contain a form container element
- **AND** when its `<details>` block is opened, no Jedison instance SHALL be created for that card
- **AND** the Submit control SHALL be the only interactive element visible inside the card body

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

### Requirement: Form submission via fetch
The system SHALL provide a client-side submit procedure in `/static/trigger-forms.js` that reads the Jedison form value (or an empty object for cards without a form), posts it as JSON to the trigger's dispatch URL, and hands the response to the shared result dialog for visual presentation.

#### Scenario: Submit posts the form value as JSON
- **WHEN** the user clicks the Submit button for a trigger with a form
- **THEN** `jedison.getValue()` SHALL be called on the cached instance
- **AND** the client SHALL POST the resulting JSON to the dispatch URL resolved from the trigger card

#### Scenario: Submit on a formless card posts an empty object
- **WHEN** the user clicks the Submit button for a trigger whose card has no form container
- **THEN** the client SHALL POST the JSON body `{}` to the dispatch URL resolved from the trigger card

#### Scenario: Response is handed to the result dialog
- **WHEN** the server responds to the submit request (with any HTTP status)
- **THEN** the client SHALL read the response body
- **AND** SHALL open the shared result dialog, passing the response status and parsed body to the dialog's `showResult` entry point for outcome-class selection

#### Scenario: Network rejection is handed to the result dialog
- **WHEN** the client-side `fetch()` rejects before receiving a response
- **THEN** the client SHALL open the shared result dialog in the server-error visual state with a human-readable banner indicating network failure

### Requirement: Jedison styling
The system SHALL use Jedison's base theme with custom CSS that uses the shared layout's CSS variables for consistent light/dark mode theming.

#### Scenario: Form elements styled with CSS variables
- **WHEN** the Jedison form is rendered
- **THEN** `input`, `select`, and `textarea` elements use `var(--bg-elevated)` for background and `var(--border)` for borders
- **THEN** `label` elements use `var(--text-secondary)` for color

#### Scenario: Dark mode support
- **WHEN** the user's system preference is dark mode
- **THEN** form elements automatically use the dark mode CSS variable values

### Requirement: Example values on schema fields
Workflow authors SHALL be able to attach example values to Zod event schema fields using `.meta({ example: <value> })`. These values are for UI pre-filling only and SHALL NOT affect server-side validation behavior.

#### Scenario: Example on a string field
- **WHEN** an event schema defines `z.string().meta({ example: "ORD-12345" })`
- **THEN** `z.toJSONSchema()` produces `{ "type": "string", "example": "ORD-12345" }`

#### Scenario: Example on a number field
- **WHEN** an event schema defines `z.number().meta({ example: 42.99 })`
- **THEN** `z.toJSONSchema()` produces `{ "type": "number", "example": 42.99 }`

#### Scenario: Example does not create a schema default
- **WHEN** an event schema defines `z.string().meta({ example: "ORD-12345" })`
- **THEN** parsing an empty object with the schema SHALL fail validation
- **THEN** the field remains required

### Requirement: Example-to-default promotion in schema preparation
The `prepareSchema` function SHALL recursively walk the JSON Schema and copy `example` values into `default` for fields that do not already have a `default`.

#### Scenario: Field with example and no default
- **WHEN** a JSON Schema field has `"example": "ORD-12345"` and no `"default"` key
- **THEN** `prepareSchema` SHALL set `"default": "ORD-12345"` on that field

#### Scenario: Field with both example and default
- **WHEN** a JSON Schema field has `"example": "ORD-12345"` and `"default": "REAL-DEFAULT"`
- **THEN** `prepareSchema` SHALL preserve `"default": "REAL-DEFAULT"` unchanged

#### Scenario: Field with no example
- **WHEN** a JSON Schema field has no `"example"` key
- **THEN** `prepareSchema` SHALL not add a `"default"` key

#### Scenario: Nested object properties
- **WHEN** a JSON Schema has nested `"properties"` containing fields with `"example"` values
- **THEN** `prepareSchema` SHALL recurse into nested properties and promote examples at all depths

### Requirement: Pre-filled form rendering
Jedison forms SHALL render with example values pre-filled in form inputs via the promoted `default` values in the JSON Schema.

#### Scenario: Form loads with pre-filled values
- **WHEN** a user expands an event's `<details>` block
- **THEN** form inputs for fields with examples SHALL display the example values
- **THEN** the user can edit or submit the pre-filled values

#### Scenario: Submission with pre-filled values succeeds
- **WHEN** a user submits the form without modifying the pre-filled example values
- **THEN** the server SHALL validate and accept the payload (examples are valid values)

### Requirement: Cron triggers listed alongside HTTP triggers

The `/trigger/<tenant>/<workflow>/` UI SHALL list cron triggers in the same list as HTTP triggers. Each cron trigger entry SHALL display at least the trigger name, its `schedule`, and its `tz`.

#### Scenario: Cron trigger appears in the list

- **GIVEN** a tenant with a loaded workflow containing `cronTrigger({ schedule: "0 9 * * *", tz: "UTC", handler })` exported as `daily`
- **WHEN** a user loads `GET /trigger/<tenant>/<workflow>/`
- **THEN** the page SHALL list a trigger entry for `daily`
- **AND** the entry SHALL show `schedule: 0 9 * * *` and `tz: UTC` (or equivalent rendering)

### Requirement: Triggers grouped by workflow

The `/trigger` listing page SHALL present registered triggers grouped under per-workflow section headings. Workflow groups SHALL be ordered alphabetically by workflow name; triggers within each group SHALL be ordered alphabetically by trigger name. Each trigger card's summary SHALL show only the trigger name (not the workflow name, which is conveyed by the enclosing section). The per-trigger meta line (for HTTP: method + webhook URL; for cron: schedule + timezone) SHALL be rendered in monospace type, visually distinguished from the trigger name (e.g. right-aligned within the summary or rendered as a muted caption).

#### Scenario: Two workflows each with two triggers render as two groups

- **GIVEN** a tenant with workflows `workflow-a` (triggers `alpha`, `beta`) and `workflow-b` (triggers `gamma`, `delta`)
- **WHEN** a user loads `GET /trigger/<tenant>/`
- **THEN** the page SHALL contain two workflow section elements, in the order `workflow-a` then `workflow-b`
- **AND** the `workflow-a` section SHALL contain trigger cards in the order `alpha` then `beta`
- **AND** the `workflow-b` section SHALL contain trigger cards in the order `delta` then `gamma`

#### Scenario: Card summary omits the workflow name

- **GIVEN** a trigger `alpha` belonging to workflow `workflow-a`
- **WHEN** the page is rendered
- **THEN** the trigger card's summary text SHALL contain `alpha`
- **AND** the summary text SHALL NOT contain the substring `workflow-a /` as a prefix to the trigger name

#### Scenario: Meta line is visually distinguished from the trigger name

- **WHEN** any trigger card is rendered
- **THEN** the meta line (webhook URL + method for HTTP, schedule + tz for cron) SHALL be marked with a CSS class that selects monospace type
- **AND** the meta line SHALL be visually distinguished from the trigger name (right-alignment within the summary, or a separate muted caption line)

### Requirement: Dialog reflects trigger-fire outcome visually

The trigger-fire result dialog SHALL distinguish three outcome categories determined solely by the HTTP response status class returned by the dispatch endpoint: success (status `2xx`), client error (status `4xx`), and server error (status `5xx` or an unresolved fetch rejection). Each category SHALL apply a distinct visual treatment (colour, border, banner text) so that the outcome is readable without inspecting the response body. The contract SHALL be kind-agnostic: a trigger backend that honours the status-class invariant SHALL receive the corresponding visual treatment automatically.

The dialog SHALL remove any prior outcome class before applying a new one, so that re-opening the dialog for a subsequent fire does not composite visual states.

The dialog SHALL render a status banner containing, at minimum, the outcome word (e.g. "Success", "Failed", "Error"). When the response body is a JSON object with a top-level `error` field of string type, the banner SHALL also include that string. The numeric HTTP status code is NOT rendered in the banner — the response body below the banner already surfaces it, and the dialog's visual state carries the status class.

#### Scenario: 2xx response applies the success visual state

- **GIVEN** a trigger-fire POST that returns HTTP `200` with body `{"ok": true, "output": {...}}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the success visual class
- **AND** the dialog SHALL NOT carry the warn or error visual classes
- **AND** the banner SHALL contain the outcome word for success

#### Scenario: 4xx response applies the warn visual state

- **GIVEN** a trigger-fire POST that returns HTTP `422` with body `{"error": "payload_validation_failed", "issues": [...]}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the warn visual class
- **AND** the dialog SHALL NOT carry the success or error visual classes
- **AND** the banner SHALL contain the outcome word for a client error and the string `payload_validation_failed`

#### Scenario: 5xx response applies the error visual state

- **GIVEN** a trigger-fire POST that returns HTTP `500` with body `{"error": "internal_error", "details": {...}}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the error visual class
- **AND** the dialog SHALL NOT carry the success or warn visual classes
- **AND** the banner SHALL contain the outcome word for a server error and the string `internal_error`

#### Scenario: Network failure is treated as a server error

- **GIVEN** a trigger-fire `fetch()` that rejects before any response is received
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the error visual class
- **AND** the banner SHALL contain an outcome word for a server error

### Requirement: Submit control shows an in-flight loading state

While a trigger-fire request is in flight, the Submit control SHALL be visually distinguished as loading: the control SHALL be disabled against further clicks, and SHALL carry a CSS class that marks it as loading (e.g. surfacing a spinner glyph). The loading visual SHALL be cleared when the result dialog opens (success or failure path).

#### Scenario: In-flight submit is disabled and marked loading

- **GIVEN** the user has clicked Submit on a trigger card
- **WHEN** the fetch is in flight and the response has not yet arrived
- **THEN** the Submit control SHALL be disabled
- **AND** the Submit control SHALL carry a CSS class that marks it as loading

#### Scenario: Loading state is cleared when the dialog opens

- **GIVEN** a Submit that was marked loading at the start of a fire
- **WHEN** the result dialog is opened (for either a success or a failure outcome)
- **THEN** the Submit control's loading class SHALL be removed
- **AND** the Submit control SHALL no longer be disabled

### Requirement: Manual triggers listed alongside HTTP and cron triggers

The `/trigger` UI SHALL list manual triggers in the same list as HTTP and cron triggers, scoped to the active tenant. Each manual trigger entry SHALL display at least the trigger name and a manual-kind icon. The entry SHALL render a Jedison form derived from `descriptor.inputSchema`. When the schema has no fields, the form SHALL render as a bare Submit button (the same behaviour produced by any trigger whose input schema is `z.object({})`).

#### Scenario: Manual trigger appears in the list

- **GIVEN** a tenant with a loaded workflow containing `export const rerun = manualTrigger({ handler })`
- **WHEN** a user loads `GET /trigger?tenant=<t>`
- **THEN** the page SHALL list a trigger entry for `rerun`
- **AND** the entry SHALL display the manual-kind icon

#### Scenario: Manual trigger entry renders a schema-driven form

- **GIVEN** a manual trigger declared with `input: z.object({ id: z.string() })`
- **WHEN** the trigger card is expanded in the UI
- **THEN** Jedison SHALL render a form derived from the JSON Schema of the input
- **AND** the form SHALL include a string input for `id`

#### Scenario: Manual trigger with empty input renders a bare Submit button

- **GIVEN** a manual trigger declared with no `input` (default `z.object({})`)
- **WHEN** the trigger card is expanded in the UI
- **THEN** Jedison SHALL render a zero-field form
- **AND** the Submit button SHALL remain the only interactive element

### Requirement: Manual trigger submit posts to the kind-agnostic endpoint

When the user submits a manual-trigger card, the UI SHALL POST the Jedison form value (or `{}` for empty schemas) to `/trigger/<tenant>/<workflow>/<trigger-name>` with `Content-Type: application/json`. The existing trigger-ui middleware handler SHALL process the request via `registry.getEntry` + `entry.fire(body)` without any manual-kind special-case branch.

#### Scenario: Submit posts to /trigger/<t>/<w>/<name>

- **GIVEN** a manual trigger `rerun` in workflow `ops` for tenant `acme`
- **WHEN** the user clicks Submit in the trigger card
- **THEN** the browser SHALL issue `POST /trigger/acme/ops/rerun` with a JSON body
- **AND** the response SHALL be the `{ ok, output }` envelope produced by the existing trigger-ui middleware

### Requirement: Shared kind registry registers the manual kind

The shared trigger-kind registry at `packages/runtime/src/ui/triggers.ts` (consumed by both `/trigger` and `/dashboard` UIs) SHALL contain entries for `"manual"` in BOTH of the following maps:

- `KIND_ICONS.manual` — a person-themed glyph (e.g., `"\u{1F464}"` — BUST IN SILHOUETTE).
- `KIND_LABELS.manual` — a short human-readable label (e.g., `"Manual"`).

Missing-kind fallback behaviour SHALL continue to apply unchanged to unrecognised kinds (icon falls back to `"\u{25CF}"`; label falls back to the raw kind string).

#### Scenario: Manual kind icon renders with correct metadata

- **GIVEN** a manual trigger card
- **WHEN** the page is rendered
- **THEN** the icon span SHALL contain the BUST IN SILHOUETTE glyph
- **AND** the span's `title` attribute SHALL equal `"manual"`
- **AND** the span's `aria-label` attribute SHALL equal `"manual"`

#### Scenario: Manual kind label resolves to the human-readable string

- **GIVEN** the `triggerKindLabel("manual")` helper
- **WHEN** called in any UI context that displays the label
- **THEN** the returned string SHALL equal `"Manual"`

### Requirement: Manual trigger cards render no meta line

The shared `triggerCardMeta(descriptor, tenant, workflow)` helper SHALL return an empty string `""` for manual triggers. The trigger card's summary SHALL continue to render the meta container, but for manual triggers the container SHALL contain an empty string, visually collapsing the meta line.

#### Scenario: Manual trigger meta is empty

- **GIVEN** a manual trigger descriptor
- **WHEN** `triggerCardMeta(descriptor, tenant, workflow)` is called
- **THEN** the return value SHALL be the empty string `""`

#### Scenario: Manual card summary carries no meta text

- **GIVEN** a manual trigger card rendered on the `/trigger` page
- **WHEN** the summary element is inspected
- **THEN** the `.trigger-meta-text` element SHALL be empty
- **AND** no schedule, URL, or method string SHALL appear in the summary

