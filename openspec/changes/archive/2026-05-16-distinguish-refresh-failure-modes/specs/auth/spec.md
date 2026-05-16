## MODIFIED Requirements

### Requirement: AuthProvider interface

The runtime SHALL expose an `AuthProvider` interface that captures every per-request behavior of an authentication provider:

```ts
interface AuthProvider {
  readonly id: string;
  renderLoginSection(returnTo: string): JSX.Element;
  mountAuthRoutes(subApp: Hono): void;
  resolveApiIdentity(req: Request): Promise<UserContext | undefined>;
  refreshSession(payload: SessionPayload): Promise<RefreshResult>;
}

type RefreshResult =
  | { ok: true; user: UserContext }
  | { ok: false; reason: 'session-expired' | 'access-denied' };
```

Each provider instance SHALL be constructed once at runtime startup, after the registry buckets every `AUTH_ALLOW` entry by provider id. The instance SHALL close over its parsed entries; per-request methods SHALL NOT take an `entries` argument.

The `id` field SHALL match the provider id segment in `AUTH_ALLOW` entries (the part before the first `:`) and SHALL be used as the path segment for `mountAuthRoutes` (mounted at `/auth/<id>/`) and as the value matched against the `X-Auth-Provider` request header on `/api/*`.

`renderLoginSection` SHALL return a non-null `JSX.Element` (a `hono/jsx` component tree). A registered provider always has at least one entry by construction (the registry only instantiates providers for ids that appeared in `AUTH_ALLOW`); the "no entries to render" case is impossible. The login page composes the provider sections by embedding the returned JSX subtrees directly into the rendered tree.

`resolveApiIdentity` SHALL return `undefined` when the provider cannot resolve a `UserContext` from the request. The dispatcher SHALL treat `undefined` as a 401 outcome — there SHALL NOT be a fall-through to "try the next provider", because the dispatcher already selected exactly one provider via `X-Auth-Provider`.

`refreshSession` SHALL be invoked by the session middleware when an unsealed session payload is stale. The provider SHALL return a `RefreshResult` whose discriminator captures the outcome:

- `{ ok: true; user }` — the provider re-confirmed the user; the middleware re-seals the session.
- `{ ok: false; reason: 'session-expired' }` — the provider can no longer confirm the user's identity. This includes upstream rejection (token revoked/expired), upstream errors (4xx/5xx), network/transport failure, and malformed upstream responses. The user's recovery is to sign in again.
- `{ ok: false; reason: 'access-denied' }` — the provider successfully resolved the user but the allowlist (or other authorization policy the provider owns) excludes them.

The middleware maps `session-expired` to the `logged-out` flash and `access-denied` to the `denied` flash. Providers SHALL NOT use `access-denied` for failures that prevented identity resolution; `access-denied` is reserved for the case where a verified identity is actively excluded.

#### Scenario: Provider id matches AUTH_ALLOW prefix and route prefix

- **GIVEN** a provider exposing `id = "local"`
- **WHEN** an `AUTH_ALLOW` entry `local:dev` is parsed
- **THEN** the entry SHALL be bucketed for the provider with id `"local"`
- **AND** `mountAuthRoutes` SHALL be called with a Hono sub-app whose effective base path is `/auth/local/`
- **AND** `/api/*` requests carrying `X-Auth-Provider: local` SHALL be routed to the same provider's `resolveApiIdentity`

#### Scenario: resolveApiIdentity returning undefined yields 401

- **GIVEN** a provider whose `resolveApiIdentity` returns `undefined` for a request
- **WHEN** the `/api/*` dispatcher invokes it
- **THEN** the dispatcher SHALL respond `401 Unauthorized`
- **AND** SHALL NOT consult any other provider

#### Scenario: refreshSession ok result re-seals the session

- **GIVEN** a stale session payload
- **WHEN** the provider returns `{ ok: true, user }` from `refreshSession`
- **THEN** the middleware SHALL re-seal the session cookie with the refreshed identity and a new `resolvedAt = now`

#### Scenario: refreshSession session-expired result clears with logged-out flash

- **GIVEN** a stale session payload
- **WHEN** the provider returns `{ ok: false, reason: 'session-expired' }` from `refreshSession`
- **THEN** the middleware SHALL clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload
- **AND** redirect to `/login`

#### Scenario: refreshSession access-denied result clears with denied flash

