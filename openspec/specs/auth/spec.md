# auth Specification

## Purpose

Unified in-app authentication for the workflow-engine runtime. Resolves the authenticated caller into a `UserContext` from either a sealed session cookie (UI routes) or a GitHub Bearer token (API routes), enforces the `AUTH_ALLOW` allow-list, and owns the GitHub OAuth login flow (`/login`, `/auth/github/signin`, `/auth/github/callback`, `/auth/logout`). Replaces the former oauth2-proxy sidecar and the parallel `github-auth`/`dashboard-auth` capabilities.

## Requirements
### Requirement: UserContext shape

The runtime SHALL resolve authenticated callers into a `UserContext` object with the following shape, independent of transport (session cookie vs. Bearer header):

```
UserContext = {
  name:  string   // GitHub login, from GET /user
  mail:  string   // GitHub email, from GET /user (may be "")
  orgs:  string[] // GitHub org logins, from GET /user/orgs
}
```

`UserContext.teams` SHALL NOT exist. No capability consumes teams; `GET /user/teams` SHALL NOT be called on any auth code path. The field names `name`/`mail` are retained from the pre-existing runtime convention (where `UserContext.name` has always held the GitHub login string and `UserContext.mail` the verified email).

#### Scenario: UserContext carries name, mail, orgs only

- **GIVEN** a user whose GitHub profile is `{ login: "alice", email: "alice@acme.test" }` and whose `/user/orgs` returns `[{ login: "acme" }]`
- **WHEN** the runtime resolves their `UserContext`
- **THEN** it SHALL be `{ name: "alice", mail: "alice@acme.test", orgs: ["acme"] }`
- **AND** the object SHALL NOT have a `teams` property

### Requirement: AUTH_ALLOW grammar

The runtime SHALL accept an `AUTH_ALLOW` environment variable with the grammar:

```
AUTH_ALLOW = Entry ( ";" Entry )*
Entry      = Provider ":" Kind ":" Id
Provider   = "github"
Kind       = "user" | "org"
Id         = [A-Za-z0-9][-A-Za-z0-9]*
```

Whitespace around entries SHALL be trimmed. Empty entries (`";;"`) SHALL be ignored. Tokens whose `Provider` is not `github`, or whose `Kind` is not `user` or `org`, or whose `Id` does not match the identifier regex, SHALL cause `createConfig` to throw a validation error at startup; the runtime SHALL fail to start.

#### Scenario: Mixed user and org entries

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice;github:org:acme;github:user:bob"`
- **THEN** the parsed allowlist SHALL contain `users = { "alice", "bob" }` and `orgs = { "acme" }`

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "google:user:alice"`
- **THEN** `createConfig` SHALL throw a validation error identifying the unknown provider

#### Scenario: Unknown kind fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:team:acme/eng"`
- **THEN** `createConfig` SHALL throw a validation error identifying the unknown kind

#### Scenario: Invalid identifier fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:has spaces"`
- **THEN** `createConfig` SHALL throw a validation error identifying the invalid identifier

#### Scenario: Whitespace around entries is trimmed

- **WHEN** `createConfig` is called with `AUTH_ALLOW = " github:user:alice ;  github:org:acme "`
- **THEN** the parsed allowlist SHALL contain `users = { "alice" }` and `orgs = { "acme" }`

### Requirement: AUTH_ALLOW mode resolution

The config schema SHALL expose `auth` as a discriminated union:

```
auth:
  | { mode: "disabled" }
  | { mode: "open" }
  | { mode: "restricted"; users: Set<string>; orgs: Set<string> }
```

Resolution rules:
- `AUTH_ALLOW` is unset (undefined) or an empty string → `auth = { mode: "disabled" }`.
- `AUTH_ALLOW` equals the sentinel string `__DISABLE_AUTH__` → `auth = { mode: "open" }`.
- Any other parseable value → `auth = { mode: "restricted", users, orgs }`.

The sentinel `__DISABLE_AUTH__` SHALL be valid only when it is the entire value of `AUTH_ALLOW`. If it appears as a semicolon-separated segment alongside other entries, config parsing SHALL fail with a validation error.

#### Scenario: AUTH_ALLOW unset produces disabled mode

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the config SHALL contain `auth: { mode: "disabled" }`

#### Scenario: Sentinel produces open mode

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "__DISABLE_AUTH__"`
- **THEN** the config SHALL contain `auth: { mode: "open" }`

#### Scenario: Parseable value produces restricted mode

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice;github:org:acme"`
- **THEN** the config SHALL contain `auth: { mode: "restricted", users: Set(["alice"]), orgs: Set(["acme"]) }`

#### Scenario: Sentinel mixed with entries fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice;__DISABLE_AUTH__"`
- **THEN** `createConfig` SHALL throw a validation error indicating the sentinel must be the only value

### Requirement: Allow predicate

The runtime SHALL expose an `allow(user)` predicate that returns true if and only if:

```
auth.mode === "open"
  OR (auth.mode === "restricted" AND (auth.users.has(user.name) OR user.orgs.some(o => auth.orgs.has(o))))
```

