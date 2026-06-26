# Dev probe recipes

Recipes agents use to verify changes against `pnpm dev` (see `CLAUDE.md` §Dev verification for the spawn/readiness contract).

## HTTP

`curl` against `POST /webhooks/local-user/demo-repo/demo/<trigger>` (public webhooks; route shape is `/webhooks/<owner>/<repo>/<workflow>/<trigger>` — four segments), `/invocations/local-user/demo-repo` (session cookie), `/trigger/local-user/demo-repo/demo/<trigger>` (session cookie). Assert on status code + JSON/HTML content. To list workflows or trigger names, scrape the invocations view HTML — there is no `GET /api/workflows/<owner>` JSON listing.

## EventStore (libSQL)

The event index and queues live in a libSQL embedded database at `.persistence/events.db`, opened in WAL mode. WAL permits a second reader concurrently with the live runtime, so you can SELECT against the live file directly. Probes:

- **Confirm round-trip on a manual fire.** Trigger a workflow, then grep stdout for `event-store.commit-ok { id, owner, repo, rows, duration }` — that line is emitted exactly once per terminal commit. Absence of the line means the runtime never received the trigger or the commit failed (look for `event-store.commit-retry` / `event-store.commit-dropped` instead).
- **Database file present.** `ls .persistence/events.db` after the first fire — created on first boot. There is no `events.duckdb`.
- **Lifecycle log lines.** The executor emits `invocation.started` / `invocation.completed` / `invocation.failed` independently of the durable archive (see `executor/log-lifecycle.ts`); grep stdout to confirm the application observed an invocation even if the commit was dropped.
- **Inspect rows against the live file.** WAL mode allows a concurrent reader (no need to stop `pnpm dev`). With the `sqlite3` CLI or any libSQL client:
  ```
  sqlite3 .persistence/events.db \
    "SELECT id, kind, owner, repo, name FROM events ORDER BY id, seq LIMIT 20;"
  ```
  Useful for verifying owner scoping, event-shape changes, or post-mortem of a specific terminal. The `queue_items` table lives in the same file.

## Invocations view HTML scraping

Grep rendered output for expected classes (`kind-trigger`, `kind-action`, `kind-rest`, `.entry.skeleton`) — cheap UI regression check without a browser.

## Stdout tailing

Tee the dev process's stdout to a file; grep for error traces and upload confirmations.

## Playwright (agent-only)

Not in `pnpm test` / `pnpm validate`. Use for Alpine-driven interactivity, focus rings, form submission, copy-event buttons. First-time use in a fresh clone requires `pnpm exec playwright install chromium` (~300 MB download, one-time). Scripts are ad-hoc via `pnpm exec playwright test -c <inline-config>` or `node -e '...'` — no test suite wiring.

## Auth fixture

`scripts/dev.ts` sets `AUTH_ALLOW=local:local-user,local:alice:acme,local:bob` and `LOCAL_DEPLOYMENT=1`. Gotchas:

- `/api/*`: `X-Auth-Provider: local` + `Authorization: User <name>`. The only API routes are `POST /api/workflows/<owner>/<repo>` and `GET /api/workflows/<owner>/public-key` — there is no `GET /api/workflows/<owner>` listing; scrape `/invocations/<owner>` instead.
- `/webhooks/*` is public.
- UI routes: `POST /auth/local/signin` form field is `user=` (NOT `name=` — handler reads `body.user`); reuse the sealed `session` cookie. For Alpine interactivity, use Playwright.

## Canonical fixture

`workflows/src/demo.ts` is the probe target. Its triggers: `runDemo` cron, http GET + POST under `/webhooks/local-user/demo-repo/*`, manual `fail` (exercises the `action.error` / `trigger.error` path). SDK or sandbox-stdlib changes must keep `demo.ts` in sync (see `CLAUDE.md` §Example workflows), so the probe surface stays stable.

## Cross-invocation persistence (queues)

Queue files live at `.persistence/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson` — one JSON-encoded item per line. The eager-create-at-upload invariant means every declared queue has a file (possibly zero-byte) on disk after a successful upload.

- **Confirm a queue file exists after upload.** `ls .persistence/queues/local-user/demo-repo/demo/` after `pnpm dev` settles — should list `jobs.ndjson` (the demo's `defineQueue({...})` declaration).
- **Producer round-trip.** `curl -X POST http://localhost:<port>/webhooks/local-user/demo-repo/demo/enqueueJob -H 'content-type: application/json' -d '{"url":"https://example.com","note":"hi"}'` → 202; then `cat .persistence/queues/local-user/demo-repo/demo/jobs.ndjson` shows one line.
- **Consumer drain.** Fire the manual `drainOnce` trigger via `/trigger/local-user/demo-repo/demo/drainOnce` (session cookie required) with `{"max":10}`; the file becomes empty after a successful drain.
- **Schema-mismatch event.** Send a body that fails the schema (e.g. `note` longer than 64 chars) and grep stdout for `system.error` with `name="queue.put"` and `code="queue.schemaMismatch"`. The file remains unchanged.
- **Boot reconciliation.** Add a manual orphan: `echo '{}' > .persistence/queues/local-user/demo-repo/demo/ghost.ndjson`. Restart `pnpm dev` and grep stdout for `queue-lifecycle.boot-sweep-orphan-removed { ... queue: "ghost" }`. The file is unlinked.
- **Re-upload preserves data.** Touch a workflow file to trigger hot-reload; verify the existing items in `jobs.ndjson` are still there (sha changed, but `(owner, repo, workflow, queueName)` identity is sha-independent).
