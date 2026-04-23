## ADDED Requirements

### Requirement: AuthProvider interface

The runtime SHALL expose an `AuthProvider` interface that captures every per-request behavior of an authentication provider:

```ts
interface AuthProvider {
  readonly id: string;
  renderLoginSection(returnTo: string): HtmlEscapedString;
  mountAuthRoutes(subApp: Hono): void;
  resolveApiIdentity(req: Request): Promise<UserContext | undefined>;
  refreshSession(payload: SessionPayload): Promise<UserContext | undefined>;
}
```

Each provider instance SHALL be constructed once at runtime startup, after the registry buckets every `AUTH_ALLOW` entry by provider id. The instance SHALL close over its parsed entries; per-request methods SHALL NOT take an `entries` argument.

The `id` field SHALL match the provider id segment in `AUTH_ALLOW` entries (the part before the first `:`) and SHALL be used as the path segment for `mountAuthRoutes` (mounted at `/auth/<id>/`) and as the value matched against the `X-Auth-Provider` request header on `/api/*`.

`renderLoginSection` SHALL return a non-null `HtmlEscapedString`. A registered provider always has at least one entry by construction (the registry only instantiates providers for ids that appeared in `AUTH_ALLOW`); the "no entries to render" case is impossible.

`resolveApiIdentity` SHALL return `undefined` when the provider cannot resolve a `UserContext` from the request. The dispatcher SHALL treat `undefined` as a 401 outcome — there SHALL NOT be a fall-through to "try the next provider", because the dispatcher already selected exactly one provider via `X-Auth-Provider`.

`refreshSession` SHALL be invoked by the session middleware when an unsealed session payload is stale. The provider SHALL return a `UserContext` to refresh the session or `undefined` to invalidate it. Local-provider implementations MAY return immediately because their entry catalog is static at boot.

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

### Requirement: AuthProviderFactory and provider registry

The runtime SHALL expose an `AuthProviderFactory` interface used at startup to construct `AuthProvider` instances:

```ts
interface AuthProviderFactory {
  readonly id: string;
  create(rawEntries: readonly string[],
         deps: ProviderRouteDeps): AuthProvider;
}
```

The factory list SHALL be assembled at module load:
- `githubProviderFactory` SHALL always be included.
- `localProviderFactory` SHALL be included if and only if `process.env.LOCAL_DEPLOYMENT === "1"`.

The provider registry build SHALL:
1. Split `AUTH_ALLOW` on the top-level separator `,`, trim whitespace, skip empty segments.
2. For each entry, split on the first `:` only — yielding `(id, rest)`.
3. Look up `id` in the factory list; throw a startup error `unknown provider "<id>"` if not found.
4. Append `rest` to the per-id bucket of raw strings.
5. For each `(id, rawList)` bucket, call `factory.create(rawList, deps)` and register the returned provider under its id.

`factory.create` SHALL be the only entry point that performs provider-specific parsing of the `rest` strings. Parsing SHALL NOT be exposed as a separate public method on the factory or instance. A provider whose entries fail to parse SHALL throw inside `create`, which SHALL propagate as a `createConfig` startup error.

The registry SHALL fail startup if an `AUTH_ALLOW` entry references a provider id that has no factory in the list — including `local` when `LOCAL_DEPLOYMENT` is unset. The error message SHALL be `unknown provider "local"`, identical to a typo error class, with no special-case treatment.

#### Scenario: Empty AUTH_ALLOW yields empty registry

- **WHEN** `createConfig` is called with `AUTH_ALLOW` unset
- **THEN** the registry SHALL contain zero providers
- **AND** the runtime SHALL start successfully

#### Scenario: local entry without LOCAL_DEPLOYMENT fails startup

- **GIVEN** `LOCAL_DEPLOYMENT` is unset
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:dev"`
- **THEN** `createConfig` SHALL throw a validation error containing `unknown provider "local"`

#### Scenario: local entry with LOCAL_DEPLOYMENT registers the provider

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:dev,local:alice:acme|foo"`
- **THEN** the registry SHALL contain a provider with id `"local"`
- **AND** that provider SHALL render a login section with two selectable users (`dev`, `alice`)

