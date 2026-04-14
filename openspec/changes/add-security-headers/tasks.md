## 1. PR 1 — CSP-prep refactor (no header changes)

- [x] 1.1 Add `@alpinejs/csp` dependency to `packages/runtime/package.json`, pinned to the same major as `alpinejs`; run `pnpm install`
- [x] 1.2 Swap the Alpine source in `packages/runtime/src/ui/static/middleware.ts` from `alpinejs/dist/cdn.min.js?raw` to `@alpinejs/csp/dist/cdn.min.js?raw` (or equivalent entry point)
- [x] 1.3 Create `packages/runtime/src/ui/static/dashboard-alpine.js` registering Alpine components on the `alpine:init` event; load it from the shared layout before `alpine.js` so the listener attaches first
- [x] 1.4 Register `dashboardTooltip` component: state (`tip`, `tipX`, `tipY`, `_tipTimer`, `_copied`), methods `showTip(el)`, `scheduleHide()`, `cancelHide()`, `copyEvent()`; reads per-row data from `data-type`/`data-state`/`data-event`/`data-color` attrs via `el.dataset`
- [x] 1.5 Register `dashboardFilters` component: state (`state`, `type`, `eventTypes`, `eventTypeOpen`), methods `init()` (absorbs current `x-init` fetch chains), `load()`, `toggleEventType(t)`, `toggleEventTypes()`, `closeEventTypes()`
- [x] 1.6 Register `listItemExpander` component: state (`expanded`), method `toggle()`
- [x] 1.7 Rewrite `packages/runtime/src/ui/dashboard/timeline.ts` to emit `data-type`/`data-state`/`data-event`/`data-color` attrs and `@mouseenter="showTip($el)"` / `@mouseleave="scheduleHide()"`; drop the `data-tip` JSON blob
- [x] 1.8 Rewrite `packages/runtime/src/ui/dashboard/page.ts` to use `x-data="dashboardTooltip"` / `x-data="dashboardFilters"` by name; replace inline handlers with component-method calls; replace `:style` string templates with object form
- [x] 1.9 Rewrite `packages/runtime/src/ui/dashboard/list.ts`: `x-data="listItemExpander"`, replace `@change="toggleEventType('${t}')"` interpolation with `data-event-type="${t}"` + `@change="toggleEventType($el.dataset.eventType)"`
- [x] 1.10 Replace static `style="..."` attributes in `dashboard/page.ts` with CSS classes (`.tooltip-title .badge`, `.filter-btn-caret`); the redundant `position:relative` on `.filter-dropdown` was already covered by the existing class. Extend `workflow-engine.css`.
- [x] 1.11 Replace dynamic color attributes in `dashboard/list.ts` with `data-color="..."` attrs; add CSS selectors `.stat-dot[data-color="yellow"|"red"|"green"]` mapping to CSS variables in `workflow-engine.css`
- [x] 1.12 Extract the `<style>` block from `packages/runtime/src/ui/trigger/page.ts` into a new `packages/runtime/src/ui/static/trigger.css` file; serve via existing static middleware; reference with `<link rel="stylesheet" href="/static/trigger.css">`
- [x] 1.13 Extract the `<style>` block from `packages/runtime/src/ui/static/404.html` into a new `/static/error.css`; reference with `<link>`
- [x] 1.14 Remove the inline `ontoggle="initForm(this)"` attr from `trigger/page.ts`; rely on event binding in `trigger-forms.js`
- [x] 1.15 Remove the inline `onclick="submitEvent(this, '${name}')"` attr from `trigger/page.ts`; add `data-event-type="${name}"` to the button
- [x] 1.16 Extend `packages/runtime/src/ui/static/trigger-forms.js` with a DOMContentLoaded handler that binds `toggle` events on every `.event-details` to `initForm(el)` and `click` events on every `.submit-btn[data-event-type]` to `submitEvent(btn, btn.dataset.eventType)`
- [x] 1.17 Run `pnpm validate` (lint, format, type check, tests, tofu fmt/validate); fix regressions — all green, 360 tests pass
- [x] 1.18 Add `packages/runtime/src/ui/html-invariants.test.ts` asserting CSP-safe rendering: no inline `<script>`/`<style>`/`on*=`/`style=`, every `x-data` is a bare identifier, every `:style` is object form. Also asserts script ordering for `alpine:init`. Six tests covering dashboard page, list, header stats, timeline, trigger page, and layout.
- [x] 1.19 Manual smoke on `pnpm local:up:build`: dashboard loads, tooltip appears on hover, filters apply, event list expands, trigger form submits

## 2. PR 2 — Security headers middleware

- [ ] 2.1 Create `packages/runtime/src/services/secure-headers.ts` exporting a `secureHeadersMiddleware()` factory returning a Hono middleware function
- [ ] 2.2 Implement CSP string builder using `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
- [ ] 2.3 Implement Permissions-Policy string builder with every feature set to `()` except `clipboard-write=(self)` (feature list in the http-security spec requirement)
- [ ] 2.4 Implement HSTS gate: read `process.env.LOCAL_DEPLOYMENT` at middleware construction time; if the string equals `"1"` exactly, omit HSTS from the header set
- [ ] 2.5 Mount `secureHeadersMiddleware()` as the first middleware in `packages/runtime/src/services/server.ts` so it runs before routing and applies to every response
- [ ] 2.6 Write `packages/runtime/src/services/secure-headers.test.ts` unit tests: one assertion per header; both branches of the HSTS gate (`LOCAL_DEPLOYMENT="1"` vs unset); verify CSP contains none of `'unsafe-inline'`/`'unsafe-eval'`/`'unsafe-hashes'`/`'strict-dynamic'`; verify no remote origins in CSP
- [ ] 2.7 Extend the runtime integration test harness to hit `/livez`, a registered `/webhooks/<name>`, a registered `/api/*` route, `/dashboard`, `/trigger`, and `/static/alpine.js`; assert the full baseline header set on each response
- [ ] 2.8 Add `LOCAL_DEPLOYMENT=1` to the app Deployment env in `infrastructure/local/` Terraform; leave `infrastructure/upcloud/` unset
- [ ] 2.9 Add a new `## §6 HTTP Response Headers` section to `/SECURITY.md` documenting the threat model, the header set, the CSP rationale (`default-src 'none'` + explicit grants, no `'unsafe-*'`), the HSTS local gate, and the `no inline script/style` invariant that protects the CSP
- [ ] 2.10 Add a bullet to the `## Security Invariants` section of `/CLAUDE.md`: "NEVER add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or a remote origin to the CSP in `secure-headers.ts` (§6)." and a second bullet: "NEVER add an inline `<script>`, `<style>`, `on*=` attribute, `style=` attribute, or string-form Alpine `:style` binding to any HTML served by the runtime (§6)."
- [ ] 2.11 Run `pnpm validate` (lint, format, type check, tests); fix regressions
- [ ] 2.12 Manual smoke on `pnpm local:up:build`: all routes load under the new policy; browser devtools CSP panel shows no violations; `Strict-Transport-Security` absent on localhost; clipboard copy button works
- [ ] 2.13 Open PR 2; merge once CI green and smoke clean
- [ ] 2.14 Deploy to prod (`tofu apply` in `infrastructure/upcloud/`); verify via `curl -I https://workflow-engine.webredirect.org/dashboard` that every header is present with expected values and `Strict-Transport-Security` appears
