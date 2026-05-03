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

- **GIVEN** the runtime mounts sub-apps at `/api`, `/trigger`, and `/invocations`
- **WHEN** each sub-app is constructed
- **THEN** it SHALL call `app.notFound(createNotFoundHandler())` so that unmatched paths within the sub-app return the same Accept-branched body as unmatched paths at the parent level

### Requirement: Root redirect

The server SHALL redirect `GET /` to `/trigger` with a `302` status. The redirect SHALL match the exact root path only; requests to any other path SHALL NOT be redirected by this handler.

#### Scenario: Root redirects to /trigger
- **WHEN** a `GET /` request is received
- **THEN** the response status SHALL be `302`
- **AND** the `Location` header SHALL be `/trigger`

#### Scenario: Non-root paths are not redirected
- **WHEN** a `GET /invocations` request is received
- **THEN** the response SHALL NOT be a redirect produced by the root-redirect handler

#### Scenario: Redirect precedes the static middleware
- **GIVEN** the static middleware is mounted at `/static/*`
- **WHEN** a `GET /` request is received
- **THEN** the root-redirect handler SHALL fire
- **AND** the static middleware SHALL NOT be invoked
