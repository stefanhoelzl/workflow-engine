## MODIFIED Requirements

### Requirement: Session middleware on /invocations/* and /trigger/*

The runtime SHALL mount a `sessionMw` middleware on every route under `/invocations/*` and `/trigger/*`. `sessionMw` SHALL:

1. Read the `session` cookie. If absent or unsealing fails (including pre-migration payloads lacking `provider`), respond `302 Found` with `Location: /login?returnTo=<encoded-current-path>`.
2. If `now >= payload.exp` (hard TTL exceeded), clear the session cookie and 302 to `/login?returnTo=<encoded-current-path>`.
3. Look up the provider in the registry by `payload.provider`. If not registered (e.g., `LOCAL_DEPLOYMENT` was unset between sealing and reading), clear the session cookie and 302 to `/login`.
4. If `now < payload.resolvedAt + 10 minutes`, the session is fresh: set `UserContext` from the payload and call `next()`.
5. Otherwise (stale), call `provider.refreshSession(payload)`. If it returns `undefined`, set `auth_flash`, clear the session, and 302 to `/login`. If it returns a `UserContext`, re-seal the session cookie with the same `provider` and `accessToken`, a new `resolvedAt = now`, and the refreshed `name`/`mail`/`orgs`; set `UserContext` and call `next()`.

The middleware SHALL NOT read the `Authorization` header. The middleware SHALL NOT read any `X-Auth-Request-*` header. The middleware SHALL NOT branch on auth modes (`disabled`/`open`/`restricted`); those modes SHALL NOT exist.

The `InvocationsMiddlewareDeps` and `TriggerMiddlewareDeps` shapes SHALL declare `sessionMw` as a required field (not optional). Callers that omit it are rejected by the type system. Tests that exercise the handlers without the real `sessionMiddleware` SHALL inject a stub `MiddlewareHandler` that seeds `UserContext` on the request context via `c.set("user", …)` — there is no "dev / no sessionMw" path.

For the local provider, `refreshSession` SHALL return immediately with the payload's identity (no external call). For the github provider, `refreshSession` SHALL fetch `GET /user` and `GET /user/orgs`, evaluate the github allowlist, and return `undefined` on any non-OK response or allowlist miss.

#### Scenario: No cookie redirects to login

- **GIVEN** registry contains the github provider
- **WHEN** `GET /invocations/foo` is requested with no `session` cookie
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=%2Finvocations%2Ffoo`

#### Scenario: Fresh github session passes through without external call

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 2min`
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL call `next()` with `UserContext` set from the payload
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Fresh local session passes through

- **GIVEN** a valid session cookie with `provider: "local"`, `resolvedAt = now - 2min`
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL call `next()` with `UserContext` set from the payload

#### Scenario: Stale local session refreshes immediately without external call

- **GIVEN** a valid session cookie with `provider: "local"`, `resolvedAt = now - 15min`
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL call `localProvider.refreshSession(payload)`
- **AND** the call SHALL complete synchronously without any outbound network request
- **AND** SHALL re-seal the cookie with `resolvedAt = now`
- **AND** call `next()`

#### Scenario: Stale github session with GitHub 5xx fails closed

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 15min`, GitHub returns 500
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** clear the session cookie

#### Scenario: Stale github session with allowlist now rejecting

- **GIVEN** a valid session cookie with `provider: "github"`, GitHub responses OK, but `githubProvider.refreshSession(payload)` returns `undefined` because the user is no longer on the allowlist
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login`
- **AND** set `Set-Cookie: auth_flash=<sealed>; Path=/auth; Max-Age=60`
- **AND** clear the session cookie

#### Scenario: Expired session redirects to login

- **GIVEN** a session cookie whose `exp` is in the past
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login` and clear the session cookie
- **AND** SHALL NOT call `refreshSession`

#### Scenario: Empty registry redirects every request to login

- **GIVEN** the provider registry is empty
- **WHEN** any request reaches `/invocations/*` or `/trigger/*`
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** the rendered login page SHALL have no provider sections

#### Scenario: Session payload references unregistered provider

- **GIVEN** a valid session cookie with `provider: "local"` but `LOCAL_DEPLOYMENT` is now unset (so the local provider is not registered)
- **WHEN** any request reaches `/invocations/*`
- **THEN** `sessionMw` SHALL clear the session cookie and 302 to `/login`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §4 Authentication`, which enumerates the trust level, entry points, threats, current mitigations, residual risks, and rules governing this capability. This capability owns the entire authentication surface: the session cookie transport for UI routes, the Bearer transport for `/api/*`, the OAuth handshake routes, the allowlist predicate, and the `isMember` tenant predicate.

The implementation SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The `/api/workflows/:tenant` route and every `/invocations/*` or `/trigger/*` handler that reads workflow or invocation-event data SHALL constrain reads to the caller's active tenant. Identifier-based lookups (by invocation id, workflow name, event id) SHALL NOT substitute for a tenant scope.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, alter the transport surface (add cookie auth to `/api/*`, remove the Bearer path, add new authenticated route prefixes, change sealing parameters or TTLs), alter the tenant-membership check, or conflict with the rules listed in `/SECURITY.md §4` or `/SECURITY.md §1` MUST update the corresponding sections of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or rule enumerated in `/SECURITY.md §4`, or the tenant-isolation invariant in `/SECURITY.md §1`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §4` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §4` or `/SECURITY.md §1`
- **THEN** the proposal MAY proceed without modifying `/SECURITY.md`
