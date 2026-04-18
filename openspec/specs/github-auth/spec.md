### Requirement: GitHub token authentication middleware

The runtime SHALL provide a Hono middleware that authenticates requests on `/api/*` routes using a GitHub token. The middleware SHALL extract the token from the `Authorization: Bearer <token>` header, call `GET https://api.github.com/user` with the token, and compare the response `login` field against the configured allow-list of GitHub usernames (`githubAuth.users`, an array of logins).

The middleware SHALL operate in one of three modes selected by configuration (`githubAuth.mode`):

- **`restricted`** — the middleware validates the Bearer token and requires the returned `login` to be a member of `githubAuth.users`.
- **`disabled`** — the middleware responds `401 Unauthorized` to every request regardless of headers. This is the mode when no allow-list is configured; it is fail-closed.
- **`open`** — the middleware is not installed; every request reaches the handler unauthenticated. This mode is reserved for local development and is opted into by the explicit sentinel (see `runtime-config`).

All negative outcomes (missing header, malformed header, GitHub rejection, network error, login not on the allow-list, mode `disabled`) SHALL return `401 Unauthorized` with body `{ "error": "Unauthorized" }`. The status code and body SHALL NOT distinguish between failure causes, to prevent enumeration of the allow-list by holders of valid GitHub tokens.

#### Scenario: Valid token, user on allow-list (restricted mode)

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <valid-token>`, `githubAuth.mode` is `restricted`, and the token's `login` is a member of `githubAuth.users`
- **THEN** the middleware SHALL allow the request to proceed to the handler

#### Scenario: Missing Authorization header (restricted mode)

- **WHEN** a request to `/api/workflows` has no `Authorization` header and `githubAuth.mode` is `restricted`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Invalid token (restricted mode)

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <invalid-token>`, `githubAuth.mode` is `restricted`, and the GitHub API returns an error
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Valid token, login not on allow-list (restricted mode)

- **WHEN** a request includes a valid GitHub token, `githubAuth.mode` is `restricted`, and the returned `login` is not a member of `githubAuth.users`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** the response SHALL be indistinguishable from the responses for missing/invalid tokens

#### Scenario: GitHub API unavailable (restricted mode)

- **WHEN** a request includes a token, `githubAuth.mode` is `restricted`, and the call to `api.github.com` fails due to network error
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Disabled mode rejects every request

- **WHEN** any request reaches `/api/*` and `githubAuth.mode` is `disabled`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Open mode allows every request

- **WHEN** any request reaches `/api/*` and `githubAuth.mode` is `open`
- **THEN** the middleware SHALL NOT be installed
- **AND** the request SHALL proceed to the handler without authentication

### Requirement: Multi-user allow-list membership

The allow-list (`githubAuth.users`) SHALL be an array of GitHub login strings. Membership SHALL be determined by exact case-sensitive string equality between the login returned by `GET https://api.github.com/user` and any element of the array.

#### Scenario: Multiple users on allow-list

- **WHEN** `githubAuth.users` is `["alice", "bob"]` and a request presents a valid token whose `login` is `"bob"`
- **THEN** the middleware SHALL allow the request

#### Scenario: Case-sensitive matching

- **WHEN** `githubAuth.users` is `["Alice"]` and a request presents a valid token whose `login` is `"alice"`
- **THEN** the middleware SHALL respond with `401 Unauthorized`

### Requirement: Startup logging of auth mode

The runtime SHALL emit a log record during initialization that records the effective `githubAuth.mode`. When the mode is `disabled` or `open`, the record SHALL be at level `warn`; when the mode is `restricted`, it MAY be at level `info`.

#### Scenario: Disabled mode warns on startup

- **WHEN** the runtime starts with `githubAuth.mode === "disabled"`
- **THEN** the runtime SHALL emit a `warn`-level log record identifying the disabled mode

#### Scenario: Open mode warns on startup

- **WHEN** the runtime starts with `githubAuth.mode === "open"`
- **THEN** the runtime SHALL emit a `warn`-level log record identifying the open mode

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns the API trust chain:
Bearer-token validation against GitHub and the `GITHUB_USER` allowlist
check.

The implementation SHALL additionally conform to the tenant isolation
invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"`
(I-T2). The `/api/workflows/:tenant` route is the load-bearing
enforcement point for I-T2 on the API trust surface: the upload handler
validates the `<tenant>` path parameter against the identifier regex AND
against `isMember(user, tenant)` before granting access; both must pass,
and both failures return an identical `404 Not Found` to prevent tenant
enumeration by allow-listed Bearer callers.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter the API trust chain (for example by
changing the token-validation call, the caching behavior, or the
allowlist semantics), alter the tenant-membership check on
`/api/workflows/:tenant`, or conflict with the rules listed in
`/SECURITY.md §4` or the invariant statement in `/SECURITY.md §1`
MUST update the corresponding section(s) of `/SECURITY.md` in the same
change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`, or the tenant-isolation
  invariant in `/SECURITY.md §1`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4` or the tenant-isolation invariant in
  `/SECURITY.md §1`
- **THEN** no update to `/SECURITY.md` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked

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
