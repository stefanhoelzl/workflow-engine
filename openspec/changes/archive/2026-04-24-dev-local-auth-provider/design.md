## Context

The runtime's auth surface today is a discriminated union `Auth = { mode: "disabled" | "open" | "restricted", … }` with three branches reproduced in five places: `parseAuth`, `sessionMw`, `bearerUserMiddleware`, `tenantMw` (via `authOpen` flag), and the `/api/*` middleware switch. The `__DISABLE_AUTH__` sentinel collapses to `mode: "open"`, which:

- Sets `c.set("authOpen", true)` and **no `user`** on the request.
- Bypasses tenant-membership checks in `tenantMw`.
- Skips Bearer-token resolution on `/api/*`.
- Causes the dashboard to render an empty user/email and fall back to listing all registry tenants (because `c.get("user")` is undefined).

In dev this is convenient ("just give me access to everything") but defeats every test of the actual session/login/logout/tenant-isolation paths and makes multi-user demos impossible without a registered GitHub OAuth App.

The interview (see proposal) landed on three orthogonal moves:
1. Replace the sentinel with a real "local" provider that participates in the login flow with a dropdown form.
2. Refactor the auth surface around an `AuthProvider` registry so adding any future provider (OIDC, SAML, ...) doesn't grow more `if/else` branches.
3. Hard-gate the local provider behind `LOCAL_DEPLOYMENT=1` to make accidental prod enablement physically impossible.

The codebase already has precedent for the "registry + per-instance plugin owns its own request inspection" pattern in `TriggerSource` (see `generalize-trigger-backends` in CLAUDE.md upgrade-notes). This change applies the same pattern to auth.

## Goals / Non-Goals

**Goals:**
- Replace `__DISABLE_AUTH__` with a local provider that exercises the real session machinery (sealed cookie, login form, logout flush) so dev workflows are higher-fidelity to prod.
- Allow seeding multiple local users with distinct orgs in `AUTH_ALLOW`, so tenant-isolation behavior can be demoed and tested locally.
- Collapse the `disabled | open | restricted` mode union into a single concept ("which providers are registered, with which entries"); remove `authOpen` and every code path that branches on it.
- Make the `/api/*` Bearer-token mechanism extensible to non-GitHub schemes via an explicit `X-Auth-Provider` header, with each provider owning its own `Authorization` parsing.
- Keep prod blast radius zero: prod's `AUTH_ALLOW` does not change shape; production never registers the local provider; one-time forced re-login on deploy.

**Non-Goals:**
- Adding any third provider (OIDC, SAML, header-trust, ...). The new abstraction makes it possible; this change does not exercise it.
- Per-provider logout copy. Generic "Signed out" banner stays.
- Remembering "last-used provider" in browser storage. Login UI is server-rendered HTML with no JS.
- A separate UI for managing local users at runtime. The list is read once at boot from `AUTH_ALLOW`; changes require a restart.
- Changing the `UserContext` shape. `name`/`mail`/`orgs` is unchanged. Local provider populates `mail` as `<name>@dev.local` deterministically.
- Touching the sandbox boundary. This change is purely runtime + UI + CLI; no SECURITY.md §2 (sandbox-discipline) rules change.

## Decisions

### Decision 1: Provider registry over conditional branches

**Choice**: Introduce two interfaces.

```ts
interface AuthProvider {
  readonly id: string;                                              // "github" | "local"
  renderLoginSection(returnTo: string): HtmlEscapedString;
  mountAuthRoutes(subApp: Hono): void;                              // mounted under /auth/<id>/
  resolveApiIdentity(req: Request): Promise<UserContext | undefined>;
  refreshSession(payload: SessionPayload): Promise<UserContext | undefined>;
}

interface AuthProviderFactory {
  readonly id: string;
  create(rawEntries: readonly string[],                             // unparsed "rest" strings
         deps: ProviderRouteDeps): AuthProvider;
}
```

A registry holds `Map<id, AuthProvider>`. Boot collects raw `rest` strings per id from `AUTH_ALLOW`, then asks each factory to `create()` an instance with its bucketed entries. The instance closes over its parsed entries; per-request methods take no `entries` argument.

