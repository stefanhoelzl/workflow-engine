## Context

Today the workflow-engine app image is not self-contained at the HTTP surface: three user-visible behaviours (styled 404, styled 5xx, root redirect) are synthesised by Traefik sitting in front of it. Three mechanisms:

1. **404**: Traefik `errors` middleware (`not-found`) intercepts any 404 response from the app on most route prefixes and issues an internal sub-request to the app for `/static/404.html`, replacing the original response body.
2. **5xx**: Traefik `errors` middleware (`server-error`) intercepts 500–599 and sub-requests `/error` on the Traefik pod itself on port 80, where another IngressRoute uses the custom `traefik_inline_response` plugin (vendored tarball, loaded via init container + `emptyDir` + Helm `experimental.localPlugins` set) to return the inline HTML from `var.error_page_5xx_html`.
3. **Root redirect**: Traefik `redirectRegex` middleware (`redirect-root`) turns `GET /` into `302 /trigger`.

The custom plugin is the load-bearing complexity: a vendored tarball in `modules/traefik/plugin/`, an init container with its own security-context boilerplate, a ConfigMap carrying base64 `binary_data`, an `emptyDir` volume, and `experimental.localPlugins.inline-response` in the Helm values. That scaffolding exists to render one HTML page. It also fights every Traefik chart upgrade because the plugin framework is Traefik's weakest compatibility story.

Hono already serves `404.html` as a plain static asset via the `staticMiddleware`, so moving the interception point from Traefik into Hono is a small step: a global `app.notFound` that reads the same HTML blob from memory. `app.onError` can do the symmetric job for 5xx. The root redirect is a one-liner. Once those three move, the IngressRoute collapses from ~10 rules to one.

Two design constraints that anchor the downstream choices:

- **CSP is app-enforced.** `secureHeadersMiddleware` (see `packages/runtime/src/services/secure-headers.ts`) sets a strict CSP that forbids `unsafe-inline` / `unsafe-eval` / inline handlers. The current `error-5xx.html` template uses an inline `<style>` block and an `onclick` handler; once served from Hono it would be blocked by the app's own CSP. The new static page follows the `404.html` pattern (linked stylesheet, no inline handlers).
- **TLS terminates at Traefik.** The app pod speaks plain HTTP on `:8080`. Moving HTTP→HTTPS redirect into Hono would require moving TLS termination, which is a different refactor with its own risk model. That redirect stays in Traefik.

## Goals / Non-Goals

**Goals:**
- Delete the `traefik_inline_response` plugin and every resource that exists only to support it.
- Collapse the main IngressRoute to a single catch-all rule so adding an app prefix never requires an infra change.
- Keep the existing user-visible behaviour for browser callers of unmatched / erroring routes: styled HTML 404 and 5xx pages, `/` → `/trigger` redirect.
- Give programmatic callers a useful response (JSON `{error: "…"}`) instead of an HTML page, via `Accept`-header content negotiation.
- Keep the refactor reversible: no state wipe, no manifest format change, no tenant re-upload.

**Non-Goals:**
- Moving TLS termination into the app.
- Moving the HTTP→HTTPS redirect (`redirect-to-https` Middleware on the `web` entrypoint) into the app.
- Introducing a templating/JSX layer for HTML responses — the two error pages stay as hand-written HTML files under `src/ui/static/`.
- Replacing `app.notFound` / `app.onError` with a post-response middleware that rewrites status-based bodies for handlers that explicitly `return c.json(…, 500)`. That gap is accepted.

## Decisions

### D1. Content negotiation: shared factory used by parent + every sub-app

**Decision.** A single helper module `packages/runtime/src/services/content-negotiation.ts` imports the two HTML bodies via `?raw` at build time and exports three things: the `acceptsHtml(c)` predicate (true iff `Accept` contains `text/html`), `createNotFoundHandler(pages?)`, and `createErrorHandler({pages?, logger?})`. `createApp` registers these on the top-level app, and every nested sub-app (`/api`, `/trigger`, `/dashboard`, and any future one) also registers `app.notFound(createNotFoundHandler())`.