- **GIVEN** a stale session payload with `payload.login = "foo"`
- **WHEN** the provider returns `{ ok: false, reason: 'access-denied' }` from `refreshSession`
- **THEN** the middleware SHALL clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'denied', login: "foo" }` payload
- **AND** redirect to `/login`

### Requirement: Local auth provider

The runtime SHALL provide a `localProviderFactory` that constructs an `AuthProvider` with id `"local"`. The factory SHALL accept entries with the grammar:

```
LocalRest = Name | Name ":" OrgList
OrgList   = Id ( "|" Id )*
Name      = [A-Za-z0-9][-A-Za-z0-9]*
Id        = [A-Za-z0-9][-A-Za-z0-9]*
```

Each parsed entry SHALL produce an internal record `{ name, orgs }` with `mail` derived deterministically as `<name>@dev.local`. The mail value SHALL NOT be configurable via the grammar.

If a local entry's orgs segment contains a comma, the factory SHALL throw `local entry "<entry>": orgs use '|' separator (e.g. acme|foo)`. The targeted message SHALL distinguish this fat-finger case from generic "invalid identifier" errors.

The provider SHALL implement:

- `renderLoginSection(returnTo)`: a `<form method="POST" action="/auth/local/signin">` with a hidden `returnTo` input and a `<select name="user">` dropdown listing every entry's `name`. The form SHALL contain no inline script, no inline style, no `on*=` handlers, and no `style=` attributes (CSP compatible).
- `mountAuthRoutes(app)`: registers `POST /signin` only (no callback path; no GET signin).
- `resolveApiIdentity(req)`: parses `Authorization: User <name>` from the request; returns `undefined` for any other scheme or unknown name; on match, returns `{ name, mail: <name>@dev.local, orgs }`.
- `refreshSession(payload)`: re-checks the in-memory catalog by `payload.login`. If the catalog still contains the login, returns `{ ok: true, user: { login, mail, orgs } }` synchronously. If the catalog no longer contains the login (entry removed from `AUTH_ALLOW` since the session was minted), returns `{ ok: false, reason: 'access-denied' }`. SHALL NOT make any outbound network request in either case.

The local provider SHALL NOT mint a GitHub access token or attempt to call `api.github.com`. The `accessToken` field on sealed local sessions SHALL be the empty string `""`.

#### Scenario: Single-segment local entry parses with no orgs

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `localProviderFactory.create(["dev"], deps)` is called
- **THEN** the resulting provider SHALL recognize `dev` as a valid login
- **AND** the resolved `UserContext` SHALL be `{ name: "dev", mail: "dev@dev.local", orgs: [] }`

#### Scenario: Two-segment local entry parses orgs

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `localProviderFactory.create(["alice:acme|foo"], deps)` is called
- **THEN** the resolved `UserContext` for `alice` SHALL be `{ name: "alice", mail: "alice@dev.local", orgs: ["acme", "foo"] }`

#### Scenario: Comma in orgs segment triggers targeted error

- **WHEN** `localProviderFactory.create(["alice:acme,foo"], deps)` is called
- **THEN** `create` SHALL throw an error containing the substring `orgs use '|' separator`

#### Scenario: POST /signin seals a local session and redirects to returnTo

- **GIVEN** a local provider constructed with entry `alice:acme`
- **WHEN** `POST /auth/local/signin` is invoked with form body `user=alice&returnTo=%2Finvocations`
- **THEN** the response SHALL be `302 Found` with `Location: /invocations`
- **AND** the response SHALL include `Set-Cookie: session=<sealed>` whose payload contains `provider: "local"`, `name: "alice"`, `mail: "alice@dev.local"`, `orgs: ["acme"]`, `accessToken: ""`

#### Scenario: POST /signin with unknown user returns 400

- **GIVEN** a local provider constructed with entry `dev`
- **WHEN** `POST /auth/local/signin` is invoked with form body `user=mallory&returnTo=%2F`
- **THEN** the response SHALL be `400 Bad Request`
- **AND** SHALL NOT set the session cookie

#### Scenario: POST /signin sanitizes returnTo

- **GIVEN** a local provider with entry `dev`
- **WHEN** `POST /auth/local/signin` is invoked with form body `user=dev&returnTo=//evil.example`
- **THEN** the response SHALL be `302 Found` with `Location: /`

#### Scenario: API auth via Authorization: User header

- **GIVEN** a registry containing a local provider with entry `dev`
- **WHEN** `POST /api/workflows/dev` is requested with `X-Auth-Provider: local` and `Authorization: User dev`
- **THEN** the dispatcher SHALL invoke `localProvider.resolveApiIdentity` and pass the request through with `UserContext = { name: "dev", mail: "dev@dev.local", orgs: [] }`

#### Scenario: API auth with unknown local user returns 401

- **GIVEN** a registry containing a local provider with entry `dev`
- **WHEN** `POST /api/workflows/dev` is requested with `X-Auth-Provider: local` and `Authorization: User mallory`
- **THEN** the dispatcher SHALL respond `401 Unauthorized`

#### Scenario: refreshSession returns ok immediately when catalog still contains the login