#### Scenario: Mixed providers register both

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,local:dev"`
- **THEN** the registry SHALL contain providers with ids `"github"` and `"local"`

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
- `refreshSession(payload)`: returns `{ name: payload.name, mail: payload.mail, orgs: payload.orgs }` synchronously without any external call (the catalog is static at boot).

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
- **WHEN** `POST /auth/local/signin` is invoked with form body `user=alice&returnTo=%2Fdashboard`
- **THEN** the response SHALL be `302 Found` with `Location: /dashboard`
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

#### Scenario: refreshSession returns immediately without external call

- **GIVEN** a stale session payload `{ provider: "local", name: "alice", mail: "alice@dev.local", orgs: ["acme"], accessToken: "", resolvedAt: <past>, exp: <future> }`
- **WHEN** `localProvider.refreshSession(payload)` is invoked
- **THEN** it SHALL return `{ name: "alice", mail: "alice@dev.local", orgs: ["acme"] }`
- **AND** SHALL NOT make any outbound network request

### Requirement: X-Auth-Provider header dispatch on /api/*

The `/api/*` Bearer/User middleware SHALL dispatch by reading the `X-Auth-Provider` request header. The middleware SHALL:

1. Read `X-Auth-Provider`. If missing or empty, respond `401 Unauthorized`.
2. Look up the provider in the registry by id. If not registered, respond `401 Unauthorized`.
3. Call `provider.resolveApiIdentity(req)`. If it returns `undefined`, respond `401 Unauthorized`.
4. On success, set `UserContext` on the request context and call `next()`.

The middleware SHALL NOT pre-parse the `Authorization` header — that is each provider's responsibility. The middleware SHALL NOT consult any other provider after receiving `undefined` from the selected one.

The `X-Auth-Provider` header value alone SHALL NOT be treated as identity; it only selects which provider is asked. The provider's `resolveApiIdentity` SHALL validate the actual credential.

The 401 response body SHALL be `{ "error": "Unauthorized" }`, identical for every failure mode (missing header, unknown provider, provider returned undefined).

#### Scenario: Missing X-Auth-Provider returns 401

- **WHEN** a request to `/api/workflows/<tenant>` arrives without `X-Auth-Provider`
- **THEN** the middleware SHALL respond `401 Unauthorized` with body `{ "error": "Unauthorized" }`
- **AND** SHALL NOT call any provider's `resolveApiIdentity`

#### Scenario: Unknown provider id returns 401

- **GIVEN** a registry containing only `github`
- **WHEN** a request arrives with `X-Auth-Provider: oidc`
- **THEN** the middleware SHALL respond `401 Unauthorized` with body `{ "error": "Unauthorized" }`

#### Scenario: Identical 401 across failure modes

- **GIVEN** a registry containing only `github`
- **WHEN** comparing the responses for: (a) no `X-Auth-Provider`, (b) `X-Auth-Provider: oidc`, (c) `X-Auth-Provider: github` with malformed `Authorization`
- **THEN** all three responses SHALL be `401 Unauthorized` with body `{ "error": "Unauthorized" }`

## MODIFIED Requirements

### Requirement: AUTH_ALLOW grammar

The runtime SHALL accept an `AUTH_ALLOW` environment variable with the grammar:

```
AUTH_ALLOW    = Entry ( "," Entry )*
Entry         = ProviderId ":" ProviderRest
```

The top-level parser SHALL split entries on `,`, trim whitespace, and skip empty segments. For each entry, the parser SHALL split on the first `:` only — yielding `(ProviderId, ProviderRest)` — and dispatch `ProviderRest` to the registered provider's `create` method.

`ProviderRest` grammar SHALL be private to each provider:

```
github rest = Kind ":" Id
              Kind = "user" | "org"
              Id   = [A-Za-z0-9][-A-Za-z0-9]*

local rest  = Name | Name ":" OrgList
              OrgList = Id ( "|" Id )*
              Name    = [A-Za-z0-9][-A-Za-z0-9]*
              Id      = [A-Za-z0-9][-A-Za-z0-9]*
```

Tokens whose `ProviderId` is not a registered provider SHALL cause `createConfig` to throw `unknown provider "<id>"` at startup. Tokens whose `ProviderRest` fails the matched provider's parser SHALL cause `createConfig` to throw the provider's specific parse error.

