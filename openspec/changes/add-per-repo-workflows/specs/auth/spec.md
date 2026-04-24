## MODIFIED Requirements

### Requirement: UserContext shape

The runtime SHALL resolve authenticated callers into a `UserContext` object with the following shape, independent of transport (session cookie vs. Bearer header):

```
UserContext = {
  login: string   // GitHub login handle (e.g. "alice"), from GET /user
  mail:  string   // GitHub email, from GET /user (may be "")
  orgs:  string[] // GitHub-identity namespaces the user can act as
}
```

`UserContext.orgs` SHALL contain the union of (a) the user's own `login` and (b) every GitHub org membership returned by `GET /user/orgs`. Authentication providers SHALL populate this list with the user's login included — callers (membership checks, UI selectors) SHALL treat the list as the authoritative set of owners the user can publish to or view, without special-casing the self-login separately.

`UserContext.teams` SHALL NOT exist. No capability consumes teams; `GET /user/teams` SHALL NOT be called on any auth code path.

#### Scenario: UserContext carries login, mail, and orgs including self

- **GIVEN** a user whose GitHub profile is `{ login: "alice", email: "alice@acme.test" }` and whose `/user/orgs` returns `[{ login: "acme" }]`
- **WHEN** the runtime resolves their `UserContext`
- **THEN** it SHALL be `{ login: "alice", mail: "alice@acme.test", orgs: ["alice", "acme"] }`
- **AND** the `orgs` list SHALL contain `alice` even though GitHub's `/user/orgs` did not return it
- **AND** the object SHALL NOT have a `teams` property

#### Scenario: User with no org memberships

- **GIVEN** a user whose GitHub profile is `{ login: "bob", email: "" }` and whose `/user/orgs` returns `[]`
- **WHEN** the runtime resolves their `UserContext`
- **THEN** it SHALL be `{ login: "bob", mail: "", orgs: ["bob"] }`
- **AND** `orgs` SHALL contain exactly one element, the user's own login

### Requirement: isMember owner predicate

The runtime SHALL expose an `isMember(user, owner)` predicate that returns true if and only if the `owner` string passes `validateOwner(owner)` AND `owner` is an element of `user.orgs`. The owner identifier regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`.

Because `UserContext.orgs` contains the user's own login, `isMember(user, user.login)` SHALL return true via the normal `orgs.includes(owner)` path. There SHALL NOT be a separate check against `user.login`.

This predicate scopes *which owners an already-allowed user can act as*. It is orthogonal to `allow(user)` — both MUST pass for owner-scoped write operations. Teams are NOT consulted.

#### Scenario: Personal namespace grants membership

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice"] }`
- **WHEN** `isMember(user, "alice")` is called
- **THEN** it SHALL return true via the `orgs.includes` check

#### Scenario: Org namespace grants membership

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice", "acme"] }`
- **WHEN** `isMember(user, "acme")` is called
- **THEN** it SHALL return true

#### Scenario: Non-member denied

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice", "acme"] }`
- **WHEN** `isMember(user, "victim")` is called
- **THEN** it SHALL return false

#### Scenario: Invalid owner identifier denied regardless of membership

- **GIVEN** `user = { login: "../etc/passwd", mail: "", orgs: ["../etc/passwd"] }`
- **WHEN** `isMember(user, "../etc/passwd")` is called
- **THEN** it SHALL return false because the regex validation rejects the identifier first

### Requirement: Owner-authorization middleware

The runtime SHALL expose a `requireOwnerMember()` Hono middleware factory in the `auth` capability. The middleware SHALL enforce the owner/repo-isolation invariant (SECURITY.md §4) for any route that accepts a `:owner` path parameter (optionally followed by a `:repo` path parameter), returning `404 Not Found` fail-closed on any failure mode (invalid identifier, non-member, or missing user).

Evaluation order inside the middleware:

1. Read `c.req.param("owner")`. If the value does not satisfy `validateOwner` (regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), respond with `c.notFound()`. This check SHALL run before any other check, because the regex is a path-safety guarantee, not an authorization check.
2. If the route also has a `:repo` parameter, read `c.req.param("repo")`. If the value does not satisfy `validateRepo` (regex `^[a-zA-Z0-9._-]{1,100}$`), respond with `c.notFound()`. A missing `:repo` parameter on a route that does not declare it is normal and SHALL NOT cause a 404.
3. If `user = c.get("user")` is set and `isMember(user, owner)` returns true, call `next()`.
4. Otherwise, respond with `c.notFound()`.

The middleware SHALL NOT perform a separate per-`repo` authorization check; owner-membership implies access to all repos under that owner. Finer-grained repo-level access control is explicitly out of scope (see SECURITY.md non-goals).

The middleware SHALL NOT hardcode a response body. Each Hono sub-app that mounts the middleware SHALL register an `app.notFound(c => c.json({error:"Not Found"}, 404))` handler so that 404 responses carry a uniform JSON body across `/api/*` and `/trigger/*`.

The following routes SHALL enforce owner membership by mounting `requireOwnerMember()` and SHALL NOT perform the regex + `isMember` check inline in their handlers:

- `POST /api/workflows/:owner/:repo` (mounted in `api/index.ts`).
- `POST /trigger/:owner/:repo/:workflow/:trigger` (mounted in `ui/trigger/middleware.ts` on the `/trigger`-basePath sub-app).

Any future route that accepts `:owner` or `:owner/:repo` path parameters SHALL mount `requireOwnerMember()` on the corresponding subpath. Inline owner-authorization checks in individual route handlers SHALL be treated as a defect.

