# HTTP Server Specification

## Purpose

Generic HTTP server foundation for the runtime. Accepts middleware and serves as the base for all platform HTTP endpoints.
## Requirements
### Requirement: createServer accepts middleware and returns a Hono app

`createServer` SHALL be replaced by two functions:
- `createApp(...middlewares)` SHALL accept zero or more Hono middleware functions and return a configured Hono application. It SHALL have no knowledge of triggers or any specific domain concept.
- `createServer(port, opts, middlewares, upgradeProviders?)` SHALL create the app via `createApp` and return a `Service` (with `start(): Promise<void>` and `stop(): Promise<void>`). The optional `upgradeProviders` parameter SHALL accept an array of values satisfying the `UpgradeProvider` interface (defined in the `triggers` capability). When omitted or empty, the function's behavior SHALL be byte-for-byte identical to the prior signature.

After `serve({fetch, port})` returns the underlying `http.Server`, `createServer` SHALL register one `'upgrade'` event listener per upgrade provider. Each listener SHALL invoke `provider.upgradeHandler(req, socket, head)` exactly once per matching upgrade event. If the provider declares a `pingInterval`, `createServer` SHALL be the consumer that wires the corresponding heartbeat interval (delegated to the provider's own implementation; `services/server.ts` does not own per-socket state).

The health middleware SHALL continue to be passed to `createServer` alongside the existing middlewares.

#### Scenario: createApp with middleware
- **WHEN** `createApp(middlewareA, middlewareB)` is called
- **THEN** the returned Hono app SHALL have both middleware mounted in order

#### Scenario: createApp with no middleware
- **WHEN** `createApp()` is called with no arguments
- **THEN** the returned Hono app SHALL be a valid Hono application

#### Scenario: createServer returns a Service
- **WHEN** `createServer(8080, opts, [middlewareA])` is called
- **THEN** the returned object has `start` and `stop` methods

#### Scenario: createServer with no upgrade providers behaves as before
- **WHEN** `createServer(8080, opts, middlewares)` is called with no fourth argument (or an empty array)
- **THEN** the http server SHALL NOT register any `'upgrade'` listener
- **AND** WS upgrade requests SHALL receive the default Node behavior (socket reset)

#### Scenario: Upgrade providers are wired after serve binds
- **GIVEN** a `createServer(8080, opts, middlewares, [wsProvider])` instance
- **WHEN** `start()` is called and `serve` returns the underlying `http.Server`
- **THEN** the server SHALL register exactly one `'upgrade'` listener per provider
- **AND** the listener SHALL invoke `wsProvider.upgradeHandler(req, socket, head)` for every upgrade event

#### Scenario: Server start listens on the specified port
- **GIVEN** a server created with `createServer(9090, opts, [])`
- **WHEN** `start()` is called
- **THEN** the HTTP server listens on port 9090
- **AND** the `start()` promise remains pending while the server is running

#### Scenario: Server start rejects on bind failure
- **GIVEN** port 8080 is already in use
- **WHEN** `createServer(8080, opts, []).start()` is called
- **THEN** the `start()` promise rejects with the bind error

#### Scenario: Server start ignores post-listen connection errors
- **GIVEN** a server that has successfully started listening
- **WHEN** a per-connection socket error occurs
- **THEN** the `start()` promise does NOT reject
- **AND** the server continues serving requests

#### Scenario: Server stop closes connections
- **GIVEN** a running server
- **WHEN** `stop()` is called
- **THEN** the server stops accepting new connections
- **AND** the `stop()` promise resolves when all existing connections are closed
- **AND** the `start()` promise resolves

#### Scenario: Health middleware is wired into the server
- **WHEN** the runtime initializes
- **THEN** `healthMiddleware` SHALL be passed to `createServer` with access to eventStore, storageBackend, and baseUrl

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

### Requirement: Server port is configurable via PORT environment variable

The runtime SHALL read the `PORT` environment variable to determine the HTTP server listen port. If `PORT` is not set, it SHALL default to `8080`.

#### Scenario: PORT env var is set
- **WHEN** the runtime starts with `PORT=9090`
- **THEN** the HTTP server SHALL listen on port 9090

#### Scenario: PORT env var is not set
- **WHEN** the runtime starts without a `PORT` environment variable
- **THEN** the HTTP server SHALL listen on port 8080

#### Scenario: Startup log includes the port
- **WHEN** the runtime starts
- **THEN** it SHALL log `Runtime listening on port <port>` with the actual port number

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

The server SHALL register a global `app.onError` handler on the top-level Hono app. When any downstream middleware or route handler throws (promise rejection or synchronous throw) and the exception propagates to the top level, the handler SHALL return a `500` response with a content-negotiated body using the same `Accept`-header rule as the 404 handler: HTML iff `Accept` contains `text/html`, JSON otherwise. The HTML body SHALL be the rendered `<ErrorPage/>` JSX component (defined in `packages/runtime/src/ui/error-pages.tsx`) via `c.html(<ErrorPage/>, 500)`; the JSON body SHALL be `{"error":"Internal Server Error"}`.

`<ErrorPage/>` SHALL render anonymously regardless of session state — it SHALL NOT read `c.get("user")` and SHALL NOT show user identity in the topbar. This preserves the "no user information" invariant and keeps the renderer well-defined when the failure is in session middleware itself (where `c.get("user")` would be `undefined`).

Handlers that explicitly `return c.json(..., 500)` (or any other non-thrown 5xx response) SHALL bypass this handler and keep their own body and status. This is intentional: the explicit body typically carries information specific to the failure (e.g. a structured validation error) that is more useful than the generic branded page.

#### Scenario: Browser request triggers thrown error

- **GIVEN** a route handler that throws an `Error` when invoked
- **WHEN** the route is requested with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the rendered `<ErrorPage/>` HTML
- **AND** `Content-Type` SHALL be `text/html; charset=utf-8`

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

