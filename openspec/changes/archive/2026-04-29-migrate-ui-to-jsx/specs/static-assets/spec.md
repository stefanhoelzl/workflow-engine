## MODIFIED Requirements

### Requirement: 404 HTML page

The runtime SHALL render the `404` HTML page via a `<NotFoundPage/>` JSX component (in `packages/runtime/src/ui/error-pages.tsx`) that composes the shared `<Layout>` component. The page SHALL include the top bar with the brand element (icon and "Workflow Engine" text) but SHALL NOT show user identity in the topbar — it renders anonymously regardless of session state. The page body SHALL display a centered "Page not found" heading, a descriptive message ("The page you're looking for doesn't exist."), and a styled link to `/dashboard/` labeled "Go to dashboard". The page SHALL NOT contain any inline `<style>` block, inline `<script>` block, inline event-handler attributes (`on*=`), or `javascript:` URLs, so that it renders cleanly under the app's CSP.

The page SHALL be rendered per-request by the global `notFound` handler when the request's `Accept` header includes `text/html`. Rendering goes through `c.html(<NotFoundPage/>, 404)` — the same delivery path as every other UI surface. There SHALL NOT be an in-memory cache of a pre-rendered string and SHALL NOT be a `404.html` file in the static assets directory.

A direct `GET /static/404.html` SHALL return a 404 from the static middleware (the file does not exist).

#### Scenario: 404 page structure

- **WHEN** a 404 response is rendered to a browser
- **THEN** it SHALL display the top bar with brand
- **AND** it SHALL display "Page not found" as a heading
- **AND** it SHALL display a "Go to dashboard" link pointing to `/dashboard/`
- **AND** the topbar SHALL NOT show user identity even if the request carries a valid session cookie

#### Scenario: 404 page links only workflow-engine.css

- **WHEN** a 404 response is rendered
- **THEN** the HTML SHALL contain exactly one `<link rel="stylesheet">` element with `href="/static/workflow-engine.css"`
- **AND** it SHALL NOT contain a `<link>` to `/static/error.css`

#### Scenario: 404 page is CSP-clean

- **WHEN** a 404 response is rendered
- **THEN** the HTML SHALL NOT contain any `<style>` element
- **AND** it SHALL NOT contain any `<script>` element with inline content (script tags pointing at `/static/*.js` are permitted; `<script type="application/json">` data is permitted)
- **AND** it SHALL NOT contain any attribute whose name matches `on[a-z]+`
- **AND** it SHALL NOT contain any `href` or `src` whose value begins with `javascript:`

#### Scenario: Unknown path returns styled 404 to a browser

- **WHEN** a request is made to a path not matching any mounted middleware (e.g., `/nonexistent`) with `Accept: text/html`
- **THEN** the response status SHALL be `404`
- **AND** the response body SHALL be the rendered `<NotFoundPage/>` HTML

#### Scenario: Sub-app 404 returns styled 404 to a browser

- **WHEN** a request to a mounted sub-app route (e.g., `/dashboard/nonexistent-page`) results in a 404 with `Accept: text/html`
- **THEN** the response body SHALL be the rendered `<NotFoundPage/>` HTML (not the app's raw 404 text and not a JSON error body)

#### Scenario: Direct request to /static/404.html returns 404

- **WHEN** a `GET /static/404.html` request is made
- **THEN** the response status SHALL be `404` (the file does not exist; the static middleware returns its standard not-found response)
- **AND** the response body SHALL be the standard not-found body for static-middleware misses (per the "Non-existent static file" scenario), NOT the rendered `<NotFoundPage/>`

### Requirement: 5xx error page

The runtime SHALL render the `5xx` HTML error page via an `<ErrorPage/>` JSX component (in `packages/runtime/src/ui/error-pages.tsx`) that composes the shared `<Layout>` component. The page SHALL include the top bar with the brand element (icon and "Workflow Engine" text) but SHALL NOT show user identity in the topbar — it renders anonymously regardless of session state. The page body SHALL display a centered "Something went wrong" heading, a descriptive message, and a styled link back to `/` (labeled "Go home" or equivalent). It SHALL NOT contain any inline `<style>` block, inline `<script>` block, inline event-handler attributes (`on*=`), or `javascript:` URLs — the page is rendered by the app under the app's CSP.

The page SHALL be rendered per-request by the global `onError` handler (for thrown exceptions) when the request's `Accept` header includes `text/html`. Rendering goes through `c.html(<ErrorPage/>, 500)`. There SHALL NOT be an in-memory cache of a pre-rendered string and SHALL NOT be an `error.html` file in the static assets directory. The page SHALL NOT be served by any reverse-proxy error-interception plugin, and the app SHALL NOT depend on any proxy-level error handling to produce a 5xx HTML body.

The page SHALL rely on the same design tokens (`:root` custom properties for colors, spacing, typography) defined in `workflow-engine.css` that every other app page uses, and SHALL automatically pick up dark-mode colors via the `prefers-color-scheme` media query declarations already present in `workflow-engine.css`.

When the global `onError` handler is invoked for a request whose session middleware itself threw (so `c.get("user")` is `undefined`), the renderer SHALL still produce the page; user identity is never read on this path.

#### Scenario: Thrown exception returns styled 5xx to a browser

- **GIVEN** a route handler that throws an uncaught exception
- **WHEN** the route is requested with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the rendered `<ErrorPage/>` HTML
- **AND** the topbar SHALL NOT show user identity even if the request carries a valid session cookie

#### Scenario: 5xx page links only workflow-engine.css

- **WHEN** a 500 response is rendered
- **THEN** the HTML SHALL contain exactly one `<link rel="stylesheet">` element with `href="/static/workflow-engine.css"`

#### Scenario: 5xx page is CSP-clean

- **WHEN** a 500 response is rendered
- **THEN** the HTML SHALL NOT contain any `<style>` element
- **AND** it SHALL NOT contain any `<script>` element with inline content
- **AND** it SHALL NOT contain any attribute whose name matches `on[a-z]+`
- **AND** it SHALL NOT contain any `href` or `src` whose value begins with `javascript:`

#### Scenario: 5xx page supports dark mode via linked stylesheet

- **GIVEN** `workflow-engine.css` defines `:root` dark-mode overrides under `@media (prefers-color-scheme: dark)`
- **WHEN** the user's system is in dark mode and the error page is rendered
- **THEN** the page SHALL render with the dark theme tokens without requiring any inline CSS

#### Scenario: Direct request to /static/error.html returns 404

- **WHEN** a `GET /static/error.html` request is made
- **THEN** the response status SHALL be `404` (the file does not exist; the static middleware returns its standard not-found response)

#### Scenario: Session-middleware failure still renders the page

- **GIVEN** the session middleware itself throws before setting `c.set("user", ...)`
- **WHEN** the global `onError` handler runs with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the rendered `<ErrorPage/>` HTML
- **AND** the renderer SHALL NOT attempt to read `c.get("user")` (anonymous render is unconditional)