#### Scenario: Invalid owner identifier returns 404

- **GIVEN** `requireOwnerMember()` is mounted on `/workflows/:owner/:repo` in the `/api` sub-app
- **WHEN** a request arrives at `POST /api/workflows/../etc/passwd/foo`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

#### Scenario: Invalid repo identifier returns 404

- **WHEN** a request arrives at `POST /api/workflows/acme/..%2Fbad`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked

#### Scenario: Non-member returns 404

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice", "acme"] }` is set on the request context
- **WHEN** a request to `POST /api/workflows/victim/foo` arrives from alice (who is not a member of victim)
- **THEN** `requireOwnerMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the response SHALL be indistinguishable from the response for an owner that does not exist

#### Scenario: Member passes to handler

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice", "acme"] }` is set on the request context
- **WHEN** a request to `POST /api/workflows/acme/foo` arrives from alice
- **THEN** `requireOwnerMember()` SHALL call `next()` without modifying the response
- **AND** the upload handler SHALL receive the request

#### Scenario: Owner membership covers all repos under that owner

- **GIVEN** `user = { login: "alice", mail: "", orgs: ["alice", "acme"] }`
- **WHEN** requests arrive at `POST /api/workflows/acme/foo` and `POST /api/workflows/acme/bar`
- **THEN** both SHALL pass `requireOwnerMember()` (no per-repo check)

#### Scenario: Missing user returns 404

- **WHEN** a request to `POST /api/workflows/acme/foo` arrives with no `user` on the context
- **THEN** `requireOwnerMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`

#### Scenario: Trigger POST uses same middleware

- **GIVEN** `requireOwnerMember()` is mounted on the `/trigger`-basePath sub-app
- **AND** `user = { login: "alice", mail: "", orgs: ["alice"] }` is set
- **WHEN** a request to `POST /trigger/victim/repo/wf/tr` arrives from alice
- **THEN** `requireOwnerMember()` SHALL respond with `404 Not Found`
- **AND** the body SHALL be `{"error":"Not Found"}`

### Requirement: Session cookie contract

The `session` cookie SHALL have:
- **Name**: `session`
- **Path**: `/`
- **HttpOnly**: true
- **Secure**: true (except when `LOCAL_DEPLOYMENT=1` is set, in which case Secure MAY be false)
- **SameSite**: `Lax`
- **Max-Age**: 604800 (7 days hard TTL)
- **Payload (sealed)**:
  ```
  {
    provider:    "github" | "local"
    login:       string               // GitHub login, was `name` in the prior shape
    mail:        string
    orgs:        string[]             // includes the user's own login
    accessToken: string
    resolvedAt:  number
    exp:         number
  }
  ```

The `provider` field SHALL be required; sealed payloads lacking it SHALL fail to unseal and SHALL cause the request to be treated as unauthenticated.

The `login` field SHALL be required; sealed payloads produced by a prior runtime version that carried `name` SHALL fail to unseal. Because the session seal password rotates on every pod restart (see "Session cookie sealing"), no backward-compat decoding SHALL be implemented — cookies minted by the old code are automatically invalidated when the pod restarts to the new code.

The sealed cookie SHALL be no larger than 4096 bytes; if the payload would exceed that after sealing, the runtime SHALL log an error and abort the session.

#### Scenario: github session payload carries provider and login

- **GIVEN** a user who completes the github OAuth flow with `{ login: "alice", email: "a@x", orgs: ["acme"] }`
- **WHEN** the github callback handler seals the session cookie
- **THEN** the payload SHALL contain `provider: "github"`, `login: "alice"`, `mail`, `orgs: ["alice", "acme"]`, `accessToken`, `resolvedAt`, and `exp`
- **AND** `orgs` SHALL include the user's own login `alice`

#### Scenario: local session payload carries provider and login

- **GIVEN** a local user `dev` selected via the local provider's signin form
- **WHEN** `POST /auth/local/signin` seals the session cookie
- **THEN** the payload SHALL contain `provider: "local"`, `login: "dev"`, `mail: "dev@dev.local"`, `orgs: ["dev"]`, `accessToken: ""`, `resolvedAt`, and `exp`
- **AND** `orgs` SHALL include `dev` even when the local entry declared no additional memberships

#### Scenario: Pre-rename session cookie fails to unseal

- **GIVEN** a session cookie sealed by a prior runtime version that used `name` instead of `login`
- **WHEN** the cookie is presented to `sessionMw` after a pod restart
- **THEN** unsealing SHALL fail (new seal password invalidates the old cookie)
- **AND** the session cookie SHALL be cleared
- **AND** the response SHALL be `302 Found` with `Location: /login?returnTo=...`

## REMOVED Requirements

### Requirement: isMember tenant predicate

**Reason:** Replaced by "isMember owner predicate" with updated signature, terminology, and simplified implementation (membership now checks a single list that already contains the user's own login).

**Migration:** Replace every call to `isMember(user, tenant)` with `isMember(user, owner)`. The predicate's return value for a given user+identifier pair is unchanged — what changed is the internal implementation and the parameter name.

### Requirement: Tenant-authorization middleware

**Reason:** Replaced by "Owner-authorization middleware" with updated terminology and extended to cover the new `:repo` path parameter on scoped routes.

**Migration:** Replace every mount of `requireTenantMember()` with `requireOwnerMember()`; the middleware's function signature and behavior are unchanged beyond the new additional `:repo` regex validation when the route declares that parameter.