The grammar SHALL NOT contain a sentinel for "auth disabled". Empty/unset `AUTH_ALLOW` SHALL produce an empty provider registry; the login page SHALL render with no provider sections; nothing SHALL authenticate.

#### Scenario: Mixed user and org github entries

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,github:org:acme,github:user:bob"`
- **THEN** the github provider SHALL be registered with internal entries representing users `{"alice", "bob"}` and orgs `{"acme"}`

#### Scenario: Mixed providers parse independently

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,local:dev,local:bob:foo|bar"`
- **THEN** both `github` and `local` providers SHALL be registered
- **AND** the local provider SHALL recognize logins `dev` and `bob` (with `bob` having orgs `["foo", "bar"]`)

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "google:user:alice"`
- **THEN** `createConfig` SHALL throw a validation error containing `unknown provider "google"`

#### Scenario: Whitespace around entries is trimmed

- **WHEN** `createConfig` is called with `AUTH_ALLOW = " github:user:alice , local:dev "`
- **AND** `LOCAL_DEPLOYMENT = "1"`
- **THEN** both providers SHALL be registered without parse error

#### Scenario: github entry with malformed kind fails startup with provider-specific message

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:team:eng"`
- **THEN** `createConfig` SHALL throw the github provider's parse error identifying `team` as an unknown kind

#### Scenario: local entry with comma-separated orgs fails startup with targeted hint

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:alice:acme,foo"`
- **THEN** `createConfig` SHALL throw an error containing `orgs use '|' separator`

### Requirement: Bearer middleware on /api/*

The runtime SHALL mount a provider-dispatch middleware on every `/api/*` route. The middleware SHALL:

1. Read the `X-Auth-Provider` request header. If missing or empty, respond `401 Unauthorized`.
2. Look up the provider in the registry by the header value. If not registered, respond `401 Unauthorized`.
3. Call `provider.resolveApiIdentity(req)`. If it returns `undefined`, respond `401 Unauthorized`.
4. On success, set the `UserContext` on the request context and call `next()`.

The middleware SHALL NOT read any cookie. The middleware SHALL NOT read any `X-Auth-Request-*` header. The middleware SHALL NOT pre-parse the `Authorization` header — each provider does its own parsing.

The 401 response body SHALL be `{ "error": "Unauthorized" }`, identical in every failure case.

When the provider registry is empty, every `/api/*` request SHALL respond `401 Unauthorized`. There SHALL NOT be a "disabled mode" code path that produces this behavior — the empty registry produces it naturally because no provider can resolve identity.

The github provider's `resolveApiIdentity` SHALL parse `Authorization: Bearer <token>`, fetch `GET https://api.github.com/user` and `GET https://api.github.com/user/orgs` in parallel using the token, build `UserContext`, and return it only if the user matches the github provider's allowlist (users-or-orgs check). On any failure (missing/malformed Authorization header, GitHub error 4xx/5xx, allowlist miss, token expired) it SHALL return `undefined`.

The local provider's `resolveApiIdentity` SHALL parse `Authorization: User <name>` and return a `UserContext` only if `<name>` matches a local entry. Any other scheme or unknown name SHALL return `undefined`.

#### Scenario: Valid github token, user on allowlist

- **GIVEN** registry has github provider with entry `github:user:alice`
- **WHEN** a request to `/api/workflows/<tenant>` presents `X-Auth-Provider: github` and `Authorization: Bearer <token>` whose `/user` resolves to `{ login: "alice" }`
- **THEN** the dispatcher SHALL set `UserContext` and pass to the handler

#### Scenario: Valid github token, user's org on allowlist

- **GIVEN** registry has github provider with entry `github:org:acme`
- **WHEN** a request to `/api/workflows/<tenant>` presents `X-Auth-Provider: github` and `Authorization: Bearer <token>` whose `/user/orgs` returns `[{ login: "acme" }]`
- **THEN** the dispatcher SHALL set `UserContext` and pass to the handler

#### Scenario: Missing X-Auth-Provider returns 401

