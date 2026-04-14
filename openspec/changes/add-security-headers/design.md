## Context

The runtime serves HTML (`/dashboard`, `/trigger`), JSON APIs (`/api/*`), public webhooks (`/webhooks/*`), static assets (`/static/*`), and a liveness probe (`/livez`). Today none of these responses carry security headers. SECURITY.md §4 covers the authentication layer (GitHub OAuth via oauth2-proxy for UI, bearer token + GitHub user allow-list for API); SECURITY.md §5 covers infrastructure. Neither addresses HTTP response hardening. We want the same defense-in-depth that every modern web app gets for free from `helmet` or `hono/secure-headers` — plus a CSP strict enough that an injection bug cannot load remote scripts, inline handlers, or `eval`'d strings.

The dashboard and trigger UIs were authored under a permissive model: Alpine components declared inline via `x-data="{ ... }"` and multi-statement event handlers (`@mouseenter="let r = ...; tip = JSON.parse(...); ..."`), inline `<style>` blocks, inline `style="..."` attributes, and two inline HTML event handlers (`ontoggle=`, `onclick=`). Standard `alpinejs/dist/cdn.min.js` uses `new Function()` to evaluate these expressions, which requires `script-src 'unsafe-eval'`. Inline handlers and inline styles require `'unsafe-inline'`. Both defeat the defense CSP is meant to provide.

The fix has two halves: refactor the UI so it satisfies a strict CSP, then turn the CSP on. Because a broken UI under strict CSP is silent (no Alpine handler fires, no `<style>` block applies), the safest ordering is refactor first, validate, then headers.

## Goals / Non-Goals

**Goals:**

- Every HTTP response served by the runtime carries baseline defense-in-depth headers (HSTS, XCTO, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP, CSP).
- The CSP baseline is `default-src 'none'`, with explicit same-origin grants only — no `'unsafe-inline'`, no `'unsafe-eval'`, no remote origins.
- Dashboard and trigger UIs function identically to today under the strict CSP.
- Local developers can run `pnpm local:up` against the kind stack without their browsers pinning HSTS on `localhost`.
- A durable spec invariant prevents future inline handlers, inline styles, or `'unsafe-*'` grants from silently sneaking back in.

**Non-Goals:**

- Securing `/oauth2/*` responses served by the oauth2-proxy sidecar. Those responses are same-origin and functionally safe; adding headers there requires Traefik-level config and is out of scope.
- CSP reporting pipeline (`report-to` / `report-uri` + ingestion endpoint). Violations will surface in browser devtools only.
- HSTS preload list submission. Preload is irreversible on the order of months; we stay out of the list for now.
- Changing the authentication model, route protection at Traefik, or any behavior in `/SECURITY.md` §§2–5.
- Any behavior change to action sandbox, event bus, or persistence.

## Decisions

### 1. Place headers at the Hono app layer, not at Traefik

Single middleware in `packages/runtime` wraps every route. Alternative was a Traefik `Headers` Middleware CRD attached to each IngressRoute. We picked app-layer because (a) per-route tuning (future: different headers on `/api` vs `/dashboard`) is trivial in Hono, (b) changes ship with the app, not with infra, (c) unit tests exercise the real behavior, (d) local and prod behavior are identical without duplicating Terraform between `infrastructure/local` and `infrastructure/upcloud`. Accepted gap: `/oauth2/*` served by the sidecar does not get our headers.

### 2. Refactor first, then add headers, in two PRs

PR 1 swaps `@alpinejs/csp`, rewrites Alpine expressions, extracts inline styles, and rewires inline event handlers. No header changes. Ships with no visible behavior change. PR 2 adds the middleware. The alternative was one atomic PR or a report-only rollout with a CSP report endpoint. Two-PR was chosen because:

