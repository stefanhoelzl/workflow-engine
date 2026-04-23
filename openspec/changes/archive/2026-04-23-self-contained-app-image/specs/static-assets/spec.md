## MODIFIED Requirements

### Requirement: 404 HTML page

The static assets directory SHALL include a `404.html` file. The file SHALL be a complete HTML page that links to `/static/workflow-engine.css` for styling. It SHALL NOT link `/static/error.css` (the rules formerly in `error.css` are merged into `workflow-engine.css`). It SHALL include the top bar with the brand element (icon and "Workflow Engine" text) but no user information. The page body SHALL display a centered "Page not found" heading, a descriptive message ("The page you're looking for doesn't exist."), and a styled link to `/dashboard/` labeled "Go to dashboard". The page SHALL NOT contain any inline `<style>` block, inline `<script>` block, inline event-handler attributes (`on*=`), or `javascript:` URLs, so that it renders cleanly under the app's CSP.

The HTML body SHALL be loaded once at runtime startup into an in-memory cache and served by the app's global `notFound` handler when the request's `Accept` header includes `text/html`. A direct request to `/static/404.html` SHALL continue to serve the same file through the static middleware.

#### Scenario: 404.html served as static asset
- **WHEN** a GET request is made to `/static/404.html`
- **THEN** the response body SHALL contain the 404 HTML page
- **AND** `Content-Type` SHALL be `text/html`
- **AND** `Cache-Control` SHALL be `public, max-age=31536000, immutable`

#### Scenario: 404 page structure
- **WHEN** the 404.html file is rendered in a browser
- **THEN** it SHALL display the top bar with brand
- **AND** it SHALL display "Page not found" as a heading
- **AND** it SHALL display a "Go to dashboard" link pointing to `/dashboard/`

#### Scenario: 404 page links only workflow-engine.css
- **WHEN** the 404.html file is inspected
- **THEN** it SHALL contain exactly one `<link rel="stylesheet">` element with `href="/static/workflow-engine.css"`
- **AND** it SHALL NOT contain a `<link>` to `/static/error.css`

#### Scenario: 404 page is CSP-clean
- **WHEN** the 404.html file is inspected
- **THEN** it SHALL NOT contain any `<style>` element
- **AND** it SHALL NOT contain any `<script>` element
- **AND** it SHALL NOT contain any attribute whose name matches `on[a-z]+`
- **AND** it SHALL NOT contain any `href` or `src` whose value begins with `javascript:`

#### Scenario: Unknown path returns styled 404 to a browser
- **WHEN** a request is made to a path not matching any mounted middleware (e.g., `/nonexistent`) with `Accept: text/html`
- **THEN** the response status SHALL be `404`
- **AND** the response body SHALL be the 404 HTML page

#### Scenario: Sub-app 404 returns styled 404 to a browser
- **WHEN** a request to a mounted sub-app route (e.g., `/dashboard/nonexistent-page`) results in a 404 with `Accept: text/html`
- **THEN** the response body SHALL be the 404 HTML page (not the app's raw 404 text and not a JSON error body)

### Requirement: 5xx error page

The static assets directory SHALL include an `error.html` file. The file SHALL be a complete HTML page that links only to `/static/workflow-engine.css` for styling. It SHALL include the top bar with the brand element (icon and "Workflow Engine" text) but no user information. The page body SHALL display a centered "Something went wrong" heading, a descriptive message, and a styled link back to `/` (labeled "Go home" or equivalent). It SHALL NOT contain any inline `<style>` block, inline `<script>` block, inline event-handler attributes (`on*=`), or `javascript:` URLs — the page is rendered by the app under the app's CSP.

The HTML body SHALL be loaded once at runtime startup into an in-memory cache and served by the app's global `onError` handler (for thrown exceptions) when the request's `Accept` header includes `text/html`. The page SHALL NOT be served by the Traefik `traefik_inline_response` plugin, and the app SHALL NOT depend on any Traefik-level error interception to produce a 5xx HTML body.

The page SHALL rely on the same design tokens (`:root` custom properties for colors, spacing, typography) defined in `workflow-engine.css` that every other app page uses, and SHALL automatically pick up dark-mode colors via the `prefers-color-scheme` media query declarations already present in `workflow-engine.css`.

#### Scenario: error.html served as static asset
- **WHEN** a GET request is made to `/static/error.html`
- **THEN** the response body SHALL contain the error HTML page
- **AND** `Content-Type` SHALL be `text/html`

#### Scenario: Thrown exception returns styled 5xx to a browser
- **GIVEN** a route handler that throws an uncaught exception
- **WHEN** the route is requested with `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL be the error HTML page

#### Scenario: 5xx page links only workflow-engine.css
- **WHEN** the error.html file is inspected
- **THEN** it SHALL contain exactly one `<link rel="stylesheet">` element with `href="/static/workflow-engine.css"`

#### Scenario: 5xx page is CSP-clean
- **WHEN** the error.html file is inspected
- **THEN** it SHALL NOT contain any `<style>` element
- **AND** it SHALL NOT contain any `<script>` element
- **AND** it SHALL NOT contain any attribute whose name matches `on[a-z]+`
- **AND** it SHALL NOT contain any `href` or `src` whose value begins with `javascript:`

#### Scenario: 5xx page supports dark mode via linked stylesheet
- **GIVEN** `workflow-engine.css` defines `:root` dark-mode overrides under `@media (prefers-color-scheme: dark)`
- **WHEN** the user's system is in dark mode and the error page is rendered
- **THEN** the page SHALL render with the dark theme tokens without requiring any inline CSS

## REMOVED Requirements

### Requirement: Error middleware does not apply to static assets or oauth2
**Reason**: The premise is gone. The Traefik `not-found` and `server-error` error middlewares are deleted in this change, so there is no longer any infra-level error interception that could apply to `/static/*`. The `/oauth2/*` prefix was already removed in an earlier change (oauth2-proxy was replaced by app-side GitHub auth). The new behaviour for `/static/*` misses is expressed by the `http-server` spec: they flow through the global `notFound` handler and are content-negotiated via the `Accept` header — browser-typed URLs render the styled 404, asset-loader requests (whose `Accept` never includes `text/html`) receive JSON, which asset loaders discard just as they would discard a plain-text 404.
**Migration**: None required for deployed systems — the requirement described infra behaviour that no longer exists. Consumers of the spec should reference `http-server` §"Unmatched routes return 404" for the new content-negotiation rule.
