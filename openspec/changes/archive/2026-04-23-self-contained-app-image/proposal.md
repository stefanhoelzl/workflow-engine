## Why

The 404 page, 5xx error page, and root redirect (`/` → `/trigger`) currently live in Traefik via four Middleware CRDs, a loopback IngressRoute, and a custom third-party plugin (`traefik_inline_response`) loaded from a vendored tarball through an init container + ConfigMap + shared `emptyDir` volume. That scaffolding only exists to let Traefik synthesise two HTML pages and one redirect — behaviour the app itself can produce in a handful of lines of Hono. The plugin is also a maintenance liability: the vendored tarball is pinned to a single third-party repo, and every Traefik chart bump risks plugin-loader breakage.

The goal is a self-contained app image: the workflow-engine container renders its own error pages and its own root redirect, so Traefik's job narrows to TLS termination + HTTP→HTTPS + host-based routing to the app. This also lets the main IngressRoute collapse from nine per-prefix rules into one catch-all, which removes the class of silent ordering bugs where a new prefix is added in code but forgotten in the IngressRoute.

## What Changes

- **BREAKING** (infra): Remove the `traefik_inline_response` plugin and its entire scaffolding — vendored tarball, `plugin-src` ConfigMap, init container, `plugins-local` volume, Helm `experimental.localPlugins` entry — from `modules/traefik/`. Delete `infrastructure/templates/error-5xx.html` and the `error_page_5xx_html` variable chain from every env + module that passes it.
- **BREAKING** (infra): Delete the `redirect-root`, `not-found`, `server-error`, and `inline-error` Traefik Middleware CRDs from the routes-chart. Delete the `error-pages` IngressRoute on the `web` entrypoint. Collapse the main `websecure` IngressRoute from its three-category layout (UI / no-auth / app-auth / catch-all) to a single `Host(…) && PathPrefix('/')` rule pointing at the app service with TLS. Keep the `redirect-to-https` Middleware and its `web`-entrypoint IngressRoute untouched — HTTP→HTTPS termination stays at Traefik because TLS terminates there.
- Add a root redirect `GET /` → `302 /trigger` in the Hono app (replaces the Traefik `redirectRegex` Middleware).
- Add a global `app.notFound` handler that branches on the request's `Accept` header: if it contains `text/html`, serve the cached `404.html` body with status 404; otherwise return JSON `{error: "Not Found"}` with status 404.
- Add a global `app.onError` handler with the same Accept-branch logic, serving a new `error.html` body with status 500 for HTML callers and JSON `{error: "Internal Server Error"}` for the rest. Handlers that explicitly `return c.json(..., 500)` bypass `onError` — that gap is accepted; the explicit body is typically more useful than a generic branded page.
- Remove the redundant sub-app `.notFound` handlers from `packages/runtime/src/api/index.ts` and `packages/runtime/src/ui/trigger/middleware.ts` — the global handler covers them. `/api`, `/webhooks`, and `/static` all follow the global Accept rule (no sub-app opt-outs).
- Add `packages/runtime/src/ui/static/error.html` following the same pattern as `404.html` — linked stylesheet, no inline `<style>`, no inline event handlers, no JS. A plain `<a>` back to `/` replaces the current reload button.
- Fold `packages/runtime/src/ui/static/error.css` into `packages/runtime/src/ui/static/workflow-engine.css` and delete the standalone file; update `404.html` to drop its `error.css` `<link>`.

### Explicitly out of scope

- Moving TLS termination from Traefik into the app.
- Moving the HTTP→HTTPS redirect from Traefik into the app.

Those are larger rearrangements with their own risk profile and can be proposed separately if ever needed.

## Capabilities

### New Capabilities

_None._ This change modifies three existing capabilities and does not introduce a new one.

### Modified Capabilities

- `http-server`: tightens the unmatched-route requirement to an Accept-branching HTML/JSON body, adds a global error handler with the same branching, and adds a root redirect.
- `static-assets`: 5xx page delivery moves from Traefik's inline-response plugin to a Hono-served static HTML; 404 page drops its `error.css` dependency; the "error middleware does not apply to static assets / oauth2" requirement is removed (the premise is gone — there are no more Traefik error middlewares).
- `infrastructure`: removes the Traefik inline-response plugin + its scaffolding from the Helm release, removes the four error/redirect Middleware CRDs and the `error-pages` loopback IngressRoute, and collapses the main IngressRoute to a single catch-all.

## Impact

**Affected code:**
- `packages/runtime/src/services/server.ts` — `createApp` gains a root redirect route, global `notFound`, and global `onError`.
- `packages/runtime/src/main.ts` — loads `404.html` and `error.html` contents at startup (cached strings) and wires them through `createServer`.
- `packages/runtime/src/api/index.ts` — drop the sub-app `.notFound`.
- `packages/runtime/src/ui/trigger/middleware.ts` — drop the sub-app `.notFound`.
- `packages/runtime/src/ui/static/error.html` — new file.
- `packages/runtime/src/ui/static/workflow-engine.css` — absorbs the rules from `error.css`.
- `packages/runtime/src/ui/static/error.css` — deleted.
- `packages/runtime/src/ui/static/404.html` — drops one `<link>`.

**Affected infrastructure:**
- `infrastructure/modules/traefik/traefik.tf` — deletes the `error_page_5xx_html` variable, the `experimental.plugins.inline-response` Helm set, the `plugin-src` ConfigMap, the init container, and the plugin-src / plugins-local volumes.
- `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml` — deletes four Middlewares, one IngressRoute, collapses the main IngressRoute to one catch-all rule.
- `infrastructure/modules/app-instance/routes.tf` + `variables.tf` — deletes the `errorPageHtml` Helm value + `error_page_5xx_html` variable.
- `infrastructure/envs/cluster/cluster.tf` — drops `error_page_5xx_html` pass-through to the traefik module.
- `infrastructure/envs/prod/prod.tf`, `envs/staging/staging.tf`, `envs/local/local.tf` (both call sites) — drop `error_page_5xx_html` pass-through to the app-instance module.
- `infrastructure/templates/error-5xx.html` — deleted.

**Deploy sequencing** (operator-first, per the `envs/cluster/` apply-first-then-PR flow in `CLAUDE.md`):
1. Operator edits everything locally, then runs `tofu -chdir=infrastructure/envs/cluster apply` — plugin and scaffolding leave the live Traefik release immediately.
2. Operator pushes the branch and opens the PR; `plan (cluster)` is green because live state matches the edited cluster project.
3. CI deploys the remaining changes to staging on merge; prod follows via cherry-pick to `release`.
4. Cosmetic gap on prod between step 1 and step 3's prod deploy: the still-wired `server-error` middleware proxies to a missing plugin for any real 5xx, so the user sees Traefik's raw plugin-load failure instead of the branded page. Short, low-severity, self-healing. Accepted.

**Dependencies:** none added. No manifest format changes. No EventBus pipeline changes. No sandbox boundary changes.

**Security:** `secureHeadersMiddleware` (CSP) already runs ahead of every route in the Hono app, so the new `error.html` inherits the existing `script-src`/`style-src` policy — the page uses only linked stylesheets, no inline `<script>`/`<style>`, no `on*=` handlers. No new entries in `SECURITY.md` §2/§4/§6 globals surface, auth surface, or CSP.

**State:** no `pending/`, `archive/`, or storage state wipe. No tenant re-upload. Additive upgrade note for `CLAUDE.md`'s "Upgrade notes" list.