**Why this shape**:
- **Each provider owns parsing past the first colon.** The registry only knows how to split on first `:`. Local can use `|` for orgs without affecting GitHub; future providers (`oidc:https://...`) can use whatever they want.
- **Each provider owns its own request inspection.** No central `Authorization` parser. Mirrors `TriggerSource` (each backend owns its own ingress).
- **Two-stage init.** Factory parses + buckets at boot; instance binds entries via closure. Per-request methods are parameter-pure. Mirrors how sandbox plugins are loaded.
- **Single public surface per module.** Each `providers/<id>.ts` exports one symbol — its `AuthProviderFactory`. Parsing helpers, internal entry shapes, and lookup maps are module-private. Tests import only the factory.

**Alternatives considered**:
- **Inline `if (entry.provider === "local")` everywhere** (touch parseAuth, login-page, bearer mw, session mw with conditionals): smallest diff, but the second provider was the moment the cost of branching crossed the cost of an interface (6 of 6 divergence points between GitHub and Local). Rejected.
- **`apiAuthScheme: string` on the provider** (so the dispatcher parses `Authorization` once and routes by scheme word): cleaner today, but breaks if a future provider uses a custom header (`X-Cloudflare-Access-Jwt`). Rejected in favor of "provider reads the request itself."
- **`allows(user, entries)` method on the provider** (called by `sessionMw` to re-check membership): every place I imagined needing it was either internal to the provider or already subsumed by `resolveApiIdentity` returning `undefined`. Removed.
- **`renderLoginSection` returns `HtmlEscapedString | null`** (so a registered provider with zero entries can be silent): a registered provider always has ≥ 1 entry by construction (the dispatcher only calls `factory.create()` for ids that bucketed at least one entry). Tightened to non-nullable.
- **Public `parseEntry` method on the factory**: leaks parsing as a separate test-able surface; encourages tests against internal grammar instead of observable behavior. Rejected — parsing collapses into `create()`. Tests exercise grammar through `factory.create()` calls and the resulting provider methods.

### Decision 2: `X-Auth-Provider` header for `/api/*` dispatch

**Choice**: Clients send two headers on `/api/*` requests:

```
X-Auth-Provider: <id>
Authorization: <provider-specific value>
```

The middleware reads `X-Auth-Provider`, looks up the provider in the registry, and hands the **raw `Request`** to `provider.resolveApiIdentity(req)`. Missing or unknown id → 401. Provider returns `undefined` → 401. Provider returns a `UserContext` → request proceeds.

**Why a separate header**:
- Each provider owns its own `Authorization` parsing — the dispatcher never touches it. This keeps the contract tight and lets future providers use non-`Authorization` headers entirely (e.g., `X-Forwarded-User`).
- O(1) dispatch by header lookup vs. linear "ask each provider in turn." Negligible perf difference at 2 providers but cleaner mental model.
- Symmetric with the browser-side login flow, where the provider is selected by form action URL (`/auth/github/signin` vs. `/auth/local/signin`). Both transports name the provider explicitly.

**Why `X-Auth-Provider` specifically**:
- No IANA-registered header conveys "which auth provider/realm to use" client → server. `WWW-Authenticate` carries `realm=` but flows the wrong direction (server → client challenge).
- `X-` prefix is RFC 6648–deprecated for new IETF specs but remains the safest signal in application-specific headers that "this is non-standard, no equivalent exists." Operators recognize it on sight.
- Names like `Authorization-Provider` were considered but invent a more confusable name without standards backing.

**Alternatives considered**:
- **Encode the provider in the `Authorization` scheme word** (`Authorization: User alice` → scheme=User → local): forces the abstraction to leak "scheme word" as a public field on the provider. Rejected (Decision 1).
- **Encode in the token value** (`Authorization: Bearer local:alice`): steganographic; ugly; mixes identity with provider selection.

### Decision 3: Local provider gated by `LOCAL_DEPLOYMENT=1` at registration

**Choice**: Build the factory list conditionally:

```ts
const PROVIDER_FACTORIES: readonly AuthProviderFactory[] = [
  githubProviderFactory,
  ...(process.env.LOCAL_DEPLOYMENT === "1" ? [localProviderFactory] : []),
];
```

