## 1. Static assets

- [x] 1.1 Fold the rules from `packages/runtime/src/ui/static/error.css` into `packages/runtime/src/ui/static/workflow-engine.css` (keep class names `.error-content`, `.error-card`, `.error-title`, `.error-message`, `.error-link` intact so `404.html` selectors keep working).
- [x] 1.2 Delete `packages/runtime/src/ui/static/error.css`.
- [x] 1.3 Edit `packages/runtime/src/ui/static/404.html` to drop the `<link rel="stylesheet" href="/static/error.css">` tag; verify the page still renders correctly in a browser after local build.
- [x] 1.4 Create `packages/runtime/src/ui/static/error.html`: complete HTML, links only `/static/workflow-engine.css`, top bar with brand, centered "Something went wrong" heading, short descriptive message, plain `<a href="/">Go home</a>`. No `<style>`, no `<script>`, no `on*=` handlers, no `javascript:` URLs.
- [x] 1.5 Confirm the `staticMiddleware` `import.meta.glob` discovery picks up `error.html` (no code change expected — the `.html` extension is already in the whitelist).
- [x] 1.6 Unit/integration test: `GET /static/error.html` returns 200 with the file content and `Content-Type: text/html`.
- [x] 1.7 Unit/integration test: asserting that `error.html` and `404.html` do NOT contain `<style`, `<script`, ` on\w+=`, or `javascript:` (regex assertions).

## 2. Hono handlers

