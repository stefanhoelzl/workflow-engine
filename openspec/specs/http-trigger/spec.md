# HTTP Trigger Specification

## Purpose

Define the HTTP trigger factory, handler return value contract, payload shape, HTTP middleware delegation to the executor, trigger registry routing rules, and public ingress security context.

## Requirements

### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` object carrying the brand symbol `Symbol.for("@workflow-engine/http-trigger")`. The config SHALL accept: `path` (required string), `method` (optional string, default `"POST"`), `body` (optional Zod schema, default `z.unknown()`), `query` (optional Zod object schema), `params` (optional Zod object schema), `handler` (required `(payload) => Promise<HttpTriggerResult>`).

#### Scenario: httpTrigger returns branded object

- **GIVEN** `httpTrigger({ path: "x", body: z.object({}), handler: async () => ({}) })`
- **WHEN** the returned value is inspected
- **THEN** the returned value SHALL have `[Symbol.for("@workflow-engine/http-trigger")]: true`
- **AND** SHALL expose `path`, `method`, `body`, `handler` as readonly properties

#### Scenario: Method defaults to POST

- **WHEN** `httpTrigger({ path: "x", handler: ... })` is called without `method`
- **THEN** the returned object SHALL have `method: "POST"`

### Requirement: Trigger handler return value is the HTTP response

The HTTP trigger handler SHALL return a `Promise<HttpTriggerResult>` where `HttpTriggerResult = { status?, body?, headers? }`. The runtime SHALL use the returned object as the literal HTTP response, applying defaults: `status` = `200`, `body` = `""`, `headers` = `{}`.

#### Scenario: Handler controls status

- **GIVEN** a handler returning `{ status: 202 }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `202` with empty body and no extra headers

#### Scenario: Handler controls body

- **GIVEN** a handler returning `{ body: { ok: true } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `200` with body `{"ok":true}` (JSON-serialized)

#### Scenario: Handler controls headers

- **GIVEN** a handler returning `{ headers: { "X-Trace": "abc" } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL include header `X-Trace: abc`

### Requirement: Handler payload shape unchanged from prior model

The handler SHALL receive a single `payload` argument with fields: `body` (validated), `headers` (`Record<string, string>`), `url` (string), `method` (string), `params` (`Record<string, string>`), `query` (`Record<string, string | string[]>`).

#### Scenario: Payload carries body, headers, url, method, params, query

- **GIVEN** a `POST /webhooks/users/abc/status?x=1` request with body `{ "active": true }`
- **AND** a trigger with path `"users/:userId/status"`
- **WHEN** the handler is invoked
- **THEN** `payload.body` SHALL be `{ active: true }`
- **AND** `payload.headers` SHALL contain all request headers
- **AND** `payload.url` SHALL be the full request path with query string
- **AND** `payload.method` SHALL be `"POST"`
- **AND** `payload.params` SHALL be `{ userId: "abc" }`
- **AND** `payload.query` SHALL be `{ x: "1" }`

### Requirement: HTTP middleware delegates to executor

The HTTP trigger middleware SHALL match `/webhooks/*` requests against the trigger registry, validate the payload via Zod, and delegate to `executor.invoke(workflow, trigger, payload)`. The middleware SHALL serialize the executor's `HttpTriggerResult` as the HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<path>` request with valid payload
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL call `executor.invoke(workflow, trigger, payload)` exactly once
- **AND** the middleware SHALL serialize the result as the HTTP response

#### Scenario: Payload validation failure returns 422

- **GIVEN** a registered HTTP trigger with a body schema
- **WHEN** the request body fails Zod validation
- **THEN** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL NOT call the executor

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<path>` with no matching trigger
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: Non-JSON body returns 422

- **GIVEN** a request with a non-JSON body to a registered HTTP trigger
- **WHEN** the middleware tries to parse the body
- **THEN** the middleware SHALL return `422`

### Requirement: Trigger registry routing rules

The HTTP trigger registry SHALL match by path and method. Static paths SHALL take priority over parameterized ones. Path syntax supports static segments, named parameters (`:name`), and wildcard catch-all (`*name`). Multi-value query parameters SHALL be returned as arrays only when the query schema declares the field as an array; otherwise, the last value wins.

#### Scenario: Static path beats parameterized

- **GIVEN** trigger A with path `"users/admin"` and trigger B with path `"users/:userId"`
- **WHEN** `/webhooks/users/admin` is requested
- **THEN** trigger A SHALL be matched

#### Scenario: Parameterized path used when no static match

- **GIVEN** triggers A (`"users/admin"`) and B (`"users/:userId"`)
- **WHEN** `/webhooks/users/xyz` is requested
- **THEN** trigger B SHALL be matched with `params.userId = "xyz"`

#### Scenario: Wildcard catch-all extracts remaining path

- **GIVEN** a trigger with path `"files/*rest"`
- **WHEN** `/webhooks/files/docs/2024/report.pdf` is requested
- **THEN** the trigger SHALL be matched with `params.rest = "docs/2024/report.pdf"`

### Requirement: Public ingress security context

The HTTP trigger SHALL conform to the threat model documented at `/SECURITY.md S3 Webhook Ingress`. HTTP triggers are the project's PUBLIC ingress surface; the threat model treats all trigger input as attacker-controlled.

Changes that introduce new threats, weaken or remove a documented mitigation, add new trigger types, extend the payload shape passed to the sandbox, change trigger-to-route mapping semantics, or conflict with the rules in `/SECURITY.md S3` MUST update `/SECURITY.md S3` in the same change proposal.

#### Scenario: Change alters threat model

- **GIVEN** a change to this capability that affects an item enumerated in `/SECURITY.md S3`
- **WHEN** the change is proposed
- **THEN** the proposal SHALL include corresponding `/SECURITY.md S3` updates