- **WHEN** a request to `/api/workflows/<tenant>` has `Authorization: Bearer <token>` but no `X-Auth-Provider` header
- **THEN** the dispatcher SHALL respond `401 Unauthorized` with body `{ "error": "Unauthorized" }`

#### Scenario: Unknown X-Auth-Provider returns 401

- **GIVEN** registry contains only github
- **WHEN** a request arrives with `X-Auth-Provider: oidc` and any Authorization header
- **THEN** the dispatcher SHALL respond `401 Unauthorized`

#### Scenario: GitHub API error returns 401

- **GIVEN** registry has github provider, request carries `X-Auth-Provider: github` and a Bearer token
- **WHEN** `GET /user` returns 401 from GitHub
- **THEN** the dispatcher SHALL respond `401 Unauthorized` with body `{ "error": "Unauthorized" }`

#### Scenario: Allowlist miss returns 401

- **GIVEN** registry has github provider with `github:user:alice`
- **WHEN** a request presents `X-Auth-Provider: github` and a Bearer token whose `/user` resolves to `{ login: "eve" }`
- **THEN** the dispatcher SHALL respond `401 Unauthorized` with body `{ "error": "Unauthorized" }`

#### Scenario: Forward-auth headers are ignored

- **GIVEN** a request to `/api/workflows/victim-tenant` with `X-Auth-Provider: github`, `Authorization: Bearer <token>` whose `/user/orgs` returns `[]`, AND forged headers `X-Auth-Request-User: attacker`, `X-Auth-Request-Groups: victim-tenant`
- **WHEN** the github provider resolves `UserContext`
- **THEN** `UserContext.orgs` SHALL be `[]` (from GitHub), NOT `["victim-tenant"]` (from the header)
- **AND** the subsequent `isMember` check SHALL fail

#### Scenario: Empty registry rejects every request

- **GIVEN** the provider registry is empty
- **WHEN** any request reaches `/api/*` with any combination of headers
- **THEN** the dispatcher SHALL respond `401 Unauthorized`
- **AND** no outbound call to `api.github.com` SHALL be made

### Requirement: Tenant-authorization middleware

The runtime SHALL expose a `requireTenantMember()` Hono middleware factory in the `auth` capability. The middleware SHALL enforce the tenant-isolation invariant (SECURITY.md §4) for any route that accepts a `:tenant` path parameter, returning `404 Not Found` fail-closed on any failure mode (invalid identifier, non-member, or missing user).

Evaluation order inside the middleware:

1. Read `c.req.param("tenant")`. If the value does not satisfy `validateTenant` (regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), respond with `c.notFound()`. This check SHALL run before any other check, because the regex is a path-safety guarantee, not an authorization check.
2. If `user = c.get("user")` is set and `isMember(user, tenant)` returns true, call `next()`.
3. Otherwise, respond with `c.notFound()`.

The middleware SHALL NOT branch on any open-mode flag; the `authOpen` `ContextVariableMap` field SHALL NOT exist. Authentication is now binary: either a `UserContext` is set (by some provider) or it is not.

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

- **GIVEN** `user = { name: "alice", mail: "", orgs: ["acme"] }` is set on the request context
- **WHEN** a request to `POST /api/workflows/victim` arrives from alice (who is not a member of victim)
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the response SHALL be indistinguishable from the response for a tenant that does not exist

#### Scenario: Member passes to handler

- **GIVEN** `user = { name: "alice", mail: "", orgs: ["acme"] }` is set on the request context
- **WHEN** a request to `POST /api/workflows/acme` arrives from alice
- **THEN** `requireTenantMember()` SHALL call `next()` without modifying the response
- **AND** the upload handler SHALL receive the request

#### Scenario: Missing user returns 404

- **WHEN** a request to `POST /api/workflows/acme` arrives with no `user` on the context (e.g., authn middleware failed to populate it)
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the middleware SHALL NOT fall through to the handler

#### Scenario: Trigger POST uses same middleware