**Why sub-apps own their notFound.** Hono sub-apps that are mounted via `app.use(match, (c) => subApp.fetch(c.req.raw))` *always* return a response from `subApp.fetch` — unmatched paths within the sub-app produce the sub-app's own notFound body (default: plain text `"404 Not Found"`), and that response propagates to the parent as a normal result. The parent's `app.notFound` therefore never fires for sub-app 404s. This was verified with a failing test during implementation. Sub-apps must install the handler themselves; the shared factory keeps the Accept-branch logic uniform.

**Classification rule.** Return HTML iff `Accept` explicitly includes `text/html` (any `q`). A missing header, `*/*`, or a non-HTML-mentioning header (e.g. `Accept: text/css`, `Accept: application/json`) all resolve to JSON. Browsers send `text/html` in their Accept, so they get HTML; `curl`, `fetch`, and asset loaders get JSON. Deterministic, no magic.

**Alternatives considered.**

- **Mount sub-apps with `app.route(basePath, subApp)` instead of `app.use(match, (c) => subApp.fetch(c.req.raw))`.** `app.route` folds the sub-app's routing table into the parent so unmatched paths fall through to the parent's `notFound`. Cleaner in principle but changes the `Middleware` interface contract used by every sub-app factory — bigger blast radius than needed for this change. Deferred.
- **Path-prefix branch in one handler.** A single handler that hard-codes `/api` and `/webhooks` → JSON and everything else → HTML. Re-encodes the mount layout as a string match inside the handler. Rejected — an `Accept` check is both simpler and more honest about what the client actually wants.

**Consequence for `/api/*`.** An in-browser visit to `/api/does-not-exist` returns the branded HTML 404, not the JSON shape. Weakens the UI/API separation slightly; accepted because nobody types `/api/*` URLs into a browser in normal operation.

**Consequence for `/static/*`.** Missing assets keep the same effective behaviour: `<script>` / `<link>` tags fire requests whose `Accept` header does not contain `text/html`, so the browser's asset loader receives JSON 404 (which it discards just like it would a plain-text 404). A human typing `/static/nowhere.js` into the address bar receives the branded HTML 404 — which is the same UX as any other unknown path.

### D2. Static file, not TypeScript string constant

**Decision.** `error.html` is a plain file under `packages/runtime/src/ui/static/`, served as a cached string read once at startup by `main.ts` via `readFile` + passed into `createServer`. `404.html` continues to live in the same place, already served as a static asset by `staticMiddleware`; its content is read once into the same cache.

**Alternatives considered.**

- **Inline TS string constant.** One fewer file but loses the ability to edit the HTML without rebuilding the TS code, and breaks the symmetry with `404.html`. Rejected.
- **Render via Hono JSX.** The project does not use JSX — the UI is built with raw HTML + Alpine. Introducing JSX for two static pages is off-target.

### D3. CSS consolidation: fold `error.css` into `workflow-engine.css`

**Decision.** Merge the five `.error-*` rules from `error.css` into `workflow-engine.css` and delete `error.css`. Both error pages (`404.html`, `error.html`) link only `/static/workflow-engine.css`.

**Rationale.** `error.css` is 47 lines; `workflow-engine.css` is 1510 lines and already defines the `:root` variables (`--text-muted`, `--accent`, `--radius-sm`, `--topbar-height`) that `error.css` references. Keeping them separate forces every error page to issue two stylesheet requests; merging saves one request on error rendering at the cost of ~1 KB of dead CSS on non-error pages. Net win. The naming (`error.*`) is generic enough that reusing the class names across pages is already the intent.

### D4. No post-response status rewriter

**Decision.** `app.onError` covers thrown errors. Handlers that explicitly `return c.json(…, 500)` keep their own body and status; they do not flow through `onError`.

**Alternatives considered.** A top-level wrapping middleware that inspects `ctx.res.status` after `await next()` and swaps the body if it's 5xx and the content-type is not HTML. Closer to today's Traefik semantics (purely status-based) but requires buffering the entire downstream response, loses the original error information, and couples tightly to handler internals. Rejected — the cost outweighs the benefit for what today is an almost-never-taken code path.

### D5. Full infra cleanup in one PR, operator applies `envs/cluster/` first

