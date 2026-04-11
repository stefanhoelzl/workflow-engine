## ADDED Requirements

### Requirement: 404 HTML page

The static assets directory SHALL include a `404.html` file. The file SHALL be a complete HTML page that links to `/static/workflow-engine.css` for styling. It SHALL include the top bar with the brand element (icon and "Workflow Engine" text) but no user information. The page body SHALL display a centered "Page not found" heading, a descriptive message ("The page you're looking for doesn't exist."), and a styled link to `/dashboard/` labeled "Go to dashboard".

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

#### Scenario: Unknown path returns styled 404

- **WHEN** a request is made to a path not matching any whitelist (e.g., `/nonexistent`)
- **THEN** the response status SHALL be 404
- **AND** the response body SHALL be the styled 404 HTML page

#### Scenario: App route returns 404

- **WHEN** a request to a whitelisted route (e.g., `/dashboard/nonexistent-page`) results in a 404 from the app
- **THEN** the response body SHALL be the styled 404 HTML page (not the app's raw 404 text)

### Requirement: 5xx error page

The system SHALL serve a self-contained 5xx HTML page when the app returns HTTP 500-599. The page SHALL be served via the `traefik_inline_response` Traefik plugin on an internal loopback route, with no dependency on the app's static assets. The HTML SHALL include all styles inline, matching the project's design language (colors, fonts, card layout consistent with the sign-in page). It SHALL support dark mode via `prefers-color-scheme` media query.

#### Scenario: App returns 500

- **WHEN** the app returns HTTP 500 on any route with the `server-error` middleware
- **THEN** the response body SHALL be the styled 5xx error page
- **AND** the page SHALL display "Something went wrong" with a message to try again

#### Scenario: 5xx page is self-contained

- **WHEN** the 5xx error page is rendered
- **THEN** it SHALL NOT reference any external stylesheets or scripts
- **AND** all styles SHALL be inline within the HTML

#### Scenario: 5xx page includes retry action

- **WHEN** the user views the 5xx error page
- **THEN** a "Try again" button SHALL be visible
- **AND** clicking it SHALL reload the current page

#### Scenario: 5xx page supports dark mode

- **WHEN** the user's system is in dark mode
- **THEN** the 5xx error page SHALL render with dark theme colors matching the project's dark theme variables

### Requirement: Error middleware does not apply to static assets or oauth2

The `not-found` and `server-error` error middlewares SHALL NOT be applied to the `/static/*` or `/oauth2/*` routes. Static assets SHALL return their native status codes. oauth2-proxy SHALL manage its own error responses.

#### Scenario: Missing static file returns raw 404

- **WHEN** a GET request is made to `/static/nonexistent.js`
- **THEN** the response SHALL be the app's native 404 (not the styled 404 page)

#### Scenario: oauth2-proxy error returns its own response

- **WHEN** oauth2-proxy returns an error on `/oauth2/*`
- **THEN** the response SHALL be oauth2-proxy's own error handling (not the styled error pages)