When `auth.mode === "disabled"`, `allow(user)` SHALL return false for every input, including when no `user` is available.

String comparison for both `login` and `orgs` matching SHALL be case-sensitive exact equality, consistent with GitHub's login/org identifiers.

The same predicate SHALL be evaluated on every `/api/*` Bearer request AND at login time AND on every successful soft-TTL session refresh.

#### Scenario: Login match grants access

- **GIVEN** `auth = { mode: "restricted", users: Set(["alice"]), orgs: Set() }`
- **WHEN** `allow({ login: "alice", email: "", orgs: [] })` is called
- **THEN** it SHALL return true

#### Scenario: Org match grants access

- **GIVEN** `auth = { mode: "restricted", users: Set(), orgs: Set(["acme"]) }`
- **WHEN** `allow({ login: "bob", email: "", orgs: ["acme", "other"] })` is called
- **THEN** it SHALL return true

#### Scenario: No match denies access

- **GIVEN** `auth = { mode: "restricted", users: Set(["alice"]), orgs: Set(["acme"]) }`
- **WHEN** `allow({ login: "eve", email: "", orgs: ["evil"] })` is called
- **THEN** it SHALL return false

#### Scenario: Open mode grants access to anyone

- **GIVEN** `auth = { mode: "open" }`
- **WHEN** `allow({ login: "anyone", email: "", orgs: [] })` is called
- **THEN** it SHALL return true

#### Scenario: Disabled mode denies everyone

- **GIVEN** `auth = { mode: "disabled" }`
- **WHEN** `allow({ login: "alice", email: "", orgs: ["acme"] })` is called
- **THEN** it SHALL return false

### Requirement: isMember tenant predicate

