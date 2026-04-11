## ADDED Requirements

### Requirement: Custom templates directory

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR=/templates` to load custom sign-in and error page templates from a mounted volume.

#### Scenario: Custom templates are loaded
- **WHEN** oauth2-proxy starts with a ConfigMap volume mounted at `/templates`
- **THEN** it SHALL use `sign_in.html` and `error.html` from that directory instead of the built-in defaults

### Requirement: Custom templates ConfigMap

The system SHALL create a Kubernetes ConfigMap containing the custom template files and mount it as a read-only volume in the oauth2-proxy pod at `/templates`.

#### Scenario: ConfigMap contains templates
- **WHEN** the infrastructure is applied
- **THEN** a ConfigMap exists with keys `sign_in.html` and `error.html`
- **THEN** the oauth2-proxy pod mounts this ConfigMap at `/templates`

### Requirement: Custom sign-in page

The system SHALL provide a custom oauth2-proxy sign-in template that uses the app's shared CSS and displays a branded card with a GitHub sign-in button.

#### Scenario: Normal sign-in
- **WHEN** oauth2-proxy renders the sign-in page at `/oauth2/sign_in`
- **THEN** the page links to `/static/workflow-engine.css`
- **THEN** a centered card displays the "W" icon, "Workflow Engine" title, "Sign in to continue" subtitle, and a "Sign in with GitHub" button
- **THEN** the form submits via GET to `{{.ProxyPrefix}}/start` with a hidden `rd` field containing `{{.Redirect}}`

#### Scenario: Sign-in after sign-out
- **WHEN** oauth2-proxy renders the sign-in page at `/oauth2/sign_in?info=Signed+out`
- **THEN** an info banner displays "Signed out" above the sign-in card
- **THEN** the URL is cleaned to `/oauth2/sign_in` via `history.replaceState`

#### Scenario: Sign-in after auth error
- **WHEN** oauth2-proxy renders the sign-in page at `/oauth2/sign_in?error=403+Forbidden`
- **THEN** an error banner displays "403 Forbidden" above the sign-in card
- **THEN** the URL is cleaned to `/oauth2/sign_in` via `history.replaceState`

#### Scenario: No query parameters
- **WHEN** the sign-in page loads without `info` or `error` query parameters
- **THEN** no banner is displayed

### Requirement: Error page redirect shim

The system SHALL provide a custom oauth2-proxy error template that redirects to the sign-in page with the error encoded as a query parameter.

#### Scenario: Error redirects to sign-in
- **WHEN** oauth2-proxy renders the error page with status code 403 and message "Forbidden"
- **THEN** the page redirects to `{{.ProxyPrefix}}/sign_in?error=403%20Forbidden`

#### Scenario: Error message with special characters
- **WHEN** the error message contains HTML special characters
- **THEN** Go's html/template safely escapes them in the `<meta>` tag content attribute
- **THEN** the JS reads the decoded content and URL-encodes it for the redirect

## MODIFIED Requirements

### Requirement: oauth2-proxy logout redirect

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_LOGOUT_REDIRECT_URL=/oauth2/sign_in?info=Signed+out` to redirect users to the sign-in page with a sign-out notification after logging out.

#### Scenario: Logout redirects with info parameter
- **WHEN** a user visits `/oauth2/sign_out`
- **THEN** the session cookie is cleared
- **THEN** the browser is redirected to `/oauth2/sign_in?info=Signed+out`
