## ADDED Requirements

### Requirement: Dispatch provenance on trigger.request

Every `trigger.request` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`.

- `source` SHALL be `"trigger"` when the invocation was wired through a registered trigger backend (HTTP webhook POST at `/webhooks/*`, cron tick, future kinds).
- `source` SHALL be `"manual"` when the invocation was dispatched through the `/trigger/*` UI endpoint.
- `user` SHALL be present when `source === "manual"` AND the dispatching request carried an authenticated session (populated from the session as `{ name, mail }`). For manual fires in open-mode dev without an authenticated session, `user` SHALL be populated with the sentinel `{ name: "local", mail: "" }` so downstream UI chip tooltips have a non-empty attribution. `user` SHALL be absent for `source: "trigger"` dispatches.
- The `meta` container and the `dispatch` key it holds SHALL appear on the `trigger.request` event only. Other event kinds (`trigger.response`, `trigger.error`, `action.*`, `timer.*`, `fetch.*`, `wasi.*`, `system.*`) SHALL NOT carry `meta.dispatch`.

The dispatch blob SHALL be stamped by the runtime, never by the sandbox or by plugin code (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent"). Workflow handler code SHALL NOT see `meta.dispatch` — the `input` passed to the handler SHALL NOT include `dispatch`.

#### Scenario: External webhook POST produces source=trigger

- **GIVEN** an external caller sends `POST /webhooks/<tenant>/<workflow>/<name>` with a valid body
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Cron tick produces source=trigger

- **GIVEN** a cron trigger fires on schedule
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Authenticated UI fire produces source=manual with user

- **GIVEN** an authenticated user with session `{ name: "Jane Doe", mail: "jane@example.com" }` POSTs to `/trigger/<tenant>/<workflow>/<name>`
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`

#### Scenario: Unauthenticated open-mode UI fire produces source=manual with sentinel user

- **GIVEN** the server is running in open-mode dev and `/trigger/*` receives a POST with no session cookie (`c.get("authOpen")` is `true` and `c.get("user")` is undefined)
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "local", mail: "" } }`

#### Scenario: Non-trigger events do not carry meta.dispatch

- **GIVEN** an invocation that emits `trigger.request`, `action.request`, `action.response`, and `trigger.response`
- **WHEN** the events are inspected
- **THEN** only `trigger.request` SHALL carry `meta.dispatch`
- **AND** `action.request`, `action.response`, and `trigger.response` SHALL NOT carry a `meta` field (or `meta` SHALL be empty of `dispatch`)

#### Scenario: Workflow handler input omits dispatch

- **GIVEN** a workflow handler bound to an HTTP trigger fired from the UI by a named user
- **WHEN** the handler runs with `payload` as its argument
- **THEN** `payload` SHALL contain `{ body, headers, url, method }` and SHALL NOT contain a `dispatch` field
