## MODIFIED Requirements

### Requirement: HTTP middleware delegates to executor

The HTTP trigger middleware SHALL match `/webhooks/*` requests against the HTTP `TriggerSource`'s internal routing index, normalize the request into an `input` object, and call `entry.fire(input)` on the matched entry. The middleware SHALL serialize the returned `InvokeResult<unknown>` into the HTTP response.

The HTTP `TriggerSource` SHALL NOT call `executor.invoke` directly. All executor interaction happens via the `fire` closure captured on the `TriggerEntry`, which is constructed by the `WorkflowRegistry`.

Normalization of the request into `input` SHALL produce `{body, headers, url, method, params, query}` (unchanged from today). The middleware SHALL NOT perform Zod/Ajv validation against the descriptor's `inputSchema` — that validation is performed inside the `fire` closure by the registry's `buildFire` helper.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<tenant>/<workflow>/<path>` request
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL resolve the matching `TriggerEntry` via its internal routing index
- **AND** the middleware SHALL call `entry.fire(input)` exactly once with the normalized input
- **AND** on `{ok: true, output}` the middleware SHALL serialize `output` as the HTTP response
- **AND** on `{ok: false, error}` the middleware SHALL return `500` with body `{error: "internal_error"}` (unchanged from today)

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<path>` with no matching trigger in the HTTP source's index
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: Input validation failure does not reach the executor

- **GIVEN** a registered HTTP trigger with a body schema requiring `{name: string}`
- **WHEN** a request arrives with body `{}` (missing `name`)
- **THEN** the middleware SHALL call `entry.fire(input)` with the unnormalized input
- **AND** the `fire` closure SHALL resolve to `{ok: false, error: {message: <validation details>}}`
- **AND** the middleware SHALL return a `422` response with the validation details in the body
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: HTTP source implements the TriggerSource contract

- **GIVEN** the HTTP trigger source factory
- **WHEN** the returned value is inspected
- **THEN** it SHALL expose `kind: "http"`, `start()`, `stop()`, and `reconfigure(tenant, entries): Promise<ReconfigureResult>`
- **AND** its `reconfigure` SHALL store entries keyed by tenant (internally) so that `reconfigure("acme", [])` clears only `acme`'s entries and not any other tenant's

#### Scenario: HTTP source maps user-visible errors into {ok: false}

- **GIVEN** an HTTP source that detects an invalid configuration during reconfigure (e.g., two triggers for the same tenant/workflow share a routing key under today's configurable-path model)
- **WHEN** `reconfigure(tenant, entries)` is called with the offending entries
- **THEN** the source SHALL return `{ok: false, errors: [TriggerConfigError, …]}`
- **AND** entries that did not conflict SHALL NOT be partially applied (the whole tenant's replacement is atomic or not at all)
