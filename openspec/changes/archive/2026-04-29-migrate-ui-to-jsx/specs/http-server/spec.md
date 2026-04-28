## MODIFIED Requirements

### Requirement: Unmatched routes return 404

The server SHALL return a `404` response for requests that do not match any middleware or route. The response body SHALL be content-negotiated: if the request's `Accept` header explicitly includes `text/html` (in any segment, at any `q` value), the response body SHALL be the rendered `<NotFoundPage/>` JSX component (defined in `packages/runtime/src/ui/error-pages.tsx`) with `Content-Type: text/html; charset=utf-8`; otherwise the response body SHALL be `{"error":"Not Found"}` with `Content-Type: application/json`. A missing `Accept` header, `*/*`, and any header that does not include `text/html` (e.g. `application/json`, `text/css`, `*/*;q=0.8`) SHALL resolve to the JSON form.

The HTML page is rendered per-request via `c.html(<NotFoundPage/>, 404)` — the same delivery path as every other UI surface. There is no `?raw` build-time import, no in-memory string cache, and no `404.html` file on disk. The `Pages` interface that injects the not-found / error renderers into `createNotFoundHandler` / `createErrorHandler` SHALL carry component references (`{ NotFoundPage: FC, ErrorPage: FC }`), not pre-rendered strings.

#### Scenario: Browser request to unknown path

- **GIVEN** the global `notFound` handler is configured with `<NotFoundPage/>` from `error-pages.tsx`
- **WHEN** a `GET /nonexistent` request is received with `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`
- **THEN** the server SHALL return a `404` response
- **AND** the response body SHALL be the rendered `<NotFoundPage/>` HTML
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

- **GIVEN** sub-apps are mounted through the `Middleware` abstraction — each middleware is a `{ match: string, handler: MiddlewareHandler }` object, and `createApp` installs it with `app.use(match, handler)`. For `/trigger/*`, `triggerMiddleware` builds a sub-Hono app internally and exposes `handler: (c) => subApp.fetch(c.req.raw)` so the parent app forwards to the sub-app. Each sub-app installs `app.notFound(createNotFoundHandler())` from `content-negotiation.ts`.
- **WHEN** a `GET /trigger/nonexistent-page` request is received with `Accept: text/html`
- **THEN** the response body SHALL be the rendered `<NotFoundPage/>` HTML
- **AND** the response status SHALL be `404`

#### Scenario: Every sub-app uses the shared notFound factory

- **GIVEN** the runtime mounts sub-apps at `/api`, `/trigger`, and `/dashboard`
- **WHEN** each sub-app is constructed
- **THEN** it SHALL call `app.notFound(createNotFoundHandler())` so that unmatched paths within the sub-app return the same Accept-branched body as unmatched paths at the parent level

### Requirement: Global error handler for unhandled exceptions

The server SHALL register a global `app.onError` handler on the top-level Hono app. When any downstream middleware or route handler throws (promise rejection or synchronous throw) and the exception propagates to the top level, the handler SHALL return a `500` response with a content-negotiated body using the same `Accept`-header rule as the 404 handler: HTML iff `Accept` contains `text/html`, JSON otherwise. The HTML body SHALL be the rendered `<ErrorPage/>` JSX component (defined in `packages/runtime/src/ui/error-pages.tsx`) via `c.html(<ErrorPage/>, 500)`; the JSON body SHALL be `{"error":"Internal Server Error"}`.

`<ErrorPage/>` SHALL render anonymously regardless of session state — it SHALL NOT read `c.get("user")` and SHALL NOT show user identity in the topbar. This preserves the "no user information" invariant and keeps the renderer well-defined when the failure is in session middleware itself (where `c.get("user")` would be `undefined`).

Handlers that explicitly `return c.json(..., 500)` (or any other non-thrown 5xx response) SHALL bypass this handler and keep their own body and status. This is intentional: the explicit body typically carries information specific to the failure (e.g. a structured validation error) that is more useful than the generic branded page.

#### Scenario: Browser request triggers thrown error

- **GIVEN** a route handler that throws an `Error` when invoked
- **WHEN** the route is requested with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the rendered `<ErrorPage/>` HTML
- **AND** `Content-Type` SHALL be `text/html; charset=utf-8`

#### Scenario: JSON client triggers thrown error

- **GIVEN** a route handler that throws an `Error` when invoked
- **WHEN** the route is requested with `Accept: application/json`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be `{"error":"Internal Server Error"}`
- **AND** `Content-Type` SHALL be `application/json`

#### Scenario: Anonymous render even when user is present in context

- **GIVEN** session middleware ran successfully and set `c.set("user", { name: "alice", … })`
- **WHEN** a downstream handler throws and the global `onError` handler renders the page with `Accept: text/html`
- **THEN** the response body SHALL contain the topbar but SHALL NOT contain the string "alice" or the user's email
- **AND** the topbar user section SHALL render as anonymous

#### Scenario: Session middleware throws before setting user

- **GIVEN** session middleware itself throws before setting `c.set("user", ...)`
- **WHEN** the global `onError` handler runs with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the rendered `<ErrorPage/>` HTML
- **AND** the renderer SHALL NOT attempt to read `c.get("user")`
