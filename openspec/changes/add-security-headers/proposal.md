## Why

The runtime currently sets no HTTP security response headers. Browsers therefore enforce none of the defense-in-depth layers that should apply to an authenticated dashboard: no HSTS to force HTTPS, no Content-Security-Policy to constrain script/style execution, no X-Frame-Options to prevent clickjacking, no Referrer-Policy, Permissions-Policy, or Cross-Origin-* isolation. SECURITY.md §4 documents the authentication layer but is silent on header hardening, leaving a visible gap in the threat model.

## What Changes

- Add a `secureHeaders` middleware mounted first in the Hono app, applying a uniform baseline to every response:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`: all browser features locked to `()`, except `clipboard-write=(self)`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Resource-Policy: same-origin`
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
- Gate HSTS behind a `LOCAL_DEPLOYMENT=1` environment variable so the local kind stack (self-signed cert on `localhost:8443`) does not pin HSTS on developer browsers.
- Refactor the dashboard and trigger UI so they satisfy the strict CSP without `'unsafe-inline'` or `'unsafe-eval'`:
  - Swap `alpinejs/dist/cdn.min.js` to `@alpinejs/csp` (no `new Function()`), register every component via `Alpine.data(...)`.
  - Rewrite Alpine expressions in `dashboard/page.ts`, `dashboard/list.ts`, `dashboard/timeline.ts` so each handler is a single method call, not a multi-statement body.
  - Convert every `:style="..."` string-literal binding to an object form (Alpine's object path uses `el.style.setProperty` and is CSP-safe; the string path sets the inline `style` attribute and is blocked by `style-src 'self'`).
  - Move inline `<style>` blocks (`trigger/page.ts`, `static/404.html`) and inline `style="..."` attributes into external stylesheets served from `/static`.
  - Rewrite inline event attributes (`ontoggle="initForm(this)"`, `onclick="submitEvent(this, ...)"` in `trigger/page.ts`) to `addEventListener` wiring in `trigger-forms.js`, passing parameters via `data-*` attributes.
- Add `LOCAL_DEPLOYMENT=1` to the local Terraform Deployment env (`infrastructure/local/`); leave prod (`infrastructure/upcloud/`) unset.
- Extend SECURITY.md with a new §6 "HTTP Response Headers" section; add a matching one-line invariant in `CLAUDE.md` covering the CSP baseline.

## Capabilities

### New Capabilities

- `http-security`: Cross-cutting requirements for HTTP response security headers, the CSP baseline, the local-deployment HSTS gate, and the "no inline script/style" invariant that the dashboard and trigger UIs must preserve.

### Modified Capabilities

_(none — existing specs describe the UI and server behavior in terms of features, not inline-markup style; the new invariants live in the new `http-security` spec rather than mutating `http-server`, `dashboard-*`, or `trigger` spec requirements.)_

## Impact

- **Code**:
  - `packages/runtime/src/services/server.ts` — mount new middleware first
  - `packages/runtime/src/services/secure-headers.ts` (new) — header middleware
  - `packages/runtime/src/ui/static/middleware.ts` — swap Alpine build import
  - `packages/runtime/src/ui/dashboard/page.ts`, `list.ts`, `timeline.ts` — Alpine refactor, inline-style extraction
  - `packages/runtime/src/ui/trigger/page.ts` — inline-handler rewrite, style block extraction
  - `packages/runtime/src/ui/static/trigger-forms.js` — `addEventListener` wiring, `data-*` param plumbing
  - `packages/runtime/src/ui/static/*.css` (new/extended) — externalized styles
  - `packages/runtime/src/ui/static/404.html` — style block extraction
- **Dependencies**: add `@alpinejs/csp` (sibling package to `alpinejs`, pinned to the same major).
- **Infrastructure**: `infrastructure/local/` Deployment env gains `LOCAL_DEPLOYMENT=1`. No prod Terraform changes.
- **Docs**: `SECURITY.md` gains §6; `CLAUDE.md` gains one invariant bullet.
- **Tests**: unit tests per header in a new `secure-headers.test.ts`; integration test asserting headers on `/livez`, `/webhooks/*`, `/api/*`, `/dashboard`, `/trigger`, `/static/*`; local-mode toggle verified by setting `LOCAL_DEPLOYMENT` in the test harness.
- **Risk**: a CSP violation that slips past the test matrix will silently break UI in production. Mitigated by (a) landing the refactor in a separate PR with no header changes, so the UI is validated on strict-CSP-ready code before headers are added; (b) integration tests that load each HTML route through a real browser-like client (or JSDOM with CSP checks) before the header PR merges.
- **Out of scope**: headers on `/oauth2/*` responses (served by the oauth2-proxy sidecar, same-origin, accepted gap); CSP reporting endpoint; HSTS preload submission.
