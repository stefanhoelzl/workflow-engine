## ADDED Requirements

### Requirement: Dashboard middleware factory
The system SHALL provide a `dashboardMiddleware` factory function that accepts an `EventStore` and an SSE consumer and returns a standard `Middleware` object (`{ match, handler }`).

#### Scenario: Middleware creation
- **WHEN** `dashboardMiddleware(eventStore, sseConsumer)` is called
- **THEN** a `Middleware` is returned with `match` set to `"/dashboard/*"`

#### Scenario: Middleware integrates with existing server
- **WHEN** the dashboard middleware is passed to `createServer` alongside the HTTP trigger middleware
- **THEN** both `/webhooks/*` and `/dashboard/*` routes are served from the same Hono server

### Requirement: Dashboard page route
The system SHALL serve a complete HTML page at `GET /dashboard` containing the page shell, CSS, and script tags for Alpine.js and HTMX.

#### Scenario: Page load
- **WHEN** a browser requests `GET /dashboard`
- **THEN** the response is an HTML document with `Content-Type: text/html`
- **THEN** the HTML includes `<script>` tags referencing `/dashboard/alpine.js` and `/dashboard/htmx.js`
- **THEN** the HTML includes HTMX attributes to load the list fragment and connect to the SSE stream

#### Scenario: Dark/light mode
- **WHEN** the page is loaded
- **THEN** the CSS includes a `@media (prefers-color-scheme: dark)` block that switches all color variables

### Requirement: Static JS asset routes
The system SHALL serve Alpine.js at `GET /dashboard/alpine.js` and HTMX at `GET /dashboard/htmx.js` from npm dependencies via Vite `?raw` imports.

#### Scenario: Alpine.js served
- **WHEN** a browser requests `GET /dashboard/alpine.js`
- **THEN** the response has `Content-Type: application/javascript`
- **THEN** the response has `Cache-Control: public, max-age=31536000, immutable`
- **THEN** the response body is the contents of the `alpinejs` npm package

#### Scenario: HTMX served
- **WHEN** a browser requests `GET /dashboard/htmx.js`
- **THEN** the response has `Content-Type: application/javascript`
- **THEN** the response has `Cache-Control: public, max-age=31536000, immutable`
- **THEN** the response body is the contents of the `htmx.org` npm package
