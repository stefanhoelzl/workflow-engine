## MODIFIED Requirements

### Requirement: ActionContext fetch method

The system SHALL provide a `fetch(url: string | URL, init?: RequestInit): Promise<Response>` method on `ActionContext` that delegates to an injected fetch function.

When called from within the QuickJS sandbox, the Response SHALL be proxied as a simplified object with:
- `status` (number), `statusText` (string), `ok` (boolean), `url` (string) as properties
- `headers` as a `Map` with lowercase-normalized keys
- `json()` as an async method bridged to the host
- `text()` as an async method bridged to the host

The host-side `ActionContext.fetch()` method remains unchanged — it still delegates to the injected fetch function with logging. The Response proxy is constructed by the sandbox bridge layer, not by `ActionContext` itself.

#### Scenario: Action performs a GET request via sandbox

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** action code in the sandbox calls `await ctx.fetch("https://api.example.com/orders/123")`
- **THEN** the host-side `ActionContext.fetch()` is called
- **AND** the sandbox bridge constructs a Response proxy from the real Response
- **AND** the proxy is returned to the action code inside QuickJS

#### Scenario: Action reads response headers via Map

- **GIVEN** a fetch response with headers `Content-Type: application/json` and `X-Request-Id: abc`
- **WHEN** action code accesses `res.headers.get("content-type")`
- **THEN** the value is `"application/json"`
- **AND** `res.headers.has("x-request-id")` returns `true`

#### Scenario: Action parses JSON response body

- **GIVEN** a fetch response with body `{"key": "value"}`
- **WHEN** action code calls `await res.json()`
- **THEN** the result is `{ key: "value" }` inside QuickJS
- **AND** the body is read on the host side and marshalled into QuickJS

#### Scenario: Action reads text response body

- **GIVEN** a fetch response with body `"hello"`
- **WHEN** action code calls `await res.text()`
- **THEN** the result is `"hello"` inside QuickJS

#### Scenario: Fetch error propagates to action

- **GIVEN** an `ActionContext` with an injected fetch function that rejects
- **WHEN** action code in the sandbox calls `await ctx.fetch("https://unreachable.example.com")`
- **THEN** the QuickJS promise rejects with an error containing the host error message
- **AND** the action can catch the error or let it propagate as a failed `SandboxResult`