- Report-only requires new infrastructure (report ingestion + storage) for a transient need.
- Atomic PR mixes pure refactor (large, reviewable by anyone) with header config (tiny, security-sensitive). Splitting isolates review cost.
- Under CSP, a missed inline handler is silent — the refactor PR gives us a window to exercise the UI without the policy masking regressions.

### 3. Strict CSP: `default-src 'none'` + explicit grants, not `'self'` + exceptions

A missing directive falls back to `default-src`. With `'none'` as the fallback, any future addition (new `<audio>`, new worker, new `<object>`) fails closed and forces an explicit spec update. With `'self'` as the fallback, the same addition silently inherits same-origin access — scope creep becomes invisible.

### 4. `@alpinejs/csp` build; Alpine expressions become pre-registered component methods

`@alpinejs/csp` exposes only property access, simple function calls, and magics (`$el`, `$refs`, `$store`) in expressions. Multi-statement bodies, `let`/`const` declarations, arithmetic on method return values, and template literal interpolations in event handlers are rejected.

Pattern: every Alpine island becomes `Alpine.data('<name>', () => ({ state, ...methods }))`, registered in a new module under `packages/runtime/src/ui/`. The HTML then calls methods: `@click="toggle()"`, `@mouseenter="showTip($el)"`. Data the handler needs is passed via `data-*` attributes on the element, read inside the method via `$el.dataset`.

The one subtlety worth a spec rule: Alpine's `:style` binding has two paths. Object form → `el.style.setProperty(key, value)`, unaffected by CSP. String form → `el.setAttribute('style', value)`, blocked by `style-src 'self'`. **All `:style` bindings must use the object form.** Dynamic CSS variables like `` `var(--${tip.color})` `` stay as value strings inside an object: `:style="{ background: ``var(--${tip.color})`` }"`.

### 5. Inline event handlers become `addEventListener` with `data-*` parameters

`trigger/page.ts:42` uses `<details ontoggle="initForm(this)">` and `trigger/page.ts:49` uses `<button onclick="submitEvent(this, '${name}')">`. Under `script-src 'self'` both fire nothing. `trigger-forms.js` grows an `init()` that binds events once on load and reads `data-event-type` from the button instead of taking `name` as an inline argument.

### 6. Inline styles move to external stylesheets

`trigger/page.ts:66–191` (125 lines of `<style>`) and `static/404.html:8–55` (47 lines of `<style>`) become new files served from `/static`. Static `style="..."` attributes (`dashboard/page.ts:104,154,158`) become CSS classes. Dynamic per-element color (`dashboard/list.ts:71–73`) becomes `data-color="yellow"` attributes matched by CSS selectors with CSS variables.

### 7. HSTS gated by `LOCAL_DEPLOYMENT=1`

Environment variable set only by the local Terraform Deployment. When `process.env.LOCAL_DEPLOYMENT === "1"` at startup, the middleware skips the HSTS header. Alternative gates considered:

- `NODE_ENV !== 'production'`: we do not set `NODE_ENV` anywhere today; introducing it just for this couples this change to a broader convention we do not need.
- Host sniffing (`req.host === 'localhost'`): leaks deployment concerns into request-path code and can fail open if a preview env ever has a `localhost`-like host.

`LOCAL_DEPLOYMENT` is semantic ("we are running against local infra") rather than behavioral ("disable this one header"), which leaves room for future local-only branches without adding another flag.

### 8. Uniform headers across every route

Same middleware, same headers, every response. Alternative was a per-route-family policy (stricter CSP on `/dashboard`, skip CSP on `/webhooks`). We chose uniform because:

- A CSP on a JSON response is a no-op; its presence is not harmful.
- Future routes inherit the strict policy by default. Per-route differentiation is premature until a second route family needs it.

### 9. Durable invariants live in the `http-security` capability spec, not scattered across UI specs