- **GIVEN** a local provider constructed with entry `alice:acme`
- **AND** a stale session payload `{ provider: "local", login: "alice", mail: "alice@dev.local", orgs: ["acme"], accessToken: "", resolvedAt: <past>, exp: <future> }`
- **WHEN** `localProvider.refreshSession(payload)` is invoked
- **THEN** it SHALL return `{ ok: true, user: { login: "alice", mail: "alice@dev.local", orgs: ["acme"] } }`
- **AND** SHALL NOT make any outbound network request

#### Scenario: refreshSession returns access-denied when catalog entry was removed

- **GIVEN** a local provider constructed with entries `dev` only
- **AND** a stale session payload `{ provider: "local", login: "alice", … }` left over from a previous boot where `alice` was in `AUTH_ALLOW`
- **WHEN** `localProvider.refreshSession(payload)` is invoked
- **THEN** it SHALL return `{ ok: false, reason: 'access-denied' }`
- **AND** SHALL NOT make any outbound network request

### Requirement: Flash cookie contract

The `auth_flash` cookie is set on every `sessionMiddleware` clear-and-redirect path, by the GitHub OAuth callback handler when the freshly resolved user fails the allowlist check, and by `POST /auth/logout`. It SHALL NOT be set when there is no session cookie to clear (first-time visitors arriving at the login page through any path SHALL see no banner). It SHALL have:
- **Name**: `auth_flash`
- **Path**: `/` (the cookie must reach `/login`, which is not under `/auth`)
- **HttpOnly**: true
- **Secure**: true (except `LOCAL_DEPLOYMENT=1`)
- **SameSite**: `Lax`
- **Max-Age**: 60 (60 seconds)
- **Payload (sealed, discriminated union)**:
  ```
  { kind: "denied"; login: string }   // set when the resolved user fails the allowlist
  | { kind: "logged-out" }            // set on logout, session expiry, unsealable cookie,
                                       // unknown provider, or refresh that returned session-expired
  ```

The `kind: "denied"` payload SHALL be set by exactly two call sites: the GitHub OAuth callback's allowlist-rejection branch, and `sessionMiddleware` when `refreshSession` returns `{ ok: false, reason: 'access-denied' }`. Every other clear-and-redirect path in `sessionMiddleware` (including `refreshSession` returning `{ ok: false, reason: 'session-expired' }`) and `POST /auth/logout` SHALL set `kind: "logged-out"`.

`GET /login` SHALL read and clear the flash cookie on every request. When the flash cookie is present and valid, the handler SHALL render the login page with the banner variant indicated by the `kind` field. When absent, the handler SHALL still render the same page (without a banner) — the login page is stable and NEVER auto-redirects to the IdP.

#### Scenario: Denied flash drives the deny banner

- **GIVEN** a user whose allowlist check fails at callback time for login `foo`
- **WHEN** the callback handler sets the flash cookie with `{ kind: "denied", login: "foo" }` and 302s to `/login`
- **THEN** the login route SHALL render the page with a "Not authorized" banner naming `foo`

#### Scenario: Logged-out flash drives the signed-out banner

- **GIVEN** a successful `POST /auth/logout`
- **WHEN** the logout handler sets the flash cookie with `{ kind: "logged-out" }` and 302s to `/login`
- **THEN** the login route SHALL render the page with a "Signed out" banner and a "Sign in again" action

#### Scenario: Session-expired refresh result drives the signed-out banner

- **GIVEN** a stale github session whose `refreshSession` returns `{ ok: false, reason: 'session-expired' }` (because GitHub rejected the token, returned 5xx, or the request failed in transit)
- **WHEN** `sessionMiddleware` redirects to `/login`
- **THEN** the response SHALL include an `auth_flash` cookie sealing `{ kind: "logged-out" }`
- **AND** the rendered `/login` page SHALL display the "Signed out" banner, not the "Not authorized" banner

#### Scenario: Flash cookie is single-use

- **GIVEN** a render of the login page from a flash cookie
- **WHEN** the response is sent
- **THEN** it SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

### Requirement: Session middleware on /invocations/* and /trigger/*

The runtime SHALL mount a `sessionMw` middleware on every route under `/invocations/*` and `/trigger/*`. `sessionMw` SHALL:

