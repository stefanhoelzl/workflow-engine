## MODIFIED Requirements

### Requirement: HTTP middleware delegates to executor

The HTTP trigger middleware SHALL match `/webhooks/<tenant>/<workflow-name>/<trigger-path>` requests against the trigger registry, validate the payload via Zod, and delegate to `executor.invoke(tenant, workflow, trigger, payload)`. The middleware SHALL serialize the executor's `HttpTriggerResult` as the HTTP response.

The middleware SHALL validate `<tenant>` and `<workflow-name>` against their respective identifier regexes; non-matching values SHALL receive `404 Not Found`.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger at `(tenant="acme", name="foo", path="orders")` and a matching `POST /webhooks/acme/foo/orders` request with valid payload
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL call `executor.invoke("acme", "foo", trigger, payload)` exactly once
- **AND** the middleware SHALL serialize the result as the HTTP response

#### Scenario: Payload validation failure returns 422

- **GIVEN** a registered HTTP trigger with a body schema
- **WHEN** the request body fails Zod validation
- **THEN** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL NOT call the executor

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<name>/<path>` with no matching trigger (unknown tenant, unknown workflow, or unknown path)
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** the response SHALL NOT distinguish between "tenant unknown", "workflow unknown", and "path unknown"

#### Scenario: Non-JSON body returns 422

- **GIVEN** a request with a non-JSON body to a registered HTTP trigger
- **WHEN** the middleware tries to parse the body
- **THEN** the middleware SHALL return `422`

#### Scenario: Invalid tenant or workflow name in URL returns 404

- **GIVEN** a request to `/webhooks/..foo/bar/orders` (tenant fails regex) or `/webhooks/acme/-bad/orders` (workflow name fails regex)
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

### Requirement: Trigger registry routing rules

The HTTP trigger registry SHALL be keyed by `(tenant, workflow-name, trigger-path)`. Routing SHALL match on all three dimensions. Within a given `(tenant, workflow-name)` scope, path matching SHALL follow the existing rules: static paths take priority over parameterized ones; path syntax supports static segments, named parameters (`:name`), and wildcard catch-all (`*name`); multi-value query parameters SHALL be returned as arrays only when the query schema declares the field as an array.

Triggers from different tenants or different workflows within the same tenant SHALL be isolated: a path `"orders"` registered at `(acme, foo)` and at `(contoso, bar)` SHALL be reachable independently and SHALL NOT collide.

#### Scenario: Same path in two tenants coexists

- **GIVEN** trigger A at `(tenant="acme", name="foo", path="orders")` and trigger B at `(tenant="contoso", name="bar", path="orders")`
- **WHEN** `POST /webhooks/acme/foo/orders` is requested
- **THEN** trigger A SHALL be matched
- **WHEN** `POST /webhooks/contoso/bar/orders` is requested
- **THEN** trigger B SHALL be matched

#### Scenario: Same path in two workflows of one tenant coexists

- **GIVEN** trigger A at `(acme, foo, "orders")` and trigger B at `(acme, bar, "orders")`
- **WHEN** `POST /webhooks/acme/foo/orders` is requested
- **THEN** trigger A SHALL be matched

#### Scenario: Static path beats parameterized within a workflow

- **GIVEN** trigger A with path `"users/admin"` and trigger B with path `"users/:userId"`, both on `(tenant="acme", name="foo")`
- **WHEN** `/webhooks/acme/foo/users/admin` is requested
- **THEN** trigger A SHALL be matched

#### Scenario: Parameterized path used when no static match

- **GIVEN** triggers A (`"users/admin"`) and B (`"users/:userId"`) on `(acme, foo)`
- **WHEN** `/webhooks/acme/foo/users/xyz` is requested
- **THEN** trigger B SHALL be matched with `params.userId = "xyz"`

#### Scenario: Wildcard catch-all extracts remaining path

- **GIVEN** a trigger with path `"files/*rest"` on `(acme, foo)`
- **WHEN** `/webhooks/acme/foo/files/docs/2024/report.pdf` is requested
- **THEN** the trigger SHALL be matched with `params.rest = "docs/2024/report.pdf"`

### Requirement: Public ingress security context

The HTTP trigger SHALL conform to the threat model documented at `/SECURITY.md §3 Webhook Ingress`. HTTP triggers remain the project's PUBLIC ingress surface; the threat model treats all trigger input as attacker-controlled. The tenant prefix in the URL is **identification, not authorization** — knowledge of a valid `(tenant, workflow-name, trigger-path)` URL suffices to trigger the workflow; there is no caller authentication on the webhook path.

Changes that introduce new threats, weaken or remove a documented mitigation, add new trigger types, extend the payload shape passed to the sandbox, change trigger-to-route mapping semantics, or conflict with the rules in `/SECURITY.md §3` MUST update `/SECURITY.md §3` in the same change proposal.

#### Scenario: Tenant prefix does not gate access

- **GIVEN** a workflow registered at `(acme, foo, "orders")`
- **WHEN** an unauthenticated request is made to `POST /webhooks/acme/foo/orders` with a valid payload
- **THEN** the trigger SHALL fire
- **AND** the handler SHALL execute regardless of caller identity

#### Scenario: Change alters threat model

- **GIVEN** a change to this capability that affects an item enumerated in `/SECURITY.md §3`
- **WHEN** the change is proposed
- **THEN** the proposal SHALL include corresponding `/SECURITY.md §3` updates
