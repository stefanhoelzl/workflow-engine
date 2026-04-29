## MODIFIED Requirements

### Requirement: Universal topbar

Every authenticated UI surface and every error page (404, 5xx) SHALL render the same topbar element. The topbar SHALL display the brand wordmark "Workflow Engine" coloured with the active accent token. User identity (username, email if available, and a sign-out control) SHALL render in the topbar if and only if the request resolved an authenticated session; otherwise the topbar SHALL render the wordmark alone.

The topbar SHALL NOT render different markup for different surface kinds. Surface-specific user-info suppression (forced-anonymous topbar on error pages) SHALL NOT exist; the topbar reads session state like any other page and degrades naturally when none is available.

The login page is explicitly exempt from this requirement. The login page is a self-contained auth card whose heading SHALL carry the brand wordmark "Workflow Engine" in the active accent token, replacing the topbar's branding role. The login page SHALL NOT render the topbar element.

#### Scenario: Authenticated surface shows user identity

- **GIVEN** a user with a valid session cookie
- **WHEN** any authenticated UI surface (e.g. `/dashboard`, `/trigger`) is rendered
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username and (if available) email address
- **AND** the topbar SHALL include a sign-out control

#### Scenario: Login page omits the topbar

- **WHEN** the login page is rendered
- **THEN** the response SHALL NOT contain the topbar element
- **AND** the auth card heading SHALL contain the brand wordmark "Workflow Engine"
- **AND** the brand wordmark SHALL be styled with the active accent token

#### Scenario: Anonymous error page shows wordmark only

- **WHEN** an error page (404 or 5xx) is rendered for a request without a valid session
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL NOT display any user identity

#### Scenario: Authenticated user hits an error page

- **GIVEN** a user with a valid session cookie
- **WHEN** they request a non-existent path and receive a 404
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username (and email if available)
