## Context

`POST /api/workflows` uploads a tar.gz bundle that is extracted and registered as executable workflow code. It is the only `/api` endpoint today. The runtime has a GitHub-token auth middleware (`packages/runtime/src/api/auth.ts`) that validates `Authorization: Bearer <PAT>` against `api.github.com/user` and compares the returned `login` to a single `githubUser` config value. The middleware is only installed when `config.githubUser` is truthy.

Three independent oversights combined to disable auth in production:

1. `config.ts` declares `GITHUB_USER: z.string().optional()` — missing env is legal.
2. `api/index.ts` installs the middleware conditionally: `if (options.githubUser) { app.use(...) }`. Unset config silently turns auth off.
3. `infrastructure/modules/workflow-engine/modules/app/app.tf` injects only S3 credentials via `env_from`; no `GITHUB_USER` is set on the pod.
4. The Traefik `/api` route's comment says "App-auth (app validates tokens)" but there is no oauth2-forward-auth middleware either.

The fix must:
- Inject the allow-list into the pod.
- Make "unset" mean "block everyone" rather than "allow everyone."
- Keep local development ergonomic (no PAT round-trip needed).
- Not break the CLI/programmatic upload flow (oauth2-proxy session cookies are not a fit).
- Avoid leaking the allow-list via HTTP status codes.

Both oauth2-proxy (`OAUTH2_PROXY_GITHUB_USERS`) and the app's allow-list represent "users allowed to access the workflow engine." Infrastructure keeps a single tfvar (`oauth2_github_users`) feeding both.

## Goals / Non-Goals

**Goals:**

- `/api` is fail-closed: if the admin forgets to configure the allow-list, every request is rejected with 401.
- Support a multi-user allow-list (parity with oauth2-proxy).
- Provide an explicit, loud sentinel (`__DISABLE_AUTH__`) for local development so the insecure configuration is auditable in logs and config dumps.
- Remove information disclosure via status codes: attacker with a valid GitHub PAT cannot tell whether their user is on the allow-list.
- Keep the Traefik routing unchanged; the app remains the single place that validates API tokens.

**Non-Goals:**

- Introducing oauth2-proxy forward-auth on `/api` (incompatible with Bearer-token programmatic clients).
- Supporting GitHub orgs/teams (only explicit usernames).
- Changing the UI auth path (`/dashboard`, `/trigger`, etc.) — oauth2-proxy already guards those.
- Rotating or caching GitHub API calls (each `/api` request still does one `GET /user`).

## Decisions

### D1. Fail-closed: unset `GITHUB_USER` means "reject all," not "allow all"

The middleware is always installed on `/api/*`. When no allow-list is configured, it responds 401 to every request. Forgetting the env var moves the system to the safest possible state rather than the most permissive.

**Alternative rejected:** make `GITHUB_USER` required (fail at startup). Decision per interview: do not block startup, but allow nobody at runtime. Keeps health probes answering and keeps the pod observable even when misconfigured.

### D2. Discriminated union in config, not a nullable string

`config.githubAuth` has shape:

```ts
type GitHubAuth =
  | { mode: 'disabled' }                       // unset → reject-all
  | { mode: 'open' }                           // __DISABLE_AUTH__ sentinel
  | { mode: 'restricted'; users: string[] }    // real allow-list
```

Type system forces `apiMiddleware` to handle all three cases. Adding a future mode (e.g., org-based) is a single case addition.

**Alternative rejected:** `githubUsers: string[] | undefined` plus `authDisabled: boolean`. Allows invalid combinations (`authDisabled: true` + non-empty list) and the branching is less type-safe.

### D3. Sentinel value: `__DISABLE_AUTH__`

GitHub usernames allow only alphanumerics and hyphens, so any value containing `_` is unambiguous. `__DISABLE_AUTH__` is:

- Self-documenting in `runtimeLogger.info('initialize', { config })` output.
- Shouty enough that it looks wrong if it ever lands in a production secret.
- Not something a user would pick as a real username.

**Alternatives rejected:**

- `*` — terse but ambiguous with glob patterns.
- `anonymous` — looks like a plausible username to a reader.
- No sentinel (require PAT in dev) — rejected per interview; dev must remain cheap.

### D4. Sentinel must be the whole value

`GITHUB_USER=alice,__DISABLE_AUTH__` fails config parsing with a clear error (Zod `.refine()` before the transform). Prevents a scenario where an operator adds the sentinel during a debugging session and forgets to remove it before restoring real users; in such a case the list is non-empty but the sentinel silently wins.