- **GIVEN** `requireTenantMember()` is mounted on `/:tenant/*` of the `/trigger`-basePath sub-app
- **AND** `user = { name: "alice", mail: "", orgs: [] }` is set
- **WHEN** a request to `POST /trigger/victim/wf/tr` arrives from alice
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found`
- **AND** the body SHALL be `{"error":"Not Found"}`

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
    provider:    "github" | "local"   // identifies which provider minted this session
    name:        string
    mail:        string
    orgs:        string[]
    accessToken: string               // GitHub OAuth access token; "" for local sessions
    resolvedAt:  number               // ms since epoch of last refresh
    exp:         number               // ms since epoch of hard expiry
  }
  ```

The `provider` field SHALL be required; sealed payloads lacking it SHALL fail to unseal and SHALL cause the request to be treated as unauthenticated. There SHALL NOT be an implicit default value.

The sealed cookie SHALL be no larger than 4096 bytes; if the payload would exceed that after sealing, the runtime SHALL log an error and abort the session.

#### Scenario: github session payload carries provider field

- **GIVEN** a user who completes the github OAuth flow with `{ login: "alice", email: "a@x", orgs: ["acme"] }`
- **WHEN** the github callback handler seals the session cookie
- **THEN** the payload SHALL contain `provider: "github"`, `name`, `mail`, `orgs`, `accessToken`, `resolvedAt`, and `exp`

#### Scenario: local session payload carries provider field

- **GIVEN** a local user `dev` selected via the local provider's signin form
- **WHEN** `POST /auth/local/signin` seals the session cookie
- **THEN** the payload SHALL contain `provider: "local"`, `name: "dev"`, `mail: "dev@dev.local"`, `orgs: []`, `accessToken: ""`, `resolvedAt`, and `exp`

#### Scenario: Pre-migration session cookie fails to unseal

- **GIVEN** a session cookie sealed by a prior runtime version that did not include the `provider` field
- **WHEN** the cookie is presented to `sessionMw`
- **THEN** unsealing SHALL fail and the request SHALL be treated as unauthenticated
- **AND** the session cookie SHALL be cleared
- **AND** the response SHALL be `302 Found` with `Location: /login?returnTo=...`

### Requirement: Login page route

`GET /login` SHALL be a provider-agnostic sign-in page. The URL is deliberately not scoped under any single provider's `/auth/<id>/` prefix so multiple providers can be offered on the same page.

The route SHALL always render an HTML page — it SHALL NEVER initiate a provider flow or redirect to an IdP on its own. A provider flow SHALL start only when the user clicks/submits a provider-specific control on the page.

Behavior:
1. Read the `returnTo` query parameter; sanitize to a same-origin relative path (default `/`).
2. Read the `auth_flash` cookie if present; unseal and clear it.
3. Iterate the provider registry in registration order. For each registered provider, call `provider.renderLoginSection(returnTo)` and concatenate the returned `HtmlEscapedString` into the login card.
4. Respond `200 OK` with an HTML page containing:
   - The brand element.
   - The provider sections from step 3 (or no sections if the registry is empty).
   - If the flash payload was `{ kind: "denied", login }`: a banner identifying the rejected login and a `Sign out of GitHub` external link.
   - If the flash payload was `{ kind: "logged-out" }`: a "Signed out" banner and a `Sign out of GitHub` external link.
   - No banner when no flash cookie is present.

The HTML SHALL contain no inline script, no inline style, no `on*=` event-handler attributes, and no `style=` attributes, per the app's CSP. The page SHALL NOT include the app chrome (topbar, sidebar, tenant selector) — it is a standalone layout for unauthenticated users.

When the registry is empty, the rendered card SHALL contain the brand and any flash banner but no provider sections; the page SHALL still respond `200 OK` (it is not an error to have no providers configured, but the user cannot proceed past the page).

#### Scenario: Renders github section when only github is registered

- **GIVEN** registry contains only the github provider
- **WHEN** `GET /login?returnTo=/dashboard` is requested without a flash cookie
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain a "Sign in with GitHub" link to `/auth/github/signin?returnTo=%2Fdashboard`
- **AND** the body SHALL NOT contain a local-provider form

#### Scenario: Renders local section when only local is registered

- **GIVEN** registry contains only the local provider with entries `dev` and `alice`
- **WHEN** `GET /login` is requested
- **THEN** the body SHALL contain `<form … action="/auth/local/signin">`
- **AND** the form SHALL contain options for both `dev` and `alice`
- **AND** the body SHALL NOT contain a "Sign in with GitHub" link