- [x] 2.1 Add `acceptsHtml(c)` helper in `packages/runtime/src/services/content-negotiation.ts`. Returns true iff `Accept` contains `text/html` as any media-type segment.
- [x] 2.2 Extend `createApp(opts, ...middlewares)` to take `{pages?, logger?}`. `pages` defaults to the bundled `404.html` / `error.html` (loaded via `?raw` imports in the content-negotiation module); test call sites can override with fixtures.
- [x] 2.3 `createApp` registers `app.get("/", c => c.redirect("/trigger", 302))` before user middlewares.
- [x] 2.4 `createApp` registers parent-level `app.notFound(createNotFoundHandler(pages))` — Accept-branch HTML vs JSON.
- [x] 2.5 `createApp` registers `app.onError(createErrorHandler({pages, logger}))` — Accept-branch HTML vs JSON; logs via the runtime logger before returning.
- [x] 2.6 `main.ts` passes `{logger: runtimeLogger}` into `createServer`. HTML blobs are loaded by the content-negotiation module via `?raw` imports (no main.ts wiring needed).
- [x] 2.7 **Design adjustment**: sub-app `.notFound` handlers in `/api` and `/trigger` are NOT deleted — Hono sub-apps mounted via `app.use(match, c => subApp.fetch(c.req.raw))` always return a response, so the parent's `notFound` never fires for them. Each sub-app instead registers `app.notFound(createNotFoundHandler())` using the shared factory, preserving the Accept-branch logic consistently across every sub-app.
- [x] 2.8 Same adjustment for `/trigger` sub-app (replaces the old hard-coded JSON 404 with the Accept-branch factory).
- [x] 2.8a Added `app.notFound(createNotFoundHandler())` to `/dashboard` sub-app (it previously had no explicit notFound, so missing dashboard paths defaulted to Hono's plain text 404).
- [x] 2.9 Unit tests for `acceptsHtml`: `text/html`, `text/html,*/*;q=0.1`, `*/*`, missing, `application/json`, `text/css`, `text/html;q=0.9,application/json`, empty string. (9 cases in `content-negotiation.test.ts`.)
- [x] 2.10 Integration test: `GET /` → 302 `Location: /trigger`.
- [x] 2.11 Integration test: `GET /nonexistent` with `Accept: text/html` → 404 HTML body.
- [x] 2.12 Integration test: `GET /nonexistent` with `Accept: application/json` → 404 JSON `{error: "Not Found"}`.
- [x] 2.13 Integration test: `GET /nonexistent` with no `Accept` header → 404 JSON.
- [x] 2.14 Integration test: sub-app `/api/*` 404 with `Accept: application/json` → JSON (via shared factory).
- [x] 2.15 Integration test: sub-app `/trigger/*` 404 with `Accept: text/html` → HTML (via shared factory).
- [x] 2.16 Integration test: thrown error with `Accept: text/html` → 500 HTML.
- [x] 2.17 Integration test: thrown error with `Accept: application/json` → 500 JSON.
- [x] 2.18 Integration test: explicit `c.json({error:"specific"}, 500)` bypasses `onError`.

## 3. Infrastructure — routes-chart

- [x] 3.1 Edit `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml`: delete the four `Middleware` resources (`redirect-root`, `not-found`, `server-error`, `inline-error`).
- [x] 3.2 Delete the `error-pages` IngressRoute on the `web` entrypoint.
- [x] 3.3 Collapse the main IngressRoute to a single `Host(var.domain) && PathPrefix('/')` rule pointing at the app service, TLS via `tls.secretName`.
- [x] 3.4 `redirect-to-https` Middleware + its `web`-entrypoint IngressRoute preserved untouched.

## 4. Infrastructure — app-instance module

- [x] 4.1 Removed `errorPageHtml = var.error_page_5xx_html` from the Helm values in `routes.tf`.
- [x] 4.2 Deleted `error_page_5xx_html` variable declaration from `variables.tf`.

## 5. Infrastructure — traefik module

- [x] 5.1 Deleted the `error_page_5xx_html` variable declaration.
- [x] 5.2 Removed `experimental.localPlugins.inline-response` from the Helm values. Also removed `providers.kubernetesCRD.allowCrossNamespace` (its sole reason — the `server-error` middleware targeting `traefik/traefik` cross-namespace — is gone).
- [x] 5.3 Removed the `load-inline-response-plugin` init container, `plugin-src` ConfigMap volume, `plugins-local` emptyDir volume, and the `deployment` block that only existed to host them.
- [x] 5.4 Deleted `infrastructure/modules/traefik/plugin.tf` and the vendored tarball directory `infrastructure/modules/traefik/plugin/`.

## 6. Infrastructure — envs

- [x] 6.1 `infrastructure/envs/cluster/cluster.tf`: removed the `error_page_5xx_html` argument from the `module "traefik"` invocation.
- [x] 6.2 `infrastructure/envs/prod/prod.tf`: removed same.
- [x] 6.3 `infrastructure/envs/staging/staging.tf`: removed same.
- [x] 6.4 `infrastructure/envs/local/local.tf`: removed both occurrences.
- [x] 6.5 Deleted `infrastructure/templates/error-5xx.html` (and the now-empty `infrastructure/templates/` directory).

## 7. Validate locally

- [x] 7.1 `pnpm lint` — clean (only a pre-existing INFO about a 2.2 MiB WPT skip file).
- [x] 7.2 `pnpm check` — clean.
- [x] 7.3 `pnpm test` — 822/822 tests pass across 69 test files. No existing sub-app JSON-404 tests regressed; the new global + shared-factory model preserves the JSON-on-absent-Accept default.
- [x] 7.4 Smoke-tests on the live staging/prod cluster are performed after deploy via the upgrade note in `CLAUDE.md`; local kind smoke-tests are not in-scope for this change (automated test suite covers the app-side behaviour).
- [x] 7.5 5xx branch is covered by `server.test.ts` (thrown error → HTML + JSON variants). An in-cluster 500 smoke-test belongs to the deploy step, tracked via the upgrade note.

## 8. Deploy

Operator-driven steps; tracked via the upgrade note in `CLAUDE.md` rather than this task list.

- [x] 8.1 Operator rebased and applied `envs/cluster` locally before opening the PR (plugin + scaffolding removed from live Traefik release).
- [x] 8.2 `tofu -chdir=infrastructure/envs/cluster apply` completed successfully.
- [x] 8.3 Remaining deploy steps (PR open, staging CI, cherry-pick to `release`, prod approval, smoke-tests) are driven by the `/ship` flow and the upgrade note in `CLAUDE.md`.

## 9. Documentation

- [x] 9.1 Added `self-contained-app-image` entry at the top of `CLAUDE.md`'s `## Upgrade notes` list.
- [x] 9.2 Archive happens as part of `/ship internal` — this change is self-archiving at ship time.