In prod, `LOCAL_DEPLOYMENT` is unset → the local factory is never in the registry → `AUTH_ALLOW=local:dev` produces the same `unknown provider "local"` error as a typo (`loca:dev`).

**Why registry-level rather than `createConfig`-level**:
- Symmetric with how typos fail. A separate `createConfig` check that says "you used `local:` but `LOCAL_DEPLOYMENT` isn't set" requires `createConfig` to know the magic id `local`, which violates the registry's "ids are the only coordination point" property.
- Defense in depth: even if a future contributor adds a `local:` entry-test in non-`LOCAL_DEPLOYMENT` mode by hand-instantiating `localProviderFactory`, the factory is still imported and constructible — but the production wire-up never references it.

**Alternatives considered**:
- **Build-time gate** (don't ship LocalProvider in the prod bundle): possible but the diff cost is large for a runtime guarantee that's already strong. Deferred.
- **Throw in `createConfig` when `local:` + not local**: works but couples config to provider ids. Rejected.

### Decision 4: AUTH_ALLOW grammar — top separator stays `,`, local uses `|` for orgs

**Choice**:

```
AUTH_ALLOW = Entry ( "," Entry )*
Entry      = ProviderId ":" ProviderRest
local rest = Name | Name ":" OrgList
OrgList    = Id ( "|" Id )*
```

Examples:
```
AUTH_ALLOW=github:user:alice,github:org:acme
AUTH_ALLOW=local:dev,local:alice:acme|foo,local:bob
```

**Why `|` for orgs**:
- Top-level separator was just changed from `;` to `,` four upgrades ago (`auth-allow-comma-separator`); flipping back to `;` is churn and forces re-setting `AUTH_ALLOW_PROD` / `AUTH_ALLOW_STAGING` GH variables.
- `|` is the conventional alternation glyph in regex/shells, doesn't need quoting in env files, and is contained to local-provider grammar (no other provider sees it).
- Cost vs. `+`: `|` reads slightly nicer (`acme|foo` vs `acme+foo`) and has stronger "list of alternatives" connotation.
- Per-provider parser dispatch (Decision 1) means this choice doesn't touch GitHub or any future provider.

**Mail derivation**:
- Local users always get `mail = <name>@dev.local`. Constant suffix, not configurable.
- The grammar deliberately doesn't carry a mail field. If a future test needs a different mail, the test stubs `UserContext` directly via `withTestUser`.

**Alternatives considered**:
- **Flip top separator back to `;`**: contained the comma-in-orgs problem at the cost of reverting a recent migration and re-setting GH variables. Rejected on optics + ops cost.
- **Two env vars** (`AUTH_ALLOW` for entries + `LOCAL_USERS` for orgs): cleaner separation of "allowed?" vs "what attributes?" but introduces drift risk between two vars and adds a second place to edit when seeding a dev user. Rejected.
- **Paren-quoted orgs** (`local:alice(acme,foo)`): keeps `,` everywhere but invents a new escape rule that every future provider grammar must respect. Rejected.

### Decision 5: `SessionPayload` gains a required `provider` field; old sessions invalidate

**Choice**: Add `provider: "github" | "local"` to `SessionPayload`. Existing sealed sessions (without the field) fail Zod parse on first request after deploy; users get redirected to `/login` and re-authenticate.

**Why required, not optional with default**:
- `refreshSession` dispatch needs to know which provider owns the session unambiguously. An implicit `?? "github"` default works today but accumulates an "is the field present" footgun every time `SessionPayload` is touched.
- One-time forced re-login is acceptable (prod has had similar deploys before, and the session is only 7-day TTL anyway).

**Alternatives considered**:
- **Optional with `?? "github"` default**: avoids the forced re-login but pays the implicit-default tax forever. Rejected.
- **Separate `LocalSessionPayload` type alongside `SessionPayload`**: doubles the cookie-sealing surface. Rejected.

### Decision 6: Test migration — delete open-mode-semantics tests; introduce `withTestUser` helper for the rest

**Choice**: Of the ~32 occurrences of `__DISABLE_AUTH__` / `authOpen` / `mode === "open"` in test files (12 files):
- ~12 are open-mode-semantics tests (e.g., `"passes through with authOpen=true in open mode"`). These **delete** — open mode no longer exists, the test has no equivalent.
- ~10 are cosmetic mentions in test setup (e.g., `mkApp({ authOpen: true })` parameter on a tenant-mw helper). These **drop the mention** as part of removing the `authOpen` field.
- ~5 are "I needed a way to skip auth so I could test the actual handler" tests (e.g., `api/upload.test.ts` testing the upload handler). These **migrate** to a new `withTestUser(app, user)` helper that wraps the app with a stub middleware setting `c.set("user", ...)`.

**Why a test helper, not a third "test" provider**:
- A test-only provider would tempt accidental enablement outside tests (it sits in the same registry mechanism).
- The helper is one small file (`auth/test-helpers.ts`) used by exactly the tests that need it; its presence is obvious.
- Tests should exercise the public interface where possible; this helper is for tests of *non-auth* handlers that need an authenticated baseline.

## Risks / Trade-offs

[Forced re-login on deploy] → Documented in upgrade-notes; same blast radius as any prior session-cookie schema change. 7-day TTL means most users were going to re-auth soon anyway. → No mitigation needed beyond the doc.

[`/api/*` clients must now send two headers] → Breaking for any external script calling `/api/*`. Today the only known callers are `wfe upload` (CLI, fixed in this change) and dev's `runUpload` (also fixed). → Surface in upgrade-notes; the SDK is the canonical client.

[Recent `auth-allow-comma-separator` migration is preserved but local provider couldn't naively use commas] → `|` separator is mildly novel, easy to fat-finger as `,`. → Local provider's parser emits a targeted error: `local entry "alice:acme,foo": orgs use '|' separator (e.g. acme|foo)`.

[Removing `mode === "open"` deletes the only `/api/*` no-Bearer path in dev] → `scripts/dev.ts` already adopts `LOCAL_DEPLOYMENT=1` + `local:dev` + `--user dev` in this same change. Any operator dev script that bypassed `/api/*` auth must adopt the same pattern. → Documented in upgrade-notes.

[Accidental enable of LocalProvider in prod via `LOCAL_DEPLOYMENT=1`] → Prod terraform never sets `LOCAL_DEPLOYMENT`. Even if it did, the prod `AUTH_ALLOW_PROD` GH variable doesn't carry `local:` entries, so the registry would have only `github`. The risk is "operator sets BOTH `LOCAL_DEPLOYMENT=1` AND adds `local:dev` to the prod GH variable" — explicit and visible. → No additional gate; SECURITY.md invariant flags both as never-do-in-prod.

[Local sessions never re-validated against AUTH_ALLOW changes] → If you remove `local:alice` from `AUTH_ALLOW` and restart, alice's existing session unseals fine and `refreshSession` returns success because the session-cookie payload self-describes. Acceptable for dev; would be unacceptable for prod where the GitHub provider does re-resolve. → Local-provider behavior; documented; matches the "static at boot" assumption.

[Provider-id collision with future header providers] → If a future provider uses an HTTP-trust pattern with a custom header instead of `Authorization`, the dispatcher's `X-Auth-Provider` selection still works; the provider just reads its own header. → Designed for; no risk.

## Migration Plan

**Operator steps:**
1. Pull the change; run `pnpm install`.
2. Update any local `AUTH_ALLOW` value containing `__DISABLE_AUTH__` to `local:<name>` (typically `local:dev`); add `LOCAL_DEPLOYMENT=1` to the dev environment.
3. Rebuild + restart: `pnpm local:up:build` (or `pnpm dev`).
4. Live users get redirected to `/login` on first request after restart and re-authenticate.

**Prod / staging:**
- No `AUTH_ALLOW_PROD` / `AUTH_ALLOW_STAGING` change (those are GitHub-only and contain no `local:` entries).
- No `LOCAL_DEPLOYMENT` env var added.
- One-time forced re-login on deploy (as above).

**No state wipe**: `pending/`, `archive/`, storage-state keys, manifests, and tenant tarballs are unaffected. No tenant re-upload required.

**Rollback**: revert the change. SessionPayload schema re-tightens; any sessions minted by the local provider would become unsealable (acceptable — they only existed in dev). `__DISABLE_AUTH__` returns and `LOCAL_DEPLOYMENT=1` becomes a no-op env var.

## Open Questions

*(none — all interview branches resolved)*
