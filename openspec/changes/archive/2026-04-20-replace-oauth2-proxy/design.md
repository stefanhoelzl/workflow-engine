## Context

The app today runs behind a dedicated `oauth2-proxy` pod wired into Traefik via a `forwardAuth` Middleware. Unauthenticated requests to `/dashboard/*` and `/trigger/*` bounce through `oauth2-proxy`, which owns the GitHub OAuth dance and a session cookie; on success, it populates `X-Auth-Request-User`, `X-Auth-Request-Email`, and `X-Auth-Request-Groups` headers that the app reads via `headerUserMiddleware`. The `/api/*` path runs an independent Bearer flow (`githubAuthMiddleware` + `bearerUserMiddleware`) that calls `api.github.com` directly.

The split creates parallel auth models that share nothing except the `UserContext` shape: two allowlist env vars (`GITHUB_USER` for the app, `OAUTH2_PROXY_GITHUB_USERS` for the sidecar), two OpenSpec capabilities (`github-auth` + `dashboard-auth`, both already drifted — `dashboard-auth` references Caddy, `oauth2-proxy` references Pulumi), and a third capability (`oauth2-proxy`) that exists only to spec the sidecar. The forward-auth design also requires the `strip-auth-headers` Traefik Middleware as defence-in-depth against forged `X-Auth-Request-*` injection on every non-UI route.

Pulling the OAuth flow into the app process was chosen over the alternatives of (a) customising oauth2-proxy templates only and (b) keeping `/api` separate while rewriting only the UI path, because the real win is unifying the authorization predicate (`AUTH_ALLOW`) across both transports, not the login UX.

## Goals / Non-Goals

**Goals:**
- Retire the `oauth2-proxy` subsystem entirely (pod, Service, Secret, three Traefik Middlewares, `/oauth2/*` IngressRoute, the three stale spec capabilities).
- Unify the allowlist predicate: one env (`AUTH_ALLOW`) and one check function govern both `/api/*` Bearer and `/dashboard`/`/trigger` session requests.
- Cut stale-allowlist exposure from 7 days (cookie TTL) to ~10 minutes (soft-TTL refresh) by re-evaluating `AUTH_ALLOW` on every refresh.
- Eliminate the `X-Auth-Request-*` forging threat class by removing every code path that reads those headers (delete `headerUserMiddleware`), so `strip-auth-headers` becomes unnecessary.
- Accept private-org-scoped `AUTH_ALLOW` entries (`github:org:<private-org>`) by requesting the `read:org` OAuth scope.
- Keep the `/api/*` Bearer path unchanged in shape — still header-only, no cookie — so no new CSRF surface appears on the management API.

**Non-Goals:**
- No new login UX beyond a deny banner; the successful path stays "auto-redirect to GitHub". Branded sign-in pages can land later without re-opening this design.
- No key-rotation story for the cookie-sealing password; the password lives in-memory for the life of the process and regenerates at each pod restart (users re-login). HA-ready key sharing is deferred to the PR that raises `replicas > 1`.
- No JWT issuance to external consumers. The sealed cookies are opaque to anything outside this app.
- No caching of `/api/*` GitHub validation calls (same as today); `bearerUserMiddleware` continues to hit GitHub on every request. Caching is a separate, orthogonal change.
- No multi-provider support beyond GitHub. The `AUTH_ALLOW` grammar reserves the `<provider>` slot so adding Google/GitLab later is additive rather than disruptive, but v1 only accepts `github:`.

## Decisions

### Session cookie sealing: `iron-webcrypto`, single in-memory 32-byte password

