## MODIFIED Requirements

### Requirement: Dispatch provenance on trigger.request

Every `trigger.request` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "trigger" | "manual", user?: { login: string, mail: string } }`.

- `source` SHALL be `"trigger"` when the invocation was wired through a registered trigger backend (HTTP webhook POST at `/webhooks/*`, cron tick, future kinds).
- `source` SHALL be `"manual"` when the invocation was dispatched through the `/trigger/*` UI endpoint.
- `user` SHALL be present when `source === "manual"` AND the dispatching request carried an authenticated session (populated from the session as `{ login, mail }`). `user` SHALL be absent for `source: "trigger"` dispatches. The `login` field SHALL carry the GitHub login handle.
- The `meta` container and the `dispatch` key it holds SHALL appear on the `trigger.request` event only. Other event kinds (`trigger.response`, `trigger.error`, `action.*`, `timer.*`, `fetch.*`, `wasi.*`, `system.*`) SHALL NOT carry `meta.dispatch`.

The dispatch blob SHALL be stamped by the runtime, never by the sandbox or by plugin code (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent"). Workflow handler code SHALL NOT see `meta.dispatch` — the `input` passed to the handler SHALL NOT include `dispatch`.

#### Scenario: External webhook POST produces source=trigger

- **GIVEN** an external caller sends `POST /webhooks/<owner>/<repo>/<workflow>/<name>` with a valid body
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Cron tick produces source=trigger

- **GIVEN** a cron trigger fires on schedule
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Authenticated UI fire produces source=manual with user

- **GIVEN** an authenticated user with session `{ login: "alice", mail: "alice@example.com" }` POSTs to `/trigger/<owner>/<repo>/<workflow>/<name>`
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`

#### Scenario: Non-trigger events do not carry meta.dispatch

- **GIVEN** an invocation that emits `trigger.request`, `action.request`, `action.response`, and `trigger.response`
- **WHEN** the events are inspected
- **THEN** only `trigger.request` SHALL carry `meta.dispatch`
- **AND** `action.request`, `action.response`, and `trigger.response` SHALL NOT carry a `meta` field (or `meta` SHALL be empty of `dispatch`)

#### Scenario: Workflow handler input omits dispatch

- **GIVEN** a workflow handler bound to an HTTP trigger fired from the UI by a named user
- **WHEN** the handler runs with `payload` as its argument
- **THEN** `payload` SHALL contain `{ body, headers, url, method }` and SHALL NOT contain a `dispatch` field

## ADDED Requirements

### Requirement: InvocationEvent includes owner and repo

Every `InvocationEvent` produced by the runtime SHALL include two required top-level string fields: `owner` (the GitHub login that owns the workflow bundle) and `repo` (the repository name under that owner). These fields SHALL be stamped by the runtime at the sandbox-boundary widener (see `executor` spec); sandbox and plugin code SHALL NOT produce, read, or construct these fields.

`owner` SHALL match the owner regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`). `repo` SHALL match the repo regex (`^[a-zA-Z0-9._-]{1,100}$`). Values outside these regexes SHALL be rejected by the widener and cause the event to be dropped with an error log.

`owner` and `repo` SHALL identify the `(owner, repo)` bundle whose workflow produced the event. Across a single invocation's event stream, every event SHALL carry the same `(owner, repo)` values — they are invariant per invocation.

#### Scenario: trigger.request carries owner and repo

- **GIVEN** a workflow `runDemo` in the `acme/foo` bundle firing via webhook
- **WHEN** the executor emits the `trigger.request` event
- **THEN** the event SHALL contain `owner: "acme"` and `repo: "foo"`

#### Scenario: All events in one invocation share owner and repo

- **GIVEN** a workflow in `alice/utils` whose handler emits `action.request` + `action.response` + `trigger.response`
- **WHEN** all events in that invocation are collected
- **THEN** every event SHALL have `owner: "alice"` and `repo: "utils"`
- **AND** no event in the invocation SHALL carry different `owner` or `repo` values

#### Scenario: Guest-emitted event is widened with owner and repo

- **GIVEN** a workflow handler that calls `ctx.emit({ kind: "custom.event", ... })` without `owner` or `repo`
- **WHEN** the executor's `sb.onEvent` receives the sandbox event and widens it
- **THEN** the widener SHALL add `owner` and `repo` drawn from the invocation's scope
- **AND** the final `InvocationEvent` sent to the bus SHALL contain both fields
