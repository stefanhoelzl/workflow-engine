## ADDED Requirements

### Requirement: API user-context population is Bearer-only

The middleware that populates `UserContext` for `/api/*` routes (`bearerUserMiddleware`) SHALL resolve `UserContext.name`, `UserContext.orgs`, and `UserContext.teams` exclusively from GitHub API calls (`GET /user`, `GET /user/orgs`, `GET /user/teams`) authenticated with the Bearer token extracted from the request's `Authorization` header.

The middleware SHALL NOT read any `X-Auth-Request-*` request header. Forward-auth headers MAY be present on the request (e.g., if an upstream regresses or an attacker forges them) and SHALL be ignored.

This requirement structurally prevents a cross-tenant escalation in which an allow-listed Bearer caller forges `X-Auth-Request-Groups: <victim-tenant>` to inject a tenant into `UserContext.orgs`.

#### Scenario: Forward-auth headers are ignored on API routes

- **GIVEN** a request to `/api/workflows/victim-tenant` with a valid `Authorization: Bearer <token>` whose GitHub `/user/orgs` response is `[]`
- **AND** forged headers `X-Auth-Request-User: attacker`, `X-Auth-Request-Groups: victim-tenant`
- **WHEN** `bearerUserMiddleware` resolves `UserContext`
- **THEN** `UserContext.orgs` SHALL be `[]` (from GitHub), NOT `["victim-tenant"]` (from the header)
- **AND** the subsequent tenant-membership check SHALL fail with `404 Not Found`

#### Scenario: Bearer token remains the sole API credential

- **WHEN** an `/api/*` request arrives with `X-Auth-Request-User: alice` and no `Authorization` header
- **THEN** `bearerUserMiddleware` SHALL NOT set `UserContext`
- **AND** the request SHALL be rejected by `githubAuthMiddleware` with `401 Unauthorized`

#### Scenario: Bearer-resolved user reaches the handler unchanged

- **GIVEN** a request with `Authorization: Bearer <token>` whose GitHub responses are `{ login: "alice", email: "alice@acme.test" }`, orgs `[{ login: "acme" }]`, teams `[{ slug: "eng", organization: { login: "acme" } }]`
- **WHEN** `bearerUserMiddleware` runs
- **THEN** the handler SHALL see `UserContext = { name: "alice", mail: "alice@acme.test", orgs: ["acme"], teams: ["acme:eng"] }`

### Requirement: UI user-context population is forward-auth-only

The middleware that populates `UserContext` for UI routes (`headerUserMiddleware`, mounted on `/dashboard/*` and `/trigger/*`) SHALL resolve `UserContext` exclusively from the forward-auth request headers populated by oauth2-proxy (`X-Auth-Request-User`, `X-Auth-Request-Email`, `X-Auth-Request-Groups`).

The middleware SHALL NOT read the `Authorization` header and SHALL NOT make any outbound call to GitHub. If `X-Auth-Request-User` is absent, `UserContext` SHALL NOT be set and the request SHALL proceed with `user` unset (permitting `open`/dev-mode fallbacks).

This requirement prevents a Bearer token presented to a UI route from ever authenticating a UI session; UI authentication is the oauth2-proxy session cookie only (enforced upstream by Traefik `oauth2-forward-auth`).

#### Scenario: Bearer token does not authenticate UI

- **GIVEN** a request to `/trigger/` with `Authorization: Bearer <token>` and no forward-auth headers
- **WHEN** `headerUserMiddleware` runs
- **THEN** `UserContext` SHALL NOT be set
- **AND** no outbound call to GitHub SHALL be made

#### Scenario: Forward-auth headers populate UI user

- **WHEN** a request to `/dashboard/` arrives with `X-Auth-Request-User: alice`, `X-Auth-Request-Email: alice@acme.test`, `X-Auth-Request-Groups: acme,acme:eng`
- **THEN** `UserContext = { name: "alice", mail: "alice@acme.test", orgs: ["acme"], teams: ["acme:eng"] }`
