## Context

`sessionMiddleware` (packages/runtime/src/auth/session-mw.ts) protects authenticated UI routes. When the unsealed session payload is past the 10-minute staleness threshold but still within its 7-day `exp`, it calls `provider.refreshSession(payload)`. Under the existing `Promise<UserContext | undefined>` contract, `undefined` is overloaded — it covers token revocation, upstream 5xx, network errors, and genuine allowlist rejection. The middleware unconditionally sets `auth_flash = { kind: 'denied', login }` and redirects to `/login`, which renders the "Not authorized — contact administrator" banner from `packages/runtime/src/ui/auth/login-page.tsx`.

A user reported that after being auto-logged-out in the background and revisiting the site, they see the deny banner even though clicking "Sign in with GitHub" works on the very next click. The misleading message is the symptom; the conflated return type is the root cause.

Adjacent state at process boundaries: the sealing key regenerates on every process start (spec.md:494-502), and the runtime is single-replica per env (spec.md:953). Every deploy therefore invalidates all sealed cookies. Today this manifests as a silent redirect to `/login`; under this change it will manifest as a "Signed out" banner, since the unsealable cookie now goes down the flash-on-clear path.

## Goals / Non-Goals

**Goals:**
- Distinguish "session can no longer be confirmed" from "user is actively excluded" at the provider boundary.
- Make `sessionMiddleware`'s flash kind a deterministic function of the cause it observes.
- Eliminate the "first-time visitor sees a banner" failure mode — set flash only when a cookie is being cleared.
- Capture the new taxonomy in the auth spec so future providers must honor it.

**Non-Goals:**
- Changing the OAuth callback's 400/502 paths or the fresh-login allowlist-rejection UX.
- Changing the session payload shape, cookie names, TTLs, sealing scheme, or flash kinds on the wire.
- Distinguishing transient upstream failures (GitHub 5xx, timeout) from permanent token revocation — both collapse to `session-expired`. Adding a third "try again later" branch is out of scope; users can act on `session-expired` (re-sign-in) but cannot meaningfully act on "GitHub is having an outage."
- Threading the OAuth callback's success+failure dispatch through `RefreshResult`. The callback mints a fresh session with a brand-new access token; the refresh path re-seals an existing one with the same access token. The two `ok` cases are not interchangeable.

## Decisions

### Decision: `RefreshResult` shape and reason vocabulary

```ts
type RefreshResult =
  | { ok: true; user: UserContext }
  | { ok: false; reason: 'session-expired' | 'access-denied' };
```

- `session-expired` covers any path where the provider can no longer confirm the user's identity: upstream rejected the token, upstream returned 5xx, network/transport failure, malformed upstream response. The user's recovery is the same in every sub-case (sign in again), so a single reason carries enough information.
- `access-denied` is reserved for the case where the provider successfully resolved the user but the allowlist excludes them.

**Alternatives considered:**
- `'token-invalid' | 'not-allowed'` — accurate for github but leaks GitHub-specific framing into the contract; "token" is meaningless for the local provider.
- `'unauthenticated' | 'forbidden'` — HTTP-flavored and provider-neutral, but "unauthenticated" is verbose and slightly inaccurate (we *do* have a claimed identity from the session payload; we just can't re-verify it).
- `'invalid' | 'denied'` — short and pairs with the existing `denied` flash kind, but "invalid" is vague and gives no hint at the user-facing intent.

`'session-expired' | 'access-denied'` mirrors the user-facing outcome — readers of provider code immediately see why the choice matters. The 1:1 mapping to flash kinds also makes `sessionMiddleware` trivial to audit.

### Decision: `sessionMiddleware` sets the flash on every clear-and-redirect path, never on a missing-cookie path

| Transition | Cookie present? | Action | Flash |
| --- | --- | --- | --- |
| A. No `session` cookie | no | redirect to `/login` | none |
| B. `unsealSession` throws | yes (corrupt) | clear, redirect | `logged-out` |
| C. Unknown `provider` in payload | yes | clear, redirect | `logged-out` |
| D. `isExpired(payload)` | yes | clear, redirect | `logged-out` |
| E. `refreshSession` → `session-expired` | yes (stale) | clear, redirect | `logged-out` |
| E'. `refreshSession` → `access-denied` | yes (stale) | clear, redirect | `denied` |
| F. `refreshSession` → `ok` | yes (stale) | reseal, continue | (none — no redirect) |

Rule of thumb: **flash iff we just cleared a cookie that was present.** A first-time visitor (A) is never lied to with "Signed out." A user whose cookie went bad in any way (B/C/D/E) sees the same accurate "Signed out" message — they were signed in, now they're not. Only the genuine allowlist case (E') keeps the strong "Not authorized" banner.

