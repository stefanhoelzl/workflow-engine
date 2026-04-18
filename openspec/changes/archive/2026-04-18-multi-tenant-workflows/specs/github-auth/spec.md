## ADDED Requirements

### Requirement: Tenant membership check on tenant-scoped API routes

The runtime SHALL enforce a tenant membership check on every route whose path matches `/api/workflows/<tenant>` (or any future `/api/*` route that carries a `<tenant>` path parameter). The check SHALL run **after** `githubAuthMiddleware` (Bearer-token + allow-list) and **after** `userMiddleware` (which populates `UserContext.orgs`, `UserContext.name`) have both succeeded.

The check SHALL evaluate the tenant membership predicate defined in `tenant-model`: the caller SHALL be considered authorized iff `UserContext.orgs.includes(tenant) || UserContext.name === tenant`.

If the predicate returns `false`, or if the `<tenant>` path parameter fails the tenant-identifier regex, the handler SHALL respond with `404 Not Found` and body `{ "error": "Not Found" }`. The status code and body SHALL be identical for "tenant regex failed", "tenant exists but user not a member", and "tenant does not exist," so that the API does not disclose which tenants exist to holders of valid GitHub tokens on the allow-list.

The allow-list check (`githubAuth.users`) and the tenant membership check are composed: a caller must be on the allow-list AND a member of the tenant. Removing either would weaken the trust chain.

#### Scenario: Member of real org can upload to that tenant

- **GIVEN** `GITHUB_USER = "alice,bob"`, `UserContext.name = "alice"`, `UserContext.orgs = ["acme"]`
- **WHEN** alice posts to `POST /api/workflows/acme` with a valid Bearer token
- **THEN** the allow-list check SHALL pass
- **AND** the membership check SHALL pass
- **AND** the handler SHALL run

#### Scenario: Member of their pseudo-tenant can upload

- **GIVEN** `GITHUB_USER = "alice"`, `UserContext.name = "alice"`, `UserContext.orgs = []`
- **WHEN** alice posts to `POST /api/workflows/alice` with a valid Bearer token
- **THEN** both checks SHALL pass

#### Scenario: Non-member receives 404

- **GIVEN** `GITHUB_USER = "alice"`, `UserContext.name = "alice"`, `UserContext.orgs = ["acme"]`
- **WHEN** alice posts to `POST /api/workflows/contoso` with a valid Bearer token
- **THEN** the allow-list check SHALL pass
- **AND** the membership check SHALL fail
- **AND** the handler SHALL respond with `404 Not Found` and body `{ "error": "Not Found" }`

#### Scenario: Allow-listed user with disallowed tenant cannot enumerate

- **GIVEN** an attacker on the allow-list tries to discover which tenants exist
- **WHEN** they post to `/api/workflows/<each candidate tenant>` with a valid Bearer token
- **THEN** every non-member response SHALL be `404 Not Found` regardless of whether the tenant exists
- **AND** response timing SHALL NOT meaningfully distinguish "exists" from "doesn't exist"

#### Scenario: Tenant regex failure is indistinguishable from non-membership

- **WHEN** an allow-listed user posts to `POST /api/workflows/bad..name` (invalid regex)
- **THEN** the response SHALL be `404 Not Found` with body `{ "error": "Not Found" }`
- **AND** the response SHALL be indistinguishable from a membership failure

### Requirement: userMiddleware composes with githubAuthMiddleware on tenant routes

For `/api/*` routes that require tenant awareness, the middleware chain SHALL be:

1. `githubAuthMiddleware` (existing allow-list gate; unchanged)
2. `userMiddleware` (populates `UserContext` by parsing oauth2-proxy headers if present, or by fetching `/user`, `/user/orgs`, `/user/teams` from GitHub for Bearer tokens)
3. Tenant membership check (handler-level or middleware-level; sees `UserContext` and the route's `<tenant>` param)

The `userMiddleware`'s GitHub API calls are per-request (no cross-request cache), in line with the existing SECURITY.md §4 A7/A8 residual risks.

#### Scenario: Both middlewares run for a tenant route

- **WHEN** a request reaches `POST /api/workflows/acme`
- **THEN** `githubAuthMiddleware` SHALL run first and enforce the allow-list
- **AND** `userMiddleware` SHALL run second and populate `UserContext`
- **AND** the handler SHALL have `UserContext.orgs` available for the membership check

#### Scenario: GitHub API failure during userMiddleware resolution

- **GIVEN** a Bearer-token caller whose `/user/orgs` fetch fails (rate limit, network error)
- **WHEN** the request reaches `POST /api/workflows/acme`
- **THEN** `UserContext.orgs` SHALL be an empty array
- **AND** the membership check SHALL fail unless the tenant equals `UserContext.name`
- **AND** the handler SHALL respond with `404 Not Found`
