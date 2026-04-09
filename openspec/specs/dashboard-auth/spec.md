### Requirement: Dashboard routes require GitHub OAuth authentication

Requests to `/dashboard` and `/dashboard/*` SHALL be authenticated via oauth2-proxy's forward_auth mechanism before being proxied to the app.

#### Scenario: Unauthenticated user accesses dashboard

- **WHEN** a user without a valid session cookie requests `https://localhost:8443/dashboard`
- **THEN** Caddy SHALL redirect the user to the GitHub OAuth login flow via oauth2-proxy

#### Scenario: Authenticated user accesses dashboard

- **WHEN** a user with a valid oauth2-proxy session cookie requests `https://localhost:8443/dashboard`
- **THEN** Caddy SHALL proxy the request to `app:8080`

### Requirement: Webhook routes bypass authentication

Requests to `/webhooks/*` SHALL be proxied directly to the app without any authentication check.

#### Scenario: Webhook request without credentials

- **WHEN** a POST request is made to `https://localhost:8443/webhooks/order` without any session cookie
- **THEN** Caddy SHALL proxy the request to `app:8080` with status 200 (assuming the app accepts it)

### Requirement: Authenticated user identity is forwarded to the app

After successful forward_auth, Caddy SHALL copy `X-Forwarded-User` and `X-Forwarded-Email` headers from oauth2-proxy's response and include them in the proxied request to the app.

#### Scenario: User identity headers are present

- **WHEN** an authenticated user requests `/dashboard`
- **AND** forward_auth succeeds
- **THEN** the request proxied to `app:8080` SHALL include the `X-Forwarded-User` header with the GitHub username
- **AND** the `X-Forwarded-Email` header with the user's email

### Requirement: User is redirected to original URL after login

After completing the GitHub OAuth flow, the user SHALL be redirected back to the URL they originally requested.

#### Scenario: Redirect after login

- **WHEN** an unauthenticated user requests `https://localhost:8443/dashboard/list?state=pending`
- **AND** they complete the GitHub OAuth login
- **THEN** they SHALL be redirected back to `https://localhost:8443/dashboard/list?state=pending`

### Requirement: OAuth flow endpoints are accessible through Caddy

The `/oauth2/*` path SHALL be reverse-proxied to oauth2-proxy so the browser can reach the login, callback, and auth endpoints.

#### Scenario: OAuth callback is reachable

- **WHEN** GitHub redirects the browser to `https://localhost:8443/oauth2/callback?code=...&state=...`
- **THEN** Caddy SHALL proxy the request to `oauth2-proxy:4180`

#### Scenario: OAuth start is reachable

- **WHEN** the browser is redirected to `https://localhost:8443/oauth2/start`
- **THEN** Caddy SHALL proxy the request to `oauth2-proxy:4180`
