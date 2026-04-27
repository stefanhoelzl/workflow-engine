## MODIFIED Requirements

### Requirement: HTTP middleware delegates to executor

The HTTP `TriggerSource` SHALL expose a Hono middleware mounted at `/webhooks/*`. The middleware SHALL parse the URL as exactly four segments after the `/webhooks/` prefix: `<owner>`, `<repo>`, `<workflow-name>`, `<trigger-name>`. URLs with a different number of segments SHALL return `404`. `<owner>` and `<workflow-name>` SHALL match the owner regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`; `<repo>` SHALL match the repo regex `^[a-zA-Z0-9._-]{1,100}$`; `<trigger-name>` SHALL match the trigger-name regex `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Query strings on the URL SHALL be tolerated (they pass through unchanged in `payload.url`) but SHALL NOT be parsed into a structured payload field.

The middleware SHALL look up the matching entry via a per-(owner, repo) constant-time `Map` keyed by `(workflow-name, trigger-name)`. If no entry is found, or the entry's `descriptor.method` does not equal the request's method, the middleware SHALL return `404` (identical to "no matching trigger" to prevent enumeration per `/SECURITY.md §3 R-W5`). The middleware SHALL NOT emit any event for 404 responses.

On match, the middleware SHALL parse the JSON body (422 on invalid JSON), assemble the raw input `{ body, headers, url, method }`, and call `entry.fire(input)` on the matched `TriggerEntry`. The HTTP source SHALL NOT call `executor.invoke` directly; all executor interaction happens inside the `fire` closure captured on the `TriggerEntry`, which is constructed by the `WorkflowRegistry` via `buildFire` and performs input-schema validation + executor dispatch.

The middleware SHALL serialize the returned `InvokeResult<unknown>` into the HTTP response: `{ok: true, output}` → serialize `output`; `{ok: false, error: {issues, ...}}` → `422` with the validation issues; `{ok: false, error: {...}}` without `issues` → `500` with `{ error: "internal_error" }`.

When the middleware emits a `422` for body validation issues (i.e. `error.issues` is present), the middleware SHALL — in addition to returning the response — invoke `entry.exception({ kind: "trigger.rejection", name: "http.body-validation", input: { issues, method: <request method>, path: <pathname only, no query string> } })` exactly once per rejected request. The HTTP request body SHALL NOT be persisted on the event. `entry.exception` is the per-trigger callable bound to `executor.fail` by the registry's `buildException` helper (see `executor/spec.md` "Executor.fail emits trigger.exception leaf events").

When the middleware emits a `500` (handler threw), it SHALL NOT emit a `trigger.rejection` event — handler throws are already covered by `trigger.error` close events emitted from inside the sandbox.

When the middleware emits a `422` due to invalid JSON (body could not be parsed at all), it SHALL NOT emit a `trigger.rejection` event — invalid JSON is treated as a transport-level error indistinguishable from scanner noise.

The HTTP source SHALL be the only component that parses `/webhooks/*` URLs and the only component that converts handler output to an HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<owner>/<repo>/<workflow>/<trigger-name>` request with valid body
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL resolve the matching `TriggerEntry` via its per-(owner, repo) routing index
- **AND** the middleware SHALL call `entry.fire(input)` exactly once with `{body, headers, url, method}`
- **AND** on `{ok: true, output}` the middleware SHALL serialize `output` as the HTTP response
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Body validation failure returns 422 and emits trigger.rejection

- **GIVEN** a registered HTTP trigger with a body schema requiring `{name: string}`
- **WHEN** a request arrives with body `{}` (missing `name`)
- **THEN** the middleware SHALL call `entry.fire(input)`
- **AND** the `fire` closure SHALL resolve to `{ok: false, error: {issues: [...]}}`
- **AND** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL invoke `entry.exception({ kind: "trigger.rejection", name: "http.body-validation", input: { issues: [...], method: "POST", path: "/webhooks/<owner>/<repo>/<workflow>/<trigger-name>" } })` exactly once
- **AND** the emitted event SHALL NOT carry the request body
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: No matching trigger returns 404 and emits no event

- **GIVEN** a request to `/webhooks/<owner>/<repo>/<workflow>/<unknown-trigger-name>` with a valid four-segment shape but no registered trigger with that name
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: URL with wrong segment count returns 404 and emits no event

- **GIVEN** a request to `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>/extra` (extra segment) or `/webhooks/<owner>/<repo>/<workflow>` (missing segment)
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Method mismatch returns 404 and emits no event

- **GIVEN** a registered HTTP trigger with `method: "POST"`
- **WHEN** a `GET` request to the trigger's URL is processed
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Non-JSON body returns 422 and emits no trigger.rejection

- **GIVEN** a registered HTTP trigger
- **WHEN** the request body is not valid JSON
- **THEN** the middleware SHALL return `422` without calling `entry.fire`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event (JSON-parse failures are treated as transport-level noise)

#### Scenario: Handler throw returns 500 and emits no trigger.rejection

- **GIVEN** a registered HTTP trigger whose handler throws
- **WHEN** the middleware processes the request
- **THEN** `entry.fire` SHALL return `{ok: false, error: {message, stack}}` without `issues`
- **AND** the middleware SHALL serialize a `500` response with `{ error: "internal_error" }`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event (the handler-throw path emits `trigger.error` from inside the sandbox)

#### Scenario: Path field carries pathname only, no query string

- **GIVEN** a request `POST /webhooks/<owner>/<repo>/<workflow>/<trigger-name>?delivery=abc&x=1` whose body fails validation
- **WHEN** the middleware emits the `trigger.rejection` event
- **THEN** the event's `input.path` SHALL be `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>` (pathname only)
- **AND** the event's `input.path` SHALL NOT contain the query string