The runtime SHALL expose an `isMember(user, tenant)` predicate that returns true if and only if the `tenant` string passes `validateTenant(tenant)` AND `tenant` is either `user.name` or an element of `user.orgs`. The tenant identifier regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`.

This predicate scopes *which tenants an already-allowed user can act as*. It is orthogonal to `allow(user)` — both MUST pass for tenant-scoped write operations. Teams are NOT consulted.

#### Scenario: Personal namespace grants membership

- **GIVEN** `user = { login: "alice", email: "", orgs: [] }`
- **WHEN** `isMember(user, "alice")` is called
- **THEN** it SHALL return true

#### Scenario: Org namespace grants membership

- **GIVEN** `user = { login: "alice", email: "", orgs: ["acme"] }`
- **WHEN** `isMember(user, "acme")` is called
- **THEN** it SHALL return true

#### Scenario: Non-member denied

- **GIVEN** `user = { login: "alice", email: "", orgs: ["acme"] }`
- **WHEN** `isMember(user, "victim")` is called
- **THEN** it SHALL return false

#### Scenario: Invalid tenant identifier denied regardless of membership

- **GIVEN** `user = { login: "../etc/passwd", email: "", orgs: [] }`
- **WHEN** `isMember(user, "../etc/passwd")` is called
- **THEN** it SHALL return false

### Requirement: Tenant-authorization middleware

The runtime SHALL expose a `requireTenantMember()` Hono middleware factory in the `auth` capability. The middleware SHALL enforce the tenant-isolation invariant (SECURITY.md §4) for any route that accepts a `:tenant` path parameter, returning `404 Not Found` fail-closed on any failure mode (invalid identifier, non-member, or missing user outside open mode).

Evaluation order inside the middleware:

1. Read `c.req.param("tenant")`. If the value does not satisfy `validateTenant` (regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), respond with `c.notFound()`. This check SHALL run before the open-mode bypass, because the regex is a path-safety guarantee, not an authorization check.
2. If `c.get("authOpen") === true`, call `next()` (open-mode dev bypass, per the existing "Bearer middleware on /api/\*" requirement).
3. If `user = c.get("user")` is set and `isMember(user, tenant)` returns true, call `next()`.
4. Otherwise, respond with `c.notFound()`.

The middleware SHALL NOT hardcode a response body. Each Hono sub-app that mounts the middleware SHALL register an `app.notFound(c => c.json({error:"Not Found"}, 404))` handler so that 404 responses carry a uniform JSON body across `/api/*` and `/trigger/*`.

The middleware SHALL read only the path parameter named `tenant`. It SHALL NOT accept configuration for a different parameter name or a custom accessor — all tenant-scoped routes SHALL use the path parameter name `tenant`.

The following routes SHALL enforce tenant membership by mounting `requireTenantMember()` and SHALL NOT perform the `validateTenant` + `isMember` check inline in their handlers:

- `POST /api/workflows/:tenant` (mounted in `api/index.ts`).
- `POST /trigger/:tenant/:workflow/:trigger` (mounted in `ui/trigger/middleware.ts` on the `/trigger`-basePath sub-app at `/:tenant/*`).

Any future route that accepts a `:tenant` path parameter SHALL mount `requireTenantMember()` on the corresponding subpath. Inline tenant-authorization checks in individual route handlers SHALL be treated as a defect.

#### Scenario: Invalid tenant identifier returns 404

- **GIVEN** `requireTenantMember()` is mounted on `/workflows/:tenant` in the `/api` sub-app
- **WHEN** a request arrives at `POST /api/workflows/../etc/passwd`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked
- **AND** the response SHALL be indistinguishable from the response for a non-existent tenant

#### Scenario: Non-member returns 404

- **GIVEN** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: ["acme"] }`
- **WHEN** a request to `POST /api/workflows/victim` presents credentials that resolve to `alice`, who is not a member of `victim`
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the response SHALL be indistinguishable from the response for a tenant that does not exist

#### Scenario: Member passes to handler

- **GIVEN** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: ["acme"] }`
- **WHEN** a request to `POST /api/workflows/acme` presents credentials that resolve to `alice`
- **THEN** `requireTenantMember()` SHALL call `next()` without modifying the response
- **AND** the upload handler SHALL receive the request

#### Scenario: Open-mode bypass via authOpen flag

- **GIVEN** `auth.mode === "open"` and `c.get("authOpen") === true`
- **WHEN** a request to `POST /api/workflows/anything-valid` arrives without a `user` on the context
- **THEN** `requireTenantMember()` SHALL call `next()` without evaluating `isMember`
- **AND** the handler SHALL receive the request

#### Scenario: Open mode does not relax identifier validation

- **GIVEN** `auth.mode === "open"` and `c.get("authOpen") === true`
- **WHEN** a request to `POST /api/workflows/../traversal` arrives
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked

#### Scenario: Missing user outside open mode returns 404

- **GIVEN** `auth.mode === "restricted"` and `c.get("authOpen")` is unset
- **WHEN** a request to `POST /api/workflows/acme` arrives with no `user` on the context (e.g., authn middleware failed to populate it)
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the middleware SHALL NOT fall through to the handler

#### Scenario: Trigger POST uses same middleware

- **GIVEN** `requireTenantMember()` is mounted on `/:tenant/*` of the `/trigger`-basePath sub-app
- **AND** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: [] }`
- **WHEN** a request to `POST /trigger/victim/wf/tr` arrives from `alice`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the POST handler SHALL NOT be invoked
- **AND** no inline `validateTenant` or `tenantSet(user).has(tenant)` check SHALL remain in the POST handler

### Requirement: GitHub OAuth scope

The runtime SHALL request GitHub OAuth scope `user:email read:org` when constructing the authorize URL. This scope set SHALL be sufficient to populate `UserContext.login`, `UserContext.email`, and `UserContext.orgs` including private-org memberships.

The runtime SHALL NOT request additional scopes (in particular, SHALL NOT request `repo`, `admin:*`, or `user` unqualified).

#### Scenario: Authorize URL carries required scopes

- **WHEN** the runtime constructs the authorize URL
- **THEN** the URL query SHALL include `scope=user%3Aemail%20read%3Aorg` (URL-encoded)

#### Scenario: Private org membership is visible to orgs fetch

- **GIVEN** a user whose only membership is in a private org `priv-org`
- **WHEN** the callback handler calls `GET /user/orgs` with the access token
- **THEN** the response SHALL include `priv-org` (because `read:org` is granted)

### Requirement: Bearer middleware on /api/*

The runtime SHALL mount a `bearerMw` middleware on every `/api/*` route. The middleware SHALL:

1. Extract the Bearer token from the `Authorization: Bearer <token>` header.
2. Fetch `GET https://api.github.com/user` and `GET https://api.github.com/user/orgs` in parallel, using the token.
3. Build `UserContext` from the responses.
4. Evaluate `allow(UserContext)`.
5. On success, set `UserContext` on the request context and call `next()`.
6. On any failure — missing/malformed header, GitHub error (any 4xx/5xx), `allow` returns false, or token expired — respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`, identical in every failure case.

The middleware SHALL NOT read any cookie. The middleware SHALL NOT read any `X-Auth-Request-*` header.

In `auth.mode === "disabled"`, `bearerMw` SHALL respond `401 Unauthorized` to every request without calling GitHub. In `auth.mode === "open"`, `bearerMw` SHALL NOT be installed; every request SHALL reach the handler unauthenticated, and a request-scoped `authOpen` flag SHALL be set so tenant-scoped handlers bypass membership checks consistent with today's open-mode behaviour.

#### Scenario: Valid token, user on allowlist (restricted)

- **GIVEN** `auth.mode === "restricted"`, `auth.users = Set(["alice"])`
- **WHEN** a request to `/api/workflows` presents `Authorization: Bearer <token>` whose `/user` resolves to `{ login: "alice" }`
- **THEN** `bearerMw` SHALL set `UserContext` and pass to the handler

#### Scenario: Valid token, user's org on allowlist (restricted)

- **GIVEN** `auth.mode === "restricted"`, `auth.orgs = Set(["acme"])`
- **WHEN** a request to `/api/workflows` presents `Authorization: Bearer <token>` whose `/user/orgs` returns `[{ login: "acme" }]`
- **THEN** `bearerMw` SHALL set `UserContext` and pass to the handler

#### Scenario: Missing Authorization header returns 401

- **GIVEN** `auth.mode === "restricted"`
- **WHEN** a request to `/api/workflows` has no `Authorization` header
- **THEN** `bearerMw` SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: GitHub API error returns 401 with identical body

- **GIVEN** `auth.mode === "restricted"`
- **WHEN** a request to `/api/workflows` presents a Bearer token and `GET /user` returns 401
- **THEN** `bearerMw` SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** the response SHALL be indistinguishable from the missing-header response

#### Scenario: Allowlist miss returns 401 with identical body

- **GIVEN** `auth.mode === "restricted"`, `auth.users = Set(["alice"])`, `auth.orgs = Set()`
- **WHEN** a request to `/api/workflows` presents a Bearer token whose `/user` resolves to `{ login: "eve" }`
- **THEN** `bearerMw` SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** the response SHALL be indistinguishable from other 401 cases

#### Scenario: Forward-auth headers are ignored

- **GIVEN** a request to `/api/workflows/victim-tenant` with `Authorization: Bearer <token>` whose `/user/orgs` returns `[]` AND forged headers `X-Auth-Request-User: attacker`, `X-Auth-Request-Groups: victim-tenant`
- **WHEN** `bearerMw` resolves `UserContext`
- **THEN** `UserContext.orgs` SHALL be `[]` (from GitHub), NOT `["victim-tenant"]` (from the header)
- **AND** the subsequent `isMember` check SHALL fail

#### Scenario: Disabled mode rejects every request

- **GIVEN** `auth.mode === "disabled"`
- **WHEN** any request reaches `/api/*`
- **THEN** `bearerMw` SHALL respond with `401 Unauthorized`
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Open mode allows every request

- **GIVEN** `auth.mode === "open"`
- **WHEN** any request reaches `/api/*`
- **THEN** `bearerMw` SHALL NOT be installed
- **AND** the handler SHALL receive `authOpen = true` on the request context

### Requirement: Session cookie sealing

The runtime SHALL use `iron-webcrypto` (via the `seal` and `unseal` functions) to encrypt and authenticate all three auth cookies (`session`, `auth_state`, `auth_flash`). All three SHALL share a single 32-byte password generated via `crypto.getRandomValues` at process startup and held in module-level state for the life of the process.

The password SHALL NOT be written to disk, to any Kubernetes Secret, to any log record, or to any telemetry output. The password SHALL NOT be recoverable after process termination.

Each cookie type SHALL pass a type-specific `ttl` parameter to `seal`; `unseal` SHALL validate TTL and reject expired blobs. A cookie whose `unseal` fails (wrong password, tampered ciphertext, expired TTL) SHALL be treated as absent.

#### Scenario: Password regenerated at process start

- **WHEN** the runtime starts
- **THEN** it SHALL generate a 32-byte random password via `crypto.getRandomValues`
- **AND** the password SHALL differ from any previous process's password with overwhelming probability

#### Scenario: Tampered session cookie is rejected

- **GIVEN** a valid sealed session cookie
- **WHEN** any byte of the cookie value is flipped and the cookie is presented to `sessionMw`
- **THEN** `unseal` SHALL throw
- **AND** `sessionMw` SHALL treat the request as unauthenticated and 302 to `/login`

#### Scenario: Expired session cookie is rejected

- **GIVEN** a sealed session cookie whose `ttl` has elapsed
- **WHEN** the cookie is presented to `sessionMw`
- **THEN** `unseal` SHALL throw due to TTL expiry
- **AND** `sessionMw` SHALL 302 to `/login`

### Requirement: Session cookie contract

The `session` cookie SHALL have:
- **Name**: `session`
- **Path**: `/`
- **HttpOnly**: true
- **Secure**: true (except when `LOCAL_DEPLOYMENT=1` is set, in which case Secure MAY be false)
- **SameSite**: `Lax` (required for the OAuth redirect back from `github.com` to carry the cookie)
- **Max-Age**: 604800 (7 days hard TTL)
- **Payload (sealed)**:
  ```
  {
    login:       string
    email:       string
    orgs:        string[]
    accessToken: string      // GitHub OAuth access token
    resolvedAt:  number      // ms since epoch of last GitHub resolve
    exp:         number      // ms since epoch of hard expiry
  }
  ```

The sealed cookie SHALL be no larger than 4096 bytes; if the payload would exceed that after sealing, the runtime SHALL log an error and abort the session.

#### Scenario: Session cookie carries the expected payload fields

- **GIVEN** a user who completes the OAuth flow with `{ login: "alice", email: "a@x", orgs: ["acme"] }`
- **WHEN** the callback handler seals the session cookie
- **THEN** the payload SHALL contain `login`, `email`, `orgs`, `accessToken`, `resolvedAt`, and `exp`
- **AND** the payload SHALL NOT contain a `teams` field

#### Scenario: Session cookie attributes

- **WHEN** the callback handler sets the session cookie in production (`LOCAL_DEPLOYMENT` not set)
- **THEN** the `Set-Cookie` header SHALL include `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=604800`

### Requirement: State cookie contract

The `auth_state` cookie carries CSRF protection and post-login redirect target for the OAuth handshake. It SHALL have:
- **Name**: `auth_state`
- **Path**: `/auth`
- **HttpOnly**: true
- **Secure**: true (except `LOCAL_DEPLOYMENT=1`)
- **SameSite**: `Lax`
- **Max-Age**: 300 (5 minutes)
- **Payload (sealed)**:
  ```
  {
    state:    string   // opaque CSRF token, 32 random bytes base64url
    returnTo: string   // same-origin path, starts with "/", no "//", no ":", no scheme
  }
  ```

The callback handler SHALL validate that `state` in the unsealed cookie equals the `state` query parameter from GitHub; on mismatch or missing cookie, the handler SHALL respond `400 Bad Request`. The callback handler SHALL clear the `auth_state` cookie before processing the rest of the request (single-use).

The callback handler SHALL validate `returnTo` is a same-origin relative path; any value that does not start with `/` or contains `//` or `:` SHALL be rejected and the handler SHALL redirect to `/` instead of the attacker-chosen URL.

#### Scenario: State mismatch returns 400

- **GIVEN** an `auth_state` cookie sealing `{ state: "A", returnTo: "/" }`
- **WHEN** `/auth/github/callback?code=...&state=B` is requested
- **THEN** the handler SHALL respond `400 Bad Request`
- **AND** the handler SHALL NOT exchange the code for a token

#### Scenario: Missing state cookie returns 400

- **WHEN** `/auth/github/callback?code=...&state=X` is requested without an `auth_state` cookie
- **THEN** the handler SHALL respond `400 Bad Request`

#### Scenario: Malformed returnTo rejected

- **GIVEN** an `auth_state` cookie sealing `{ state: "A", returnTo: "//evil.example/foo" }` that passes state match
- **WHEN** the callback completes successfully
- **THEN** the handler SHALL redirect to `/` instead of the malformed `returnTo`

#### Scenario: State cookie is single-use

- **GIVEN** a successful callback
- **WHEN** the handler redirects to `returnTo`
- **THEN** the response SHALL include `Set-Cookie: auth_state=; Max-Age=0` to delete the state cookie

### Requirement: Flash cookie contract

The `auth_flash` cookie is set by the callback handler, by the session refresh path when `allow()` rejects a resolved user, and by `POST /auth/logout`. It SHALL have:
- **Name**: `auth_flash`
- **Path**: `/` (the cookie must reach `/login`, which is not under `/auth`)
- **HttpOnly**: true
- **Secure**: true (except `LOCAL_DEPLOYMENT=1`)
- **SameSite**: `Lax`
- **Max-Age**: 60 (60 seconds)
- **Payload (sealed, discriminated union)**:
  ```
  { kind: "denied"; login: string }   // set on allowlist rejection
  | { kind: "logged-out" }            // set on successful logout
  ```

`GET /login` SHALL read and clear the flash cookie on every request. When the flash cookie is present and valid, the handler SHALL render the login page with the banner variant indicated by the `kind` field. When absent, the handler SHALL still render the same page (without a banner) — the login page is stable and NEVER auto-redirects to the IdP.

#### Scenario: Denied flash drives the deny banner

- **GIVEN** a user whose allowlist check fails at callback time for login `foo`
- **WHEN** the callback handler sets the flash cookie with `{ kind: "denied", login: "foo" }` and 302s to `/login`
- **THEN** the login route SHALL render the page with a "Not authorized" banner naming `foo`

#### Scenario: Logged-out flash drives the signed-out banner

- **GIVEN** a successful `POST /auth/logout`
- **WHEN** the logout handler sets the flash cookie with `{ kind: "logged-out" }` and 302s to `/login`
- **THEN** the login route SHALL render the page with a "Signed out" banner and a "Sign in again" action

#### Scenario: Flash cookie is single-use

- **GIVEN** a render of the login page from a flash cookie
- **WHEN** the response is sent
- **THEN** it SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

### Requirement: Login page route

`GET /login` SHALL be a **provider-agnostic** sign-in page. The URL is deliberately not scoped under `/auth/github/` because future providers can be offered on the same page without moving the route.

The route SHALL always render an HTML page — it SHALL NEVER initiate an OAuth flow or redirect to an IdP on its own. The OAuth flow SHALL start only when the user clicks a provider-specific button on the page.

Behaviour:
1. Read the `returnTo` query parameter; sanitise to a same-origin relative path (default `/`).
2. Read the `auth_flash` cookie if present; unseal and clear it.
3. Respond `200 OK` with an HTML page containing:
   - A "Sign in with GitHub" button that links to `GET /auth/github/signin?returnTo=<sanitised>`.
   - If the flash payload was `{ kind: "denied", login }`: a banner identifying the rejected login and a `Sign out of GitHub` external link.
   - If the flash payload was `{ kind: "logged-out" }`: a "Signed out" banner and a `Sign out of GitHub` external link (so the user can fully end the IdP session).
   - No banner when no flash cookie is present.

The HTML SHALL contain no inline script, no inline style, no `on*=` event-handler attributes, and no `style=` attributes, per the app's CSP. The page SHALL NOT include the app chrome (topbar, sidebar, tenant selector) — it is a standalone layout for unauthenticated users.

#### Scenario: Renders sign-in page without redirecting

- **WHEN** `GET /login?returnTo=/dashboard` is requested without a flash cookie
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain a `Sign in with GitHub` button linking to `/auth/github/signin?returnTo=%2Fdashboard`
- **AND** the response SHALL NOT include a `Location` header
- **AND** the response SHALL NOT set an `auth_state` cookie

#### Scenario: Flash cookie renders deny banner

- **GIVEN** an `auth_flash` cookie sealing `{ kind: "denied", login: "foo" }`
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain the string `foo`
- **AND** the response SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

#### Scenario: Flash cookie renders signed-out banner

- **GIVEN** an `auth_flash` cookie sealing `{ kind: "logged-out" }`
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain a "Signed out" confirmation
- **AND** the body SHALL contain a link to `https://github.com/logout`

#### Scenario: Refreshing the page stays on the page (no auto-redirect)

- **GIVEN** no flash cookie is present
- **WHEN** `GET /login` is requested (e.g., a browser refresh after the banner was previously consumed)
- **THEN** the handler SHALL respond `200 OK`
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Malformed returnTo defaults to /

- **WHEN** `GET /login?returnTo=//evil.example` is requested
- **THEN** the sign-in button in the rendered page SHALL link to `/auth/github/signin?returnTo=%2F`

### Requirement: GitHub signin route

`GET /auth/github/signin` starts the GitHub OAuth handshake. It is reached only by explicit user action (clicking the "Sign in with GitHub" button on `/login`) or by another provider-specific signin route (for future providers). `sessionMw` MUST NOT redirect to this route directly; it MUST redirect to `/login` and let the user initiate the flow.

Behaviour:
1. Read the `returnTo` query parameter; sanitise to a same-origin relative path (default `/`).
2. Generate `state` as 32 random bytes, base64url-encoded.
3. Seal `{ state, returnTo }` into the `auth_state` cookie (5 min TTL).
4. Construct the authorize URL:
   ```
   https://github.com/login/oauth/authorize?
     client_id=<GITHUB_OAUTH_CLIENT_ID>&
     redirect_uri=<BASE_URL>/auth/github/callback&
     scope=user:email%20read:org&
     state=<state>
   ```
5. Respond `302 Found` with `Location` set to the authorize URL and `Set-Cookie: auth_state=<sealed>`.

#### Scenario: Redirects to GitHub with a state cookie

- **WHEN** `GET /auth/github/signin?returnTo=/dashboard` is requested
- **THEN** the handler SHALL respond `302 Found`
- **AND** the `Location` header SHALL start with `https://github.com/login/oauth/authorize?`
- **AND** the response SHALL include `Set-Cookie: auth_state=...`

#### Scenario: Unsafe returnTo is sanitised before sealing

- **WHEN** `GET /auth/github/signin?returnTo=//evil.example` is requested
- **THEN** the sealed `auth_state` cookie SHALL carry `returnTo = "/"`
- **AND** the `Location` header SHALL NOT contain `evil.example`

### Requirement: Callback route

`GET /auth/github/callback` SHALL:
1. Read `code` and `state` query parameters.
2. Unseal the `auth_state` cookie; respond `400 Bad Request` if missing, unsealing fails, or `state` does not match.
3. Clear the `auth_state` cookie.
4. POST to `https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `code`, `redirect_uri`. On any non-OK response, respond `502 Bad Gateway`.
5. Fetch `GET /user` and `GET /user/orgs` from `api.github.com` in parallel with the access token. On any non-OK response, respond `502 Bad Gateway`.
6. Build `UserContext = { login, email, orgs }`.
7. Evaluate `allow(UserContext)`. If false, set `auth_flash` to the rejected login, clear the `session` cookie, and 302 to `/login`.
8. On success, seal the session payload and set the `session` cookie, then 302 to the unsealed `returnTo`.

The handler SHALL NOT read any cookie other than `auth_state`. The handler SHALL NOT be registered under any path prefix that carries `sessionMw`.

#### Scenario: Happy path sets session cookie and redirects

- **GIVEN** a valid `auth_state` cookie, a successful code-exchange, and an allowed user
- **WHEN** `/auth/github/callback?code=c&state=s` is requested with matching state
- **THEN** the handler SHALL respond `302 Found`
- **AND** `Location` SHALL equal the `returnTo` from the state cookie
- **AND** the response SHALL include `Set-Cookie: session=<sealed>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`

#### Scenario: Allowlist rejection sets flash and redirects to login

- **GIVEN** `auth.mode === "restricted"`, `allow(user)` returns false for the resolved `UserContext`
- **WHEN** `/auth/github/callback?code=c&state=s` completes the code exchange and profile fetch
- **THEN** the handler SHALL respond `302 Found` with `Location: /login`
- **AND** the response SHALL include `Set-Cookie: auth_flash=<sealed>; Path=/auth; Max-Age=60`
- **AND** the response SHALL include `Set-Cookie: session=; Max-Age=0`

#### Scenario: Token exchange failure returns 502

- **GIVEN** GitHub returns 500 for the token exchange
- **WHEN** `/auth/github/callback?code=c&state=s` runs
- **THEN** the handler SHALL respond `502 Bad Gateway`
- **AND** no session cookie SHALL be set

### Requirement: Session middleware on /dashboard/* and /trigger/*

The runtime SHALL mount a `sessionMw` middleware on every route under `/dashboard/*` and `/trigger/*`. `sessionMw` SHALL:

1. In `auth.mode === "disabled"`, respond `401 Unauthorized` immediately.
2. In `auth.mode === "open"`, leave `UserContext` unset and call `next()`. Downstream handlers (dashboard / trigger UI) already handle the unset-user case with a registry-tenants fallback intended for dev.
3. In `auth.mode === "restricted"`:
   a. Read the `session` cookie. If absent or unsealing fails, respond `302 Found` with `Location: /login?returnTo=<encoded-current-path>`.
   b. If `now >= payload.exp` (hard TTL exceeded), clear the session cookie and 302 to `/login?returnTo=<encoded-current-path>`.
   c. If `now < payload.resolvedAt + 10 minutes`, the session is fresh: evaluate `allow(payload.UserContext)` against the cached orgs. On success, set `UserContext` on the request context and call `next()`. On failure, set `auth_flash`, clear the session, and 302 to `/login`.
   d. Otherwise (stale), refresh: fetch `GET /user` and `GET /user/orgs` using `payload.accessToken`. On any non-OK response (including 401, 403, 5xx, timeout, DNS error), clear the session and 302 to `/login` (no grace period). On success, rebuild `UserContext`, evaluate `allow(UserContext)`; on failure, set `auth_flash`, clear the session, and 302 to `/login`. On success, re-seal the session cookie with a new `resolvedAt = now`, set `UserContext`, and call `next()`.

The middleware SHALL NOT read the `Authorization` header. The middleware SHALL NOT read any `X-Auth-Request-*` header.

#### Scenario: No cookie redirects to login

- **GIVEN** `auth.mode === "restricted"` and no `session` cookie
- **WHEN** `GET /dashboard/foo` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=%2Fdashboard%2Ffoo`

#### Scenario: Fresh session passes through

- **GIVEN** a valid session cookie with `resolvedAt = now - 2min`
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL call `next()` with `UserContext` set
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Stale session refreshes successfully

- **GIVEN** a valid session cookie with `resolvedAt = now - 15min`, GitHub responses OK, `allow(user)` returns true
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL re-fetch `/user` and `/user/orgs`
- **AND** set `Set-Cookie: session=<new-sealed>` with `resolvedAt = now` in the payload
- **AND** call `next()`

#### Scenario: Stale session with GitHub 5xx fails closed

- **GIVEN** a valid session cookie with `resolvedAt = now - 15min`, GitHub returns 500
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** clear the session cookie

#### Scenario: Stale session with revoked token fails closed

- **GIVEN** a valid session cookie with `resolvedAt = now - 15min`, `/user` returns 401
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login` and clear the session cookie

#### Scenario: Stale session with allowlist now rejecting

- **GIVEN** a valid session cookie, GitHub responses OK, but `allow(user)` now returns false (user removed from `AUTH_ALLOW`, or user left the allowed org)
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login`
- **AND** set `Set-Cookie: auth_flash=<sealed>; Path=/auth; Max-Age=60`
- **AND** clear the session cookie

#### Scenario: Expired session redirects to login

- **GIVEN** a session cookie whose `exp` is in the past
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login` and clear the session cookie
- **AND** SHALL NOT attempt a refresh

#### Scenario: Disabled mode returns 401

- **GIVEN** `auth.mode === "disabled"`
- **WHEN** any request reaches `/dashboard/*` or `/trigger/*`
- **THEN** `sessionMw` SHALL respond `401 Unauthorized`

#### Scenario: Open mode leaves user unset

- **GIVEN** `auth.mode === "open"`
- **WHEN** any request reaches `/dashboard/*` or `/trigger/*`
- **THEN** `sessionMw` SHALL NOT set `UserContext`
- **AND** SHALL call `next()` so downstream handlers may apply their dev-mode fallbacks

### Requirement: Logout route

`POST /auth/logout` SHALL clear the `session` cookie by emitting `Set-Cookie: session=; Path=/; Max-Age=0`, set an `auth_flash` cookie with payload `{ kind: "logged-out" }`, and respond `302 Found` with `Location: /login`.

The route SHALL accept only the POST method. Any other method (GET, HEAD, PUT, DELETE, PATCH) SHALL respond `405 Method Not Allowed`.

The route SHALL NOT require a valid session to operate — posting to `/auth/logout` with no cookie SHALL still clear the session, set the flash, and redirect.

The route SHALL NOT attempt to revoke the access token at GitHub (GitHub OAuth Apps do not support server-side revocation that matches our model); logout is purely local cookie deletion plus an IdP-logout link rendered on the signed-out banner.

Redirecting to `/login` with the `logged-out` flash (rather than to `/`) is load-bearing for the UX: `/` triggers `redirect-root` → `/trigger` → `sessionMw` → `/login` → GitHub, which silently re-authenticates using the existing OAuth grant and re-issues a session cookie, making sign-out appear to have no effect. The flash cookie puts the login route into its banner-render branch, which breaks the chain at a route that does not require authentication.

#### Scenario: POST clears cookie, sets logged-out flash, redirects to login

- **WHEN** `POST /auth/logout` is requested with any cookie state
- **THEN** the handler SHALL respond `302 Found` with `Location: /login`
- **AND** the response SHALL include `Set-Cookie: session=; Path=/; Max-Age=0`
- **AND** the response SHALL include an `auth_flash` Set-Cookie whose sealed payload unseals to `{ kind: "logged-out" }`

#### Scenario: Login page renders signed-out banner when reached via the logout flash

- **GIVEN** `POST /auth/logout` just completed and set the `logged-out` flash cookie
- **WHEN** the browser follows the 302 to `/login`
- **THEN** the login route SHALL respond `200 OK`
- **AND** the body SHALL contain a "Signed out" confirmation
- **AND** the body SHALL contain a "Sign in with GitHub" link to `/login`
- **AND** the body SHALL contain a link to `https://github.com/logout` so a user who wants a complete sign-out can end the GitHub IdP session (without it, clicking "Sign in with GitHub" or navigating to any authenticated route silently re-authenticates via the live OAuth grant)

#### Scenario: GET is rejected

- **WHEN** `GET /auth/logout` is requested
- **THEN** the handler SHALL respond `405 Method Not Allowed`
- **AND** SHALL NOT clear any cookie

### Requirement: Startup logging of auth mode

The runtime SHALL emit a log record during initialization that records the effective `auth.mode`. When the mode is `disabled` or `open`, the record SHALL be at level `warn`. When the mode is `restricted`, it MAY be at level `info`.

In restricted mode, the log record SHALL include the number of user entries and the number of org entries. The record SHALL NOT include the entries themselves (to keep allowlist contents out of log indexes).

#### Scenario: Disabled mode warns on startup

- **WHEN** the runtime starts with `AUTH_ALLOW` unset
- **THEN** it SHALL emit a `warn`-level log record identifying disabled mode

#### Scenario: Open mode warns on startup

- **WHEN** the runtime starts with `AUTH_ALLOW = "__DISABLE_AUTH__"`
- **THEN** it SHALL emit a `warn`-level log record identifying open mode

#### Scenario: Restricted mode logs counts only

- **WHEN** the runtime starts with `AUTH_ALLOW = "github:user:alice;github:user:bob;github:org:acme"`
- **THEN** the log record SHALL indicate restricted mode with 2 users and 1 org
- **AND** the record SHALL NOT contain the strings `"alice"`, `"bob"`, or `"acme"`

### Requirement: Single-replica invariant

The app runtime SHALL NOT be operated with more than one replica while the session cookie sealing password is generated in-memory. A second replica would sign cookies with a different password, causing deterministic decryption failures on every request that lands on a pod other than the one that sealed the cookie.

This requirement SHALL be enforced at the infrastructure layer (see the `infrastructure` capability's `App Deployment` requirement) and SHALL be referenced in `SECURITY.md §5` as an invariant that must be resolved (by moving the password to a shared mechanism) before `replicas > 1` is permitted.

#### Scenario: App Deployment runs with replicas=1

- **WHEN** the app Deployment is rendered via Tofu
- **THEN** `spec.replicas` SHALL equal 1

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §4 Authentication`, which enumerates the trust level, entry points, threats, current mitigations, residual risks, and rules governing this capability. This capability owns the entire authentication surface: the session cookie transport for UI routes, the Bearer transport for `/api/*`, the OAuth handshake routes, the allowlist predicate, and the `isMember` tenant predicate.

The implementation SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The `/api/workflows/:tenant` route and every `/dashboard/*` or `/trigger/*` handler that reads workflow or invocation-event data SHALL constrain reads to the caller's active tenant. Identifier-based lookups (by invocation id, workflow name, event id) SHALL NOT substitute for a tenant scope.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, alter the transport surface (add cookie auth to `/api/*`, remove the Bearer path, add new authenticated route prefixes, change sealing parameters or TTLs), alter the tenant-membership check, or conflict with the rules listed in `/SECURITY.md §4` or `/SECURITY.md §1` MUST update the corresponding sections of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or rule enumerated in `/SECURITY.md §4`, or the tenant-isolation invariant in `/SECURITY.md §1`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §4` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §4` or `/SECURITY.md §1`
- **THEN** no update to `/SECURITY.md` is required
- **AND** the proposal SHALL note that threat-model alignment was checked

