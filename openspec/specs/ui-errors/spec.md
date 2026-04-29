# ui-errors Specification

## Purpose
TBD - created by archiving change redesign-ui. Update Purpose after archive.
## Requirements
### Requirement: 404 page outcome

The runtime SHALL respond to requests for unknown paths whose `Accept` header includes `text/html` with a styled 404 HTML page. The page SHALL render the universal topbar (per `ui-foundation`), a heading "Page not found", a descriptive message ("The page you're looking for doesn't exist."), and a styled link to `/dashboard/` labelled "Go to dashboard". The page SHALL be served by the global not-found handler at the application level — no reverse-proxy error-interception SHALL be required to produce it.

The page SHALL inherit the same design tokens as the rest of the application; light/dark theme SHALL follow `prefers-color-scheme` automatically.

#### Scenario: Unknown path returns styled 404 to a browser

- **WHEN** a `GET /nonexistent` request is made with `Accept: text/html`
- **THEN** the response status SHALL be `404`
- **AND** the response body SHALL render the universal topbar
- **AND** the response body SHALL contain "Page not found" as a heading
- **AND** the response body SHALL contain a link to `/dashboard/` labelled "Go to dashboard"

#### Scenario: Sub-app 404 returns styled 404 to a browser

- **WHEN** a request to a mounted sub-app route (e.g., `/dashboard/nonexistent-page`) results in a 404 with `Accept: text/html`
- **THEN** the response body SHALL render the same 404 page
- **AND** the response SHALL NOT be the app's raw 404 text or a JSON error body

#### Scenario: 404 with valid session shows user identity

- **GIVEN** a request carrying a valid authenticated session cookie
- **WHEN** the request hits a non-existent path and a 404 is rendered
- **THEN** the universal topbar SHALL display the user's username and email per the `ui-foundation` topbar contract

#### Scenario: 404 without session shows wordmark only

- **WHEN** an anonymous request hits a non-existent path and a 404 is rendered
- **THEN** the universal topbar SHALL display the brand wordmark only
- **AND** the topbar SHALL NOT contain a user-identity element

#### Scenario: 404 page is CSP-clean

- **WHEN** a 404 response is rendered
- **THEN** the HTML SHALL satisfy the `ui-foundation` CSP-clean rendering requirement (no inline styles, no inline scripts with content, no `on*=` attributes, no `javascript:` URLs)

### Requirement: 5xx error page outcome

The runtime SHALL respond to unhandled exceptions on requests whose `Accept` header includes `text/html` with a styled 5xx HTML page. The page SHALL render the universal topbar (per `ui-foundation`), a heading "Something went wrong", a descriptive message indicating the server encountered an error, and a styled link to `/` labelled "Go home" (or equivalent). The page SHALL be produced by the application's global error handler — no reverse-proxy error-interception plugin SHALL be required.

#### Scenario: Thrown exception returns styled 5xx to a browser

- **WHEN** a request handler throws an unhandled exception and the request carries `Accept: text/html`
- **THEN** the response status SHALL be `500`
- **AND** the response body SHALL render the universal topbar
- **AND** the response body SHALL contain "Something went wrong" as a heading
- **AND** the response body SHALL contain a link to `/` (or equivalent home destination)

#### Scenario: 5xx with valid session shows user identity

- **GIVEN** a request carrying a valid authenticated session cookie
- **WHEN** the handler throws an unhandled exception
- **THEN** the universal topbar SHALL display the user's username and email per the `ui-foundation` topbar contract

#### Scenario: 5xx with broken session shows wordmark only

- **WHEN** the global error handler runs for a request whose session middleware itself crashed (so the user context is unavailable)
- **THEN** the universal topbar SHALL render the brand wordmark only
- **AND** the page SHALL render successfully without depending on session resolution

#### Scenario: 5xx page is CSP-clean

- **WHEN** a 5xx response is rendered
- **THEN** the HTML SHALL satisfy the `ui-foundation` CSP-clean rendering requirement

#### Scenario: 5xx page does not depend on a reverse proxy

- **WHEN** a 5xx response is rendered
- **THEN** the response body SHALL be produced by the application
- **AND** the application SHALL NOT depend on any reverse-proxy error-interception plugin to inject the body