**Alternative rejected:** treat the sentinel as a literal username if mixed. Silently breaks the principle of least surprise.

### D5. Parse as pflag-`StringSlice`: split on `,`, no trim, keep empties

Matches oauth2-proxy's behavior exactly. Operators who already configure `OAUTH2_PROXY_GITHUB_USERS` get the same parsing rules for `GITHUB_USER`. Whitespace in the env var becomes part of the username and will simply fail to match any GitHub login — the misconfiguration surfaces as a 401, not as a silent allow.

**Alternative rejected:** trim whitespace and drop empties. Friendlier but introduces a divergence from oauth2-proxy; diagnosing a cross-tool mismatch is worse than the "spaces don't match" symptom.

### D6. One status code for every negative path: 401

All four failure modes — missing header, malformed token, GitHub rejection, login not on allow-list, **and** `mode: 'disabled'` — return `401 Unauthorized` with body `{ error: "Unauthorized" }`.

This is a deliberate divergence from strict HTTP semantics (which would pick 403 for "authenticated but forbidden"). Rationale: **anyone can mint a GitHub PAT for themselves**. A 403 would confirm "your PAT is valid, just not on the allow-list" and lets an attacker enumerate allow-listed users by cycling their own PATs. With a flat 401 the attacker cannot distinguish "bad token" from "wrong user." The cost — slightly harder operator debugging — is acceptable for a single-user service.

### D7. Traefik `/api` route stays app-only

oauth2-proxy forward-auth expects a browser session cookie from its own sign-in flow. Programmatic clients (CLI, CI) present a Bearer PAT and have no way to obtain that cookie. Putting `/api` behind forward-auth would break the upload flow. The app-layer check is the single point of enforcement; defense-in-depth at the Traefik layer is not feasible without changing the client model.

**Revisit if:** the API ever needs to accept browser-originated requests from the same origin as the UI.

### D8. Sentinel is interpreted in `config.ts`, not in the middleware

The middleware stays a plain "does this login match this list" primitive. Mode selection happens once, at config parse time, and is baked into the discriminated union. The middleware no longer has a reason to know about sentinels.

### D9. One-shot startup WARN for insecure modes

`main.ts` calls `runtimeLogger.warn("api-auth.disabled")` or `runtimeLogger.warn("api-auth.open")` once during initialization. Per-request logging rejected: high volume, low signal — startup is when an operator notices.

### D10. Infra wiring: app module gets a `github_users` string, threaded from `var.oauth2.github_users`

The app module stays ignorant of oauth2-proxy's config struct (which carries secrets). `workflow-engine.tf` does the plumbing: `module "app" { github_users = var.oauth2.github_users }`. Dev reuses the existing `oauth2_github_users` tfvar with no new keys.

## Risks / Trade-offs

- **Risk:** Operators familiar with the old behavior ("empty GITHUB_USER = dev mode") will be surprised by fail-closed 401s. → **Mitigation:** startup WARN log, README update in the apply tasks, and the `__DISABLE_AUTH__` sentinel gives an explicit dev escape hatch.
- **Risk:** 401 for wrong-user weakens operator debugging — a legitimate user who mistyped their PAT and one who simply isn't on the list get identical responses. → **Mitigation:** accepted trade-off; startup logs show the mode, and the server-side log line at auth rejection can distinguish cases for the operator while the HTTP response does not.
- **Risk:** pflag parity (no whitespace trim) will silently produce wrong allow-lists if templated incorrectly (`"alice, bob"` includes `" bob"`). → **Mitigation:** matches the behavior operators already get for oauth2-proxy; documented in the runtime-config spec.
- **Risk:** Sentinel `__DISABLE_AUTH__` accidentally committed to a prod tfvars file. → **Mitigation:** WARN log is loud; value is obviously non-sensical as a username; `__DISABLE_AUTH__` in a secret file will fail code review more readily than an empty string.
- **Trade-off:** Discriminated-union config shape is a small internal breaking change (tests and `main.ts` need updates). Acceptable cost for safer call sites.

## Migration Plan

Solo deployment; no staged rollout required. Steps:

1. Ship config + middleware + infra changes together in one PR.
2. `pnpm infra:up` rebuilds the image and re-renders the app deployment with the new `GITHUB_USER` env var.
3. First boot logs confirm `mode: 'restricted'` with the expected users.

Rollback: revert the commit; the previous (insecure) behavior returns until the fix is re-applied. No data migrations, no schema changes.

## Open Questions

None — all branches resolved in the interview prior to this proposal.
