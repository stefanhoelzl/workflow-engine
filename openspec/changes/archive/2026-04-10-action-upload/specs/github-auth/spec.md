## ADDED Requirements

### Requirement: GitHub token authentication middleware

The runtime SHALL provide a Hono middleware that authenticates requests on `/api/*` routes using a GitHub token. The middleware SHALL extract the token from the `Authorization: Bearer <token>` header, call `GET https://api.github.com/user` with the token, and compare the response `login` field against the `GITHUB_USER` environment variable.

#### Scenario: Valid token, authorized user

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <valid-token>` and the token belongs to the user configured in `GITHUB_USER`
- **THEN** the middleware SHALL allow the request to proceed to the handler

#### Scenario: Missing Authorization header

- **WHEN** a request to `/api/workflows` has no `Authorization` header
- **THEN** the middleware SHALL respond with `401 Unauthorized`

#### Scenario: Invalid token

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <invalid-token>` and the GitHub API returns an error
- **THEN** the middleware SHALL respond with `401 Unauthorized`

#### Scenario: Valid token, wrong user

- **WHEN** a request includes a valid GitHub token but the `login` field does not match `GITHUB_USER`
- **THEN** the middleware SHALL respond with `403 Forbidden`

#### Scenario: GitHub API unavailable

- **WHEN** a request includes a token but the call to `api.github.com` fails due to network error
- **THEN** the middleware SHALL respond with `401 Unauthorized`