#### Scenario: Renders both sections when both providers are registered

- **GIVEN** registry contains both github and local providers
- **WHEN** `GET /login` is requested
- **THEN** the body SHALL contain BOTH the github link AND the local form

#### Scenario: Renders empty card when registry is empty

- **GIVEN** registry contains no providers (`AUTH_ALLOW` unset)
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the body SHALL contain the brand
- **AND** the body SHALL NOT contain any provider section
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Flash cookie renders deny banner regardless of provider

- **GIVEN** an `auth_flash` cookie sealing `{ kind: "denied", login: "foo" }`
- **WHEN** `GET /login` is requested with any registry composition
- **THEN** the handler SHALL respond `200 OK` with a "Not authorized" banner naming `foo`
- **AND** the response SHALL include `Set-Cookie: auth_flash=; Max-Age=0`

#### Scenario: Refreshing the page stays on the page (no auto-redirect)

- **GIVEN** no flash cookie is present
- **WHEN** `GET /login` is requested
- **THEN** the handler SHALL respond `200 OK`
- **AND** the response SHALL NOT include a `Location` header

#### Scenario: Malformed returnTo defaults to /

- **WHEN** `GET /login?returnTo=//evil.example` is requested with a github-only registry
- **THEN** the github section in the rendered page SHALL link to `/auth/github/signin?returnTo=%2F`

### Requirement: Session middleware on /dashboard/* and /trigger/*

The runtime SHALL mount a `sessionMw` middleware on every route under `/dashboard/*` and `/trigger/*`. `sessionMw` SHALL:

1. Read the `session` cookie. If absent or unsealing fails (including pre-migration payloads lacking `provider`), respond `302 Found` with `Location: /login?returnTo=<encoded-current-path>`.
2. If `now >= payload.exp` (hard TTL exceeded), clear the session cookie and 302 to `/login?returnTo=<encoded-current-path>`.
3. Look up the provider in the registry by `payload.provider`. If not registered (e.g., `LOCAL_DEPLOYMENT` was unset between sealing and reading), clear the session cookie and 302 to `/login`.
4. If `now < payload.resolvedAt + 10 minutes`, the session is fresh: set `UserContext` from the payload and call `next()`.
5. Otherwise (stale), call `provider.refreshSession(payload)`. If it returns `undefined`, set `auth_flash`, clear the session, and 302 to `/login`. If it returns a `UserContext`, re-seal the session cookie with the same `provider` and `accessToken`, a new `resolvedAt = now`, and the refreshed `name`/`mail`/`orgs`; set `UserContext` and call `next()`.

The middleware SHALL NOT read the `Authorization` header. The middleware SHALL NOT read any `X-Auth-Request-*` header. The middleware SHALL NOT branch on auth modes (`disabled`/`open`/`restricted`); those modes SHALL NOT exist.

For the local provider, `refreshSession` SHALL return immediately with the payload's identity (no external call). For the github provider, `refreshSession` SHALL fetch `GET /user` and `GET /user/orgs`, evaluate the github allowlist, and return `undefined` on any non-OK response or allowlist miss.

#### Scenario: No cookie redirects to login

- **GIVEN** registry contains the github provider
- **WHEN** `GET /dashboard/foo` is requested with no `session` cookie
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=%2Fdashboard%2Ffoo`

#### Scenario: Fresh github session passes through without external call

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 2min`
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL call `next()` with `UserContext` set from the payload
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Fresh local session passes through

- **GIVEN** a valid session cookie with `provider: "local"`, `resolvedAt = now - 2min`
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL call `next()` with `UserContext` set from the payload

#### Scenario: Stale local session refreshes immediately without external call

- **GIVEN** a valid session cookie with `provider: "local"`, `resolvedAt = now - 15min`
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL call `localProvider.refreshSession(payload)`
- **AND** the call SHALL complete synchronously without any outbound network request
- **AND** SHALL re-seal the cookie with `resolvedAt = now`
- **AND** call `next()`

#### Scenario: Stale github session with GitHub 5xx fails closed

- **GIVEN** a valid session cookie with `provider: "github"`, `resolvedAt = now - 15min`, GitHub returns 500
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** clear the session cookie