The rules — no inline script, no inline style, no `'unsafe-*'`, no weakening `default-src 'none'` — apply to every HTML-rendering surface. Putting them on a cross-cutting capability (matching the pattern of `github-auth`, `oauth2-proxy`, `payload-validation`) keeps them visible to future agents touching UI code. `SECURITY.md` gets a §6 pointing to the spec; `CLAUDE.md` gets one bullet.

## Risks / Trade-offs

- **[Refactor breaks a UI behavior not caught by existing tests]** → Mitigation: PR 1 ships without header changes, so the UI is exercisable with the standard dev workflow (`pnpm local:up:build` + manual smoke). Playwright/integration tests are extended to cover the tooltip, filter dropdown, and trigger form submit flows before PR 1 merges.
- **[`@alpinejs/csp` behaves subtly differently from the standard build]** → Mitigation: constrain Alpine use to the patterns documented in the CSP build's README; avoid magics we don't currently use; pin to the same major as `alpinejs`. If the CSP build blocks a pattern we need (e.g., `$refs.foo.focus()`), we document the alternative in `design.md` rather than reverting to the standard build.
- **[Strict CSP masks a future inline-style regression — developer adds `<style>` block, local runs work (no headers in local HSTS-off?), prod breaks]** → The middleware runs in local too (only HSTS is gated); CSP is enforced identically everywhere. Regressions surface on `pnpm local:up`.
- **[HSTS gate relies on a string env var that could be misconfigured]** → Mitigation: middleware parses `process.env.LOCAL_DEPLOYMENT === "1"` strictly (string comparison, not truthy). Unit test covers both states. Terraform local module sets the literal `"1"`; prod never sets the variable.
- **[`/oauth2/*` pages lack our headers]** → Accepted. Same-origin, no interactive scripting beyond a form post, served by a maintained upstream. If oauth2-proxy ever serves third-party content, revisit with a Traefik `Headers` middleware.
- **[A future contributor adds `'unsafe-inline'` or `'unsafe-eval'` to CSP to unblock a library]** → Mitigation: the `http-security` spec requirement forbids these tokens; spec conformance is checked in review. `CLAUDE.md` invariant flags it for AI agents.
- **[`:style` binding reverts to string form somewhere]** → Mitigation: spec rule "Alpine `:style` bindings MUST use object form." Runtime integration test asserts no inline `style` attribute survives a rendered dashboard page. Optional: a Biome rule or grep-based lint to flag `:style="\`` templates.

## Migration Plan

Two PRs, sequential:

1. **PR 1 — `prepare-strict-csp` refactor** (no header behavior change):
   - Add `@alpinejs/csp` dependency; swap the `/static/alpine.js` bundled source.
   - Register Alpine components (`Alpine.data(...)`) for every `x-data` island.
   - Rewrite handlers in `dashboard/page.ts`, `dashboard/list.ts`, `dashboard/timeline.ts` per §4.
   - Convert all `:style` bindings to object form per §4.
   - Extract inline styles to `/static/*.css` per §6.
   - Rewrite `ontoggle`/`onclick` in `trigger/page.ts` as `addEventListener` in `trigger-forms.js` per §5.
   - Extend integration tests to exercise refactored UI flows.
   - Merge; verify on local infra.

2. **PR 2 — `add-security-headers`** (adds the middleware + infra env var):
   - New `secure-headers` middleware module; mount first in `services/server.ts`.
   - Add `LOCAL_DEPLOYMENT=1` env var to `infrastructure/local/` Deployment manifest.
   - Unit tests per header; integration test per route family.
   - Update `SECURITY.md` §6 and `CLAUDE.md` invariants.
   - Merge; verify on both local infra and production (UpCloud).

**Rollback:** PR 2 rolls back by reverting the middleware mount — one line, deploys in seconds, no state migration. PR 1 is pure refactor with no infra coupling; revert is a standard git revert. If a CSP violation shows up in prod after PR 2 despite tests, the middleware can be bypassed by temporarily commenting out its mount in a hotfix — no need to unwind the refactor.