**Decision.** Everything ships in one PR: Hono handlers, static files, `routes-chart/` edits, `app-instance/` variable removals, `envs/*` pass-through removals, `modules/traefik/` plugin removal. Deploy sequencing follows the apply-first-then-PR flow for the cluster project (per `CLAUDE.md` > "Operator flow for manual infrastructure projects"):

1. Operator rebases onto `main`, edits the change locally, runs `tofu -chdir=infrastructure/envs/cluster apply` — plugin + init container + ConfigMap + volumes leave the live Traefik release.
2. Operator pushes and opens PR. `plan (cluster)` check is green because the cluster's live state now matches the edited project.
3. On merge, CI deploys the app + routes-chart to staging (main → staging workflow). Operator cherry-picks to `release` to deploy prod with the required-reviewer gate.

**Alternatives considered.**

- **Two PRs (app change first, cluster cleanup second).** Removes any cosmetic 5xx gap by letting the app ship its own handlers before the plugin goes away. Rejected because it splits a logically-atomic change across two review cycles for a cosmetic benefit.
- **One PR, cluster applied after.** Merge, let CI deploy routes-chart (references to plugin go away cleanly), then operator applies cluster. Rejected — merges with `plan (cluster)` reporting drift, which violates the apply-first-then-PR rule baked into the plan-infra gate.

### D6. Collapse the main IngressRoute to a single catch-all

**Decision.** The new `routes.yaml` keeps two IngressRoutes: (a) one `websecure` route matching `Host(var.domain) && PathPrefix('/')` pointing at the app service with TLS; (b) the existing `web`-entrypoint redirect-to-https route (unchanged). All Middleware references on the main route are removed. Cross-prefix concerns (404, 5xx, root redirect) are the app's job.

**Rationale.** The three-category layout (UI / no-auth / app-auth / catch-all) encoded mount points of the Hono app into infra YAML. Adding a new prefix in code currently requires two parallel edits; forgetting the infra side produces silent 404s with no local reproduction. Collapsing to a catch-all lets the app own its own routing table. The `server-error` and `not-found` middlewares were the only infra-side reason to break the route up in the first place.

## Risks / Trade-offs

- **Cosmetic 5xx gap on prod during the deploy window.** Between step 1 (`tofu apply` on `envs/cluster`) and step 3's prod deploy (cherry-pick to `release` + approval + CI), prod's still-wired `server-error` middleware proxies to the now-missing `inline-response` plugin on any real 5xx. Users hitting an actual error see Traefik's plugin-load failure (typically a blank 500) instead of the branded page. **Mitigation:** keep the window tight — cherry-pick immediately after the cluster apply; the window is minutes, not hours. Real 5xx rate is near zero in normal operation. Accepted per interview.
- **`/api/*` in a browser returns HTML.** An engineer typing `/api/workflows/foo` into a browser gets an HTML 404. Mild surprise, not a correctness issue. **Mitigation:** none needed; if this becomes a real papercut, add a sub-app `.notFound` on `/api` that forces JSON.
- **Explicit `return c.json(…, 500)` bypasses `onError`.** Handlers that return a 5xx directly keep their own body. In today's codebase this path is rare (grep for `, 500)` in `src/`); the explicit body is usually more informative than a generic page. **Mitigation:** none. If a future requirement lands that says "every 5xx MUST be the branded page regardless of origin," add a wrapping middleware then. Don't speculate.
- **CSP regression risk on the new `error.html`.** The file must not reintroduce inline `<style>` / `<script>` / `on*=` handlers or it breaks the existing CSP. **Mitigation:** follow the `404.html` pattern exactly (linked stylesheet, plain `<a>` link). An integration test can assert `error.html` contains no `<style>`, no `<script>`, no `on\w+=` attributes, no `javascript:` URLs.
- **Accept header parsing edge cases.** Some clients send malformed `Accept` headers; our parser must tolerate anything and default to JSON on parse failure. **Mitigation:** the helper is a trivial split-on-comma that looks for `text/html` as a substring of any segment; anything weirder resolves to "not HTML" → JSON. No throw paths.
- **Operator-side cluster apply discipline.** Whoever runs this must rebase onto `main` before applying, per `CLAUDE.md`. Applying from a stale branch could silently revert a concurrent cluster edit. **Mitigation:** the PR description repeats the rebase-first step; reviewers check the commit lands atop `main`.