1. Read the `session` cookie. If absent, respond `302 Found` with `Location: /login?returnTo=<encoded-current-path>` and SHALL NOT set any `auth_flash` cookie (no cookie was cleared; first-time visitors must not see a "Signed out" banner).
2. If unsealing the cookie fails (including pre-migration payloads lacking `provider`), clear the session cookie, set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload, and 302 to `/login?returnTo=<encoded-current-path>`.
3. If `now >= payload.exp` (hard TTL exceeded), clear the session cookie, set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload, and 302 to `/login?returnTo=<encoded-current-path>`. SHALL NOT call `refreshSession`.
4. Look up the provider in the registry by `payload.provider`. If not registered (e.g., `LOCAL_DEPLOYMENT` was unset between sealing and reading), clear the session cookie, set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload, and 302 to `/login`.
5. If `now < payload.resolvedAt + 10 minutes`, the session is fresh: set `UserContext` from the payload and call `next()`.
6. Otherwise (stale), call `provider.refreshSession(payload)` and dispatch on the returned `RefreshResult`:
   - `{ ok: true, user }`: re-seal the session cookie with the same `provider` and `accessToken`, a new `resolvedAt = now`, and the refreshed `login`/`mail`/`orgs`; set `UserContext` and call `next()`.
   - `{ ok: false, reason: 'session-expired' }`: clear the session cookie, set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload, and 302 to `/login`.
   - `{ ok: false, reason: 'access-denied' }`: clear the session cookie, set `auth_flash` to a sealed `{ kind: 'denied', login: payload.login }` payload, and 302 to `/login`.

The seal-flash + clear-session + redirect-to-`/login` operation SHALL be performed via a single shared helper (the implementation lives in `packages/runtime/src/auth/redirect-to-login.ts`). The OAuth callback's allowlist-rejection branch SHALL also use this helper.

The middleware SHALL NOT read the `Authorization` header. The middleware SHALL NOT read any `X-Auth-Request-*` header. The middleware SHALL NOT branch on auth modes (`disabled`/`open`/`restricted`); those modes SHALL NOT exist.

The `InvocationsMiddlewareDeps` and `TriggerMiddlewareDeps` shapes SHALL declare `sessionMw` as a required field (not optional). Callers that omit it are rejected by the type system. Tests that exercise the handlers without the real `sessionMiddleware` SHALL inject a stub `MiddlewareHandler` that seeds `UserContext` on the request context via `c.set("user", …)` — there is no "dev / no sessionMw" path.

For the local provider, `refreshSession` SHALL return synchronously from an in-memory catalog lookup with `{ ok: true, … }` or `{ ok: false, reason: 'access-denied' }`. For the github provider, `refreshSession` SHALL fetch `GET /user` and `GET /user/orgs`; on any non-OK response, transport error, or malformed response, it SHALL return `{ ok: false, reason: 'session-expired' }`; on OK responses where the resolved user fails the allowlist, it SHALL return `{ ok: false, reason: 'access-denied' }`; otherwise `{ ok: true, user }`.

#### Scenario: No cookie redirects to login without a flash

- **GIVEN** registry contains the github provider
- **WHEN** `GET /invocations/foo` is requested with no `session` cookie
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=%2Finvocations%2Ffoo`
- **AND** the response SHALL NOT include any `auth_flash` Set-Cookie

#### Scenario: Unsealable cookie clears with logged-out flash

- **GIVEN** a session cookie whose payload cannot be unsealed (tampered, expired TTL, or schema-invalid, including pre-`provider` payloads)
- **WHEN** `GET /invocations/foo` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=%2Finvocations%2Ffoo`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload

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

- **GIVEN** a valid session cookie with `provider: "local"`, `resolvedAt = now - 15min`, and the catalog still contains the login
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL call `localProvider.refreshSession(payload)`
- **AND** the call SHALL complete synchronously without any outbound network request
- **AND** SHALL re-seal the cookie with `resolvedAt = now`
- **AND** call `next()`

#### Scenario: Stale local session whose catalog entry was removed

- **GIVEN** a valid session cookie with `provider: "local"`, `payload.login = "alice"`, `resolvedAt = now - 15min`
- **AND** `alice` is no longer in the local provider's catalog
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'denied', login: 'alice' }` payload

#### Scenario: Stale github session with GitHub 5xx clears with logged-out flash

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 15min`, GitHub returns 500
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload (the reason from `refreshSession` was `session-expired`, NOT `access-denied`)

#### Scenario: Stale github session with revoked or expired token clears with logged-out flash

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 15min`, GitHub returns 401 on `GET /user`
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload

#### Scenario: Stale github session with allowlist now rejecting

- **GIVEN** a valid session cookie with `provider: "github"`, GitHub responses OK, but `githubProvider.refreshSession(payload)` returns `{ ok: false, reason: 'access-denied' }` because the user is no longer on the allowlist
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'denied', login: payload.login }` payload

#### Scenario: Expired session clears with logged-out flash

- **GIVEN** a session cookie whose `exp` is in the past
- **WHEN** `GET /invocations/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login`
- **AND** clear the session cookie
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload
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
- **AND** set `auth_flash` to a sealed `{ kind: 'logged-out' }` payload
