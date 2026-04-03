## MODIFIED Requirements

### Requirement: httpTriggerMiddleware matches requests under /webhooks/

The `httpTriggerMiddleware` SHALL be a Hono middleware that intercepts requests under the `/webhooks/` path prefix, strips the prefix, looks up the remaining path and method in the registry, and either handles the request or returns 404.

The middleware factory SHALL accept a registry and a context factory function `(body, definition) => HttpTriggerContext`.

#### Scenario: Matching trigger request

- **WHEN** a `POST /webhooks/order` request is received
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** call the context factory function with the parsed body and trigger definition
- **AND** call `ctx.emit(definition.event, body)` to create and enqueue the event
- **AND** return the trigger's configured static response

#### Scenario: No matching trigger

- **WHEN** a `POST /webhooks/unknown` request is received
- **AND** no trigger is registered for path `"unknown"` and method `"POST"`
- **THEN** the middleware SHALL return a `404` response

#### Scenario: Non-JSON request body

- **WHEN** a `POST /webhooks/order` request is received with a non-JSON body
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL return a `400` response
