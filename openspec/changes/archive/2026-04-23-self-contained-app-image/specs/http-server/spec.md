## MODIFIED Requirements

### Requirement: Unmatched routes return 404

The server SHALL return a `404` response for requests that do not match any middleware or route. The response body SHALL be content-negotiated: if the request's `Accept` header explicitly includes `text/html` (in any segment, at any `q` value), the response body SHALL be the cached `404.html` page content with `Content-Type: text/html; charset=utf-8`; otherwise the response body SHALL be `{"error":"Not Found"}` with `Content-Type: application/json`. A missing `Accept` header, `*/*`, and any header that does not include `text/html` (e.g. `application/json`, `text/css`, `*/*;q=0.8`) SHALL resolve to the JSON form.

#### Scenario: Browser request to unknown path
- **GIVEN** the 404 body cache is populated at startup from `packages/runtime/src/ui/static/404.html`
- **WHEN** a `GET /nonexistent` request is received with `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`
- **THEN** the server SHALL return a `404` response
- **AND** the response body SHALL be the cached `404.html` content
- **AND** `Content-Type` SHALL be `text/html; charset=utf-8`

#### Scenario: JSON client request to unknown path
- **WHEN** a `GET /nonexistent` request is received with `Accept: application/json`
- **THEN** the server SHALL return a `404` response
- **AND** the response body SHALL be `{"error":"Not Found"}`
- **AND** `Content-Type` SHALL be `application/json`

#### Scenario: Request without Accept header defaults to JSON
- **WHEN** a `GET /nonexistent` request is received with no `Accept` header
- **THEN** the server SHALL return a `404` response
- **AND** the response body SHALL be `{"error":"Not Found"}`
- **AND** `Content-Type` SHALL be `application/json`

#### Scenario: Accept wildcard resolves to JSON
- **WHEN** a `GET /nonexistent` request is received with `Accept: */*`
- **THEN** the server SHALL return a `404` response
- **AND** the response body SHALL be `{"error":"Not Found"}`

#### Scenario: Sub-app 404 returns the same body via the shared factory
- **GIVEN** `/trigger/*` is mounted as a sub-Hono-app via `app.use("/trigger/*", (c) => subApp.fetch(c.req.raw))`, and the sub-app installs `app.notFound(createNotFoundHandler())` from `content-negotiation.ts`
- **WHEN** a `GET /trigger/nonexistent-page` request is received with `Accept: text/html`
- **THEN** the response body SHALL be the cached `404.html` content
- **AND** the response status SHALL be `404`

#### Scenario: Every sub-app uses the shared notFound factory
- **GIVEN** the runtime mounts sub-apps at `/api`, `/trigger`, and `/dashboard`
- **WHEN** each sub-app is constructed
- **THEN** it SHALL call `app.notFound(createNotFoundHandler())` so that unmatched paths within the sub-app return the same Accept-branched body as unmatched paths at the parent level

## ADDED Requirements

### Requirement: Root redirect

The server SHALL redirect `GET /` to `/trigger` with a `302` status. The redirect SHALL match the exact root path only; requests to any other path SHALL NOT be redirected by this handler.

#### Scenario: Root redirects to /trigger
- **WHEN** a `GET /` request is received
- **THEN** the response status SHALL be `302`
- **AND** the `Location` header SHALL be `/trigger`

#### Scenario: Non-root paths are not redirected
- **WHEN** a `GET /dashboard` request is received
- **THEN** the response SHALL NOT be a redirect produced by the root-redirect handler

#### Scenario: Redirect precedes the static middleware
- **GIVEN** the static middleware is mounted at `/static/*`
- **WHEN** a `GET /` request is received
- **THEN** the root-redirect handler SHALL fire
- **AND** the static middleware SHALL NOT be invoked

### Requirement: Global error handler for unhandled exceptions

The server SHALL register a global `app.onError` handler on the top-level Hono app. When any downstream middleware or route handler throws (promise rejection or synchronous throw) and the exception propagates to the top level, the handler SHALL return a `500` response with a content-negotiated body using the same `Accept`-header rule as the 404 handler: HTML iff `Accept` contains `text/html`, JSON otherwise. The HTML body SHALL be the cached contents of `packages/runtime/src/ui/static/error.html`; the JSON body SHALL be `{"error":"Internal Server Error"}`.

Handlers that explicitly `return c.json(..., 500)` (or any other non-thrown 5xx response) SHALL bypass this handler and keep their own body and status. This is intentional: the explicit body typically carries information specific to the failure (e.g. a structured validation error) that is more useful than the generic branded page.

#### Scenario: Browser request triggers thrown error
- **GIVEN** a route handler that throws an `Error` when invoked
- **WHEN** the route is requested with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the cached `error.html` content
- **AND** `Content-Type` SHALL be `text/html; charset=utf-8`

#### Scenario: JSON client triggers thrown error
- **GIVEN** a route handler that throws an `Error` when invoked
- **WHEN** the route is requested with `Accept: application/json`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be `{"error":"Internal Server Error"}`

#### Scenario: Explicit 5xx return bypasses the handler
- **GIVEN** a route handler that returns `c.json({error: "specific"}, 500)`
- **WHEN** the route is requested with any `Accept` header
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be `{"error":"specific"}` (not the branded page)

#### Scenario: CSP headers still apply to the error body
- **GIVEN** the `secureHeadersMiddleware` is mounted ahead of the error handler
- **WHEN** a thrown error produces an HTML 5xx response
- **THEN** the response SHALL carry the same `Content-Security-Policy` header as any other HTML page served by the app
