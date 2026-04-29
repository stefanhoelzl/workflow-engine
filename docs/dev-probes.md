# Dev probe recipes

Recipes agents use to verify changes against `pnpm dev` (see `CLAUDE.md` §Dev verification for the spawn/readiness contract).

## HTTP

`curl` against `POST /webhooks/local/demo/<trigger>` (public webhooks), `/dashboard/local/demo` (session cookie), `/trigger/local/demo` (session cookie). Assert on status code + JSON/HTML content. To list workflows or trigger names, scrape the dashboard HTML — there is no `GET /api/workflows/<owner>` JSON listing.

## EventStore

Inspect `.persistence/` for emitted events (`invocation.started`, `invocation.completed`, `trigger.request`, `action.error`, …). Useful when verifying owner scoping or event-shape changes without a UI.

## Dashboard HTML scraping

Grep rendered output for expected classes (`kind-trigger`, `kind-action`, `kind-rest`, `.entry.skeleton`) — cheap UI regression check without a browser.

## Stdout tailing

Tee the dev process's stdout to a file; grep for error traces and upload confirmations.

## Playwright (agent-only)

Not in `pnpm test` / `pnpm validate`. Use for Alpine-driven interactivity, focus rings, form submission, copy-event buttons. First-time use in a fresh clone requires `pnpm exec playwright install chromium` (~300 MB download, one-time). Scripts are ad-hoc via `pnpm exec playwright test -c <inline-config>` or `node -e '...'` — no test suite wiring.

## Auth fixture

`scripts/dev.ts` sets `AUTH_ALLOW=local:local,local:alice:acme,local:bob` and `LOCAL_DEPLOYMENT=1`. Gotchas:

- `/api/*`: `X-Auth-Provider: local` + `Authorization: User <name>`. The only API routes are `POST /api/workflows/<owner>/<repo>` and `GET /api/workflows/<owner>/public-key` — there is no `GET /api/workflows/<owner>` listing; scrape `/dashboard/<owner>` instead.
- `/webhooks/*` is public.
- UI routes: `POST /auth/local/signin` form field is `user=` (NOT `name=` — handler reads `body.user`); reuse the sealed `session` cookie. For Alpine interactivity, use Playwright.

## Canonical fixture

`workflows/src/demo.ts` is the probe target. Its triggers: `runDemo` cron, http GET + POST under `/webhooks/local/demo/*`, manual `fail` (exercises the `action.error` / `trigger.error` path). SDK or sandbox-stdlib changes must keep `demo.ts` in sync (see `CLAUDE.md` §Example workflows), so the probe surface stays stable.