#### Scenario: Stale github session with allowlist now rejecting

- **GIVEN** a valid session cookie with `provider: "github"`, GitHub responses OK, but `githubProvider.refreshSession(payload)` returns `undefined` because the user is no longer on the allowlist
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login`
- **AND** set `Set-Cookie: auth_flash=<sealed>; Path=/auth; Max-Age=60`
- **AND** clear the session cookie

#### Scenario: Expired session redirects to login

- **GIVEN** a session cookie whose `exp` is in the past
- **WHEN** `GET /dashboard/` is requested
- **THEN** `sessionMw` SHALL 302 to `/login` and clear the session cookie
- **AND** SHALL NOT call `refreshSession`

#### Scenario: Empty registry redirects every request to login

- **GIVEN** the provider registry is empty
- **WHEN** any request reaches `/dashboard/*` or `/trigger/*`
- **THEN** `sessionMw` SHALL respond `302 Found` with `Location: /login?returnTo=...`
- **AND** the rendered login page SHALL have no provider sections

#### Scenario: Session payload references unregistered provider

- **GIVEN** a valid session cookie with `provider: "local"` but `LOCAL_DEPLOYMENT` is now unset (so the local provider is not registered)
- **WHEN** any request reaches `/dashboard/*`
- **THEN** `sessionMw` SHALL clear the session cookie and 302 to `/login`

### Requirement: Startup logging of auth mode

The runtime SHALL emit a log record during initialization that records the registered providers and per-provider entry counts.

When the registry is empty, the record SHALL be at level `warn` and indicate that no providers are configured.

When the registry contains at least one provider, the record SHALL be at level `info` and SHALL list each provider's id and entry count.

The log record SHALL NOT include the entry contents themselves (no logins, no org names, no local user names) to keep allowlist contents out of log indexes.

#### Scenario: Empty registry warns on startup

- **WHEN** the runtime starts with `AUTH_ALLOW` unset
- **THEN** it SHALL emit a `warn`-level log record indicating no providers are configured

#### Scenario: Single-provider registry logs counts only

- **WHEN** the runtime starts with `AUTH_ALLOW = "github:user:alice,github:user:bob,github:org:acme"`
- **THEN** the log record SHALL be at level `info` and SHALL indicate that the github provider is registered with 2 user entries and 1 org entry
- **AND** the record SHALL NOT contain the strings `"alice"`, `"bob"`, or `"acme"`

#### Scenario: Multi-provider registry logs each provider

- **GIVEN** `LOCAL_DEPLOYMENT = "1"`
- **WHEN** the runtime starts with `AUTH_ALLOW = "github:user:alice,local:dev,local:bob"`
- **THEN** the log record SHALL list both `github` and `local` with their respective entry counts
- **AND** the record SHALL NOT contain the strings `"alice"`, `"dev"`, or `"bob"`

## REMOVED Requirements

### Requirement: AUTH_ALLOW mode resolution

**Reason**: The `Auth = { mode: "disabled" | "open" | "restricted" }` discriminated union is removed in favor of a provider registry. Three modes collapse into a single concept ("which providers are registered, with which entries"). The `__DISABLE_AUTH__` sentinel is removed; "open mode" no longer exists.

**Migration**: Any operator value `AUTH_ALLOW=__DISABLE_AUTH__` SHALL be replaced with one or more `local:<name>` entries plus `LOCAL_DEPLOYMENT=1`. Empty/unset `AUTH_ALLOW` continues to mean "nothing can authenticate" (formerly `mode: "disabled"`); the new behavior is identical except `/login` renders an empty card instead of returning 401 directly.

### Requirement: Allow predicate

**Reason**: The central `allow(user)` predicate is removed. Allowance is now a property each provider asserts internally — github checks its users/orgs allowlist inside `resolveApiIdentity` and `refreshSession`; local checks the entry list inside `resolveApiIdentity`. There is no shared predicate exposed at the auth-capability boundary.

**Migration**: Code that called `allow(user)` directly is removed. Callers either dispatch through a provider's `resolveApiIdentity` or `refreshSession`, or run their own scope-specific check (e.g., the tenant-membership predicate `isMember(user, tenant)`, which remains).