Chose `iron-webcrypto` over `jose` (JWE) after direct comparison. `iron-webcrypto` provides a `seal`/`unseal` primitive with native TTL validation, matching all three cookies (session, state, flash) exactly. `jose` would require bolting TTL onto JWE payloads manually and adds API surface we do not use. `iron-webcrypto` is framework-agnostic (the `iron-session` wrapper assumes Next.js request/response shapes we don't have).

The password is 32 random bytes generated via `crypto.getRandomValues` at process start, held in a module-level closure, and never written to disk, K8s Secret, or logs. Rationale: avoiding a persisted secret removes one piece of ops state (the oauth2-proxy cookie Secret goes away with no replacement), at the cost of invalidating all sessions on every pod restart. Given `replicas=1` and deploy cadence on the order of weekly, the UX cost is one-click per user per deploy. The single password is shared across all three cookies because they all live in the same trust boundary and have similar lifetimes; domain separation would add complexity without threat-model benefit.

**Alternative considered:** K8s Secret with a random 32-byte value and `ignore_changes` on the Tofu resource — survives restarts, sessions persist across deploys. Rejected for this PR to keep the scope minimal; listed as the intended migration when `replicas > 1` becomes a goal.

### Allowlist grammar: `AUTH_ALLOW=<provider>:<kind>:<id>;…`

Chose a provider-prefixed grammar (`github:user:stefanhoelzl;github:org:acme`) over separate env vars (`GITHUB_USERS` + `GITHUB_ORGS`) or bare tokens disambiguated by an `@` prefix. Rationale: the prefix is self-documenting, extends cleanly to future providers, fails fast on unknown provider prefixes at config-load time, and makes `grep`ing deployment env output trivial. Semicolon separator avoids collision with commas that commonly appear in other env values.

The predicate is identical for both transports:
```
allow(user) = users.has(user.login) OR orgs ∩ user.orgs ≠ ∅
```
Same function, same input shape, called from both `bearerUserMiddleware` (on `/api/*`) and `sessionMw` (on `/dashboard`, `/trigger`). Teams are not part of the predicate; `UserContext.teams` is removed entirely.

Modes: unset → `disabled` (401 everywhere), sentinel `__DISABLE_AUTH__` → `open` (fake user, warn-logged at startup), parseable → `restricted`. Matches today's `GITHUB_USER` mode resolver exactly — behaviour is the same, only the grammar is richer and the scope is broader (now also governs `/dashboard`, not just `/api`).

**Alternative considered:** bare user tokens + `@org` prefix for orgs. Rejected because `@` has an overloaded meaning on GitHub (mention marker) and single-character typos become silent footguns.

### OAuth scope: `user:email read:org`

`user:email` is required for login + email; `read:org` is required so that members of *private* GitHub orgs match `github:org:<org>` entries. Today's implicit default (`user:email` only) silently excludes private-org members — a latent footgun nobody has hit yet only because the configured orgs are all public. Forward-fix the scope as part of this change; the one-time consent-screen re-prompt at first post-deploy login is acceptable friction.

We considered requesting only the scopes strictly needed at the moment of each call, but GitHub OAuth does not support incremental consent — the scope set is fixed at authorize time. Conservative choice: ask once for everything the session might need across its TTL.

### Soft-TTL refresh with fail-closed semantics

Hard TTL 7 days, soft TTL 10 minutes. Past soft TTL, `sessionMw` re-fetches `GET /user` and `GET /user/orgs` using the session's stored `accessToken`, re-evaluates `AUTH_ALLOW` against the fresh data, and re-seals the cookie with an updated `resolvedAt`. Any non-OK response from GitHub (401, 403, 5xx, timeout) or a now-failing `AUTH_ALLOW` clears the session cookie and 302s to `/login` — no grace period, no serving stale data during GitHub outages.

Rationale: the refresh path is where A10 (stale allowlist) becomes A10′ (≤10min exposure) — but only if the refresh re-evaluates `AUTH_ALLOW`. Making that re-evaluation an explicit spec requirement (rather than a happy accident of the code) prevents a subtle regression where an implementer remembers to re-fetch orgs but forgets to re-check the allowlist.

Fail-closed on GitHub 5xx is a deliberate tradeoff against availability: during a GitHub outage, the dashboard becomes unreachable. Equivalent behaviour already exists on `/api/*` today (no caching, every request hits GitHub), so the outage coupling is consistent across transports. `/api/*` users accept this; the UI now inherits the same contract.

### Callback path: `/auth/github/callback` (fresh)

Chose a fresh callback path over reusing `/oauth2/callback` because (a) it lives under an app-owned `/auth/*` namespace that matches the code structure, and (b) it avoids a one-shot "old path coexists briefly" dance during cutover; GitHub OAuth Apps accept a list of authorized callback URLs, so adding the new one without removing the old is how we achieve zero-downtime switch regardless of path choice. The manual step is the same either way: update the GitHub OAuth App once.

### Login UX: auto-redirect with flash-driven deny banner

`GET /login` is provider-agnostic and stable: it ALWAYS renders a sign-in page and NEVER auto-redirects. The "Sign in with GitHub" button links to `GET /auth/github/signin`, which is the GitHub-specific entry point that actually starts the OAuth dance. Splitting page-render from flow-start means a refresh (or a sessionMw bounce with no flash) lands on a stable page instead of silently re-authenticating through the still-valid GitHub session.

The page has two states:
- No `auth_flash` cookie: 302 to `https://github.com/login/oauth/authorize` with a sealed `auth_state` cookie carrying `{state, returnTo}`.
- `auth_flash` cookie present: render an HTML page with a red banner ("Signed in as @foo — not authorized") and two actions: `[Try again]` (re-enters the flow) and `[Sign out of GitHub]` (off-site link to `github.com/logout`).

Denial always routes through the flash pattern: the `/auth/github/callback` handler and the `sessionMw` refresh path both `Set-Cookie: auth_flash=<sealed>; Max-Age=60; Path=/` and 302 to `/login`. The login handler consumes + clears the flash on render. No separate `/auth/denied` route.

Deny-page HTML is CSP-compliant (no inline script/style, external links use `rel="noopener noreferrer" target="_blank"`) and renders via the same layout wrapper as the dashboard.

### `/api/*` stays Bearer-only

Session cookies are never accepted on `/api/*`. Rationale: adding cookie auth to `/api/*` would open a CSRF surface on every mutating endpoint, and the dashboard UI does not call `/api/*` from the browser (all HTMX requests stay inside `/dashboard/*`). The "unification" the proposal promises happens at the `allow()` predicate level, not at the transport level. This keeps the `/api/*` threat model identical to today.

`bearerUserMiddleware` gains one behavioural change: its allowlist check now goes through the shared `allow()` predicate instead of the exact-login check, so org members match. This is a silent relaxation for callers whose login was not on the old allowlist but whose org is on the new one — desirable and consistent with the unified model.

### Single-replica invariant for auth

The in-memory password makes `replicas=1` load-bearing for the auth subsystem: a request hitting pod B with a cookie signed by pod A fails decryption and bounces to login on every alternating request. Today's Deployment already runs one replica for other reasons; this change formalises it as an auth invariant in `SECURITY.md §5` so the HA-enablement PR (if it ever happens) is forced to address the key strategy in the same work.

### Capability layout: collapse to one `auth` capability

Merged `github-auth` + `dashboard-auth` + `oauth2-proxy` into a single new `auth` capability. The three existing capabilities all describe parts of one logical concern (how users authenticate), and two of them (`dashboard-auth`, `oauth2-proxy`) were already stale. Collapsing them pays off the staleness debt and matches the unified model in code. `auth` is named provider-agnostically so adding a second IdP later does not force another rename.

## Risks / Trade-offs

- **Pod restarts force re-login** → Accepted. Single-click re-auth through GitHub SSO. Deploy cadence is weekly, which is the dominant restart cause. Documented in SECURITY.md §5 as the invariant that unlocks HA when someone wants to flip `replicas > 1`.

- **Dashboard fails closed during GitHub outages** → Accepted. `/api/*` already behaves this way; the UI now matches. Alternative (grace window during 5xx) adds code and a monitoring obligation with no strong use case.

- **One-time consent re-prompt on first post-deploy login** → Accepted. Required by the scope bump (`user:email` → `user:email read:org`). Needed to make private-org `AUTH_ALLOW` entries work at all.

- **`openspec validate` behaviour on "remove whole capability"** → Small de-risk: the three REMOVED capability deltas are the largest capability removals in this repo's history. Run `openspec validate` early after drafting the specs to confirm the tool handles it as expected. If it does not, fall back to per-requirement REMOVED deltas with the entire spec enumerated.

- **`AUTH_ALLOW` grammar strictness vs. operator ergonomics** → We fail-fast on unknown `<provider>` prefixes at startup. This will reject a typo like `guthub:user:foo` with a clear error rather than silently ignoring the entry and locking the admin out. Tradeoff: config reload requires a fresh Tofu apply, not just an env tweak. Acceptable because the allowlist does not change often.

- **Access token in encrypted cookie at rest in the browser** → Accepted. `HttpOnly` prevents JavaScript access; an attacker with filesystem access to the browser profile can exfiltrate the cookie, but the only scope granted (`user:email read:org`) yields read access to public-ish user metadata and org memberships — no repo, no write. Same shape as oauth2-proxy's today.

- **Every `/api/*` request still hits GitHub** → Unchanged from today. Out of scope for this change; a caching layer is a separate spec.

## Migration Plan

Cutover is a single-PR flag day; rollback is `git revert` + `tofu apply`. The manual coordination step is the GitHub OAuth App callback URL, which supports a list so the old and new URLs can coexist during the window.

**Pre-merge (operator, ~5 min):**
1. In the prod GitHub OAuth App settings, **add** `https://workflow-engine.webredirect.org/auth/github/callback` to the authorized callback URLs list. Do not remove the old `.../oauth2/callback` entry yet.
2. Each developer: in their local dev GitHub OAuth App, **add** `https://localhost:8443/auth/github/callback` to the same list.

**Merge + deploy:**
3. Merge PR. Tofu apply in prod:
   - oauth2-proxy pod terminates, Deployment/Service/Secret removed.
   - App pod rolls with new env vars (`AUTH_ALLOW`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`); routes-chart redeploys without forward-auth / strip-auth-headers / errors-oauth2 middlewares and without the `/oauth2/*` IngressRoute.
   - ~60–120s of 5xx during the roll; acceptable for this class of change.
4. Existing oauth2-proxy session cookies become unreadable (app cannot decrypt). Users hit `/dashboard` → 302 `/login?returnTo=/dashboard` → see the sign-in page → click "Sign in with GitHub" → 302 `/auth/github/signin` → 302 GitHub → consent prompt (new scopes) → `/auth/github/callback` → `/dashboard`. One explicit click per user.

**Post-verify (operator, ~1 min):**
5. After confirming the new flow works end-to-end in prod, **remove** `https://workflow-engine.webredirect.org/oauth2/callback` from the GitHub OAuth App authorized callback URLs.

**Rollback:**
- `git revert` the PR, `tofu apply`. The reverse flow: new cookies become unreadable by the restored oauth2-proxy, users bounce through the old login. Requires the old callback URL to still be in the GitHub OAuth App list, which is why step 5 happens only after verification.

## Open Questions

- **Does `packages/runtime/src/config.ts` already expose a `BASE_URL` / `publicBaseUrl` field usable for constructing `redirect_uri` and `Location` headers?** If not, add one as part of this change (likely already present — there is a `BASE_URL` requirement in `runtime-config/spec.md` line 151). Verify during implementation.

- **Local dev GitHub OAuth App: per-dev or shared?** Simplest path: each developer creates their own OAuth App, stores `client_id`/`client_secret` in their untracked `local.secrets.auto.tfvars`, and registers `https://localhost:8443/auth/github/callback` as the callback. Documented in `CLAUDE.md` and in `local.secrets.auto.tfvars.example`. A shared "workflow-engine-local" app whose authorized-callback list includes every dev's localhost URL would also work but centralises credential access that currently has no central owner. Defer the shared-app route unless multiple devs ask for it.

- **How does `/trigger` handle unauthenticated access today if the user has never logged in?** Same path as `/dashboard` — forward-auth at Traefik, bounce to login. After this change, same path — `sessionMw` mounted on `/trigger/*`, same 302 to `/login?returnTo=/trigger`. Verify no test asserts Traefik-level auth on `/trigger` that would regress silently.

- **`openspec validate` acceptance of three whole-capability removals in one change.** Low-risk but untested in this repo. Run against the drafted change early.