**Alternative considered:** also flash on path A, on the theory that everyone arriving at `/login` via redirect deserves a banner. Rejected because a first-time visitor following a deep link would be told they were "Signed out" of an account they never had.

### Decision: extract `redirectToLoginWithFlash` helper

```ts
async function redirectToLoginWithFlash(
  c: Context,
  flash: FlashPayload,
  secureCookies: boolean,
): Promise<Response>;
```

Body: seal the flash, set `auth_flash`, delete `session`, redirect to `LOGIN_PATH`. Lives in a new module `packages/runtime/src/auth/redirect-to-login.ts`. Replaces:
- The inline `sealFlash + setCookie + deleteCookie + redirect` block at `github.tsx:191-204` (OAuth callback allowlist-rejection branch).
- Every clear-and-redirect path in `sessionMiddleware` (rows B/C/D/E/E' above).

**Alternatives considered:**
- Two purpose-named helpers (`redirectAccessDenied`, `redirectSessionExpired`): the invariant ("clear session + redirect to /login with a flash") would be duplicated across both bodies; adding a third flash kind would require a third helper.
- A method on the flash-cookie module (`flashCookie.setAndRedirect`): couples the flash module to session-cookie deletion and route knowledge it should not own.
- Threading the OAuth callback's full state machine through a shared dispatcher: the callback has 400/502 surfaces and a fresh-session-mint success case that don't fit into `RefreshResult`. Forcing them through one path means either a hybrid union or an awkward "ok with optional accessToken" field.

A single helper parameterized by `FlashPayload` is the smallest abstraction that owns the invariant. The varying piece (kind, login if any) is the parameter; the constant (the cookie pair and target route) is the body.

### Decision: local provider re-checks `AUTH_ALLOW` on refresh

Today `localProvider.refreshSession` returns the payload's identity unconditionally — a local user removed from `AUTH_ALLOW` stays logged in until their session expires. Under the new contract, `refreshSession` returns `{ ok: false, reason: 'access-denied' }` if `byName.has(payload.login)` is false, and `{ ok: true, user }` otherwise. No external call; the catalog lookup is in-memory.

This is symmetric with github's behavior and removes a quiet "phantom session" hazard from the local provider. The existing spec scenario "refreshSession returns immediately without external call" still holds — re-checking an in-memory `Map` is not an external call.

### Decision: behavior changes to existing scenarios are intentional and called out

Two scenarios in `openspec/specs/auth/spec.md` change their asserted outcome:

| Scenario | Before | After |
| --- | --- | --- |
| "Stale github session with GitHub 5xx fails closed" | `denied` flash | `logged-out` flash |
| "Expired session redirects to login" | no flash | `logged-out` flash |

Both are correct under the new rule — the 5xx case is a `session-expired` failure (we couldn't confirm the user), and the expiry path is now uniformly handled with all other clear-and-redirect transitions.

The spec delta includes both updated scenarios so the breaking-test-assertion change is reviewable in spec form before any code lands.

## Risks / Trade-offs

- **[Risk]** Out-of-tree `AuthProvider` implementations break at the type boundary.
  **Mitigation:** TypeScript build fails loudly with a clear error. The proposal lists this as a breaking change. No known third-party providers exist today.

- **[Risk]** Users notice that every deploy now shows them "Signed out." (because the sealing key regenerates on process start), where previously they were silently bounced to `/login`.
  **Mitigation:** Accepted as accurate UX, not a regression. The banner correctly describes their state ("you were signed in, now you're not"). Documented under the deploy-side-effect note in the proposal.

- **[Risk]** A transient GitHub outage now logs every active user out at the next stale refresh, instead of leaving the deny banner shown.
  **Mitigation:** Today the behavior is also "lose the session and see a misleading banner" — the new behavior loses the session and shows an accurate banner. Net improvement. A "keep stale session through transient errors" policy was considered and rejected as out of scope; it would require a separate spec change with explicit grace-window semantics.

- **[Risk]** The local provider's refresh re-validating the catalog might surprise integrators who used local-deployment as a "set once at boot, never recheck" mode.
  **Mitigation:** The current behavior is a latent bug (entries removed from `AUTH_ALLOW` should not persist as live sessions). Spec scenario is added to make the new behavior explicit. Local provider is gated behind `LOCAL_DEPLOYMENT=1` and not used in production.

- **[Trade-off]** Single `RefreshResult` type vs. a richer error union (e.g. distinguishing 5xx from 401 from network error). Picked the simpler union because the user-facing recovery is identical across all `session-expired` sub-cases; richer information has no consumer.
