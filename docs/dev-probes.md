# Dev probe recipes

Recipes agents use to verify changes against `pnpm dev` (see `CLAUDE.md` §Dev verification for the spawn/readiness contract).

## HTTP

`curl` against `POST /webhooks/local-user/demo-repo/<trigger>` (public webhooks), `/invocations/local-user/demo-repo` (session cookie), `/trigger/local-user/demo-repo` (session cookie). Assert on status code + JSON/HTML content. To list workflows or trigger names, scrape the invocations view HTML — there is no `GET /api/workflows/<owner>` JSON listing.

## EventStore (DuckLake)

Cold-start is constant-time: the DuckLake catalog opens directly, no per-invocation file scan. While the runtime is alive it holds an exclusive file lock on `.persistence/events.duckdb` (DuckDB-imposed, even for read-only attach), so external SELECTs against the live catalog are not viable. Use these probes instead:

- **Confirm round-trip on a manual fire.** Trigger a workflow, then grep stdout for `event-store.commit-ok { id, owner, repo, rows, duration }` — that line is emitted exactly once per terminal commit. Absence of the line means the runtime never received the trigger or the commit failed (look for `event-store.commit-retry` / `event-store.commit-dropped` instead).
- **Catalog file present.** `ls .persistence/events.duckdb` after the first fire — created on first boot.
- **Lifecycle log lines.** The executor emits `invocation.started` / `invocation.completed` / `invocation.failed` independently of the durable archive (see `executor/log-lifecycle.ts`); grep stdout to confirm the application observed an invocation even if the commit was dropped.
- **CHECKPOINT activity.** `event-store.checkpoint-run { durationMs, catalogBytesBefore, catalogBytesAfter, inlinedRowsFlushedApprox, trigger }` lines appear when DuckLake compacts inlined rows into Parquet. Force-trigger by spawning with `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS=1` and firing a few invocations.
- **Inspect rows after the runtime exits.** Stop `pnpm dev` (it releases the lock on shutdown), then attach in another DuckDB process:
  ```
  duckdb -c "INSTALL ducklake; LOAD ducklake;
             ATTACH 'ducklake:.persistence/events.duckdb' AS event_store
                    (READ_ONLY, DATA_PATH '.persistence/events');
             SELECT id, kind, owner, repo, name FROM event_store.events ORDER BY id, seq LIMIT 20;"
  ```
  Useful for verifying owner scoping, event-shape changes, or post-mortem of a specific terminal.

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
- **Producer round-trip.** `curl -X POST http://localhost:<port>/webhooks/local-user/demo-repo/enqueueJob -H 'content-type: application/json' -d '{"url":"https://example.com","note":"hi"}'` → 202; then `cat .persistence/queues/local-user/demo-repo/demo/jobs.ndjson` shows one line.
- **Consumer drain.** Fire the manual `drainOnce` trigger via `/trigger/local-user/demo-repo/drainOnce` (session cookie required) with `{"max":10}`; the file becomes empty after a successful drain.
- **Schema-mismatch event.** Send a body that fails the schema (e.g. `note` longer than 64 chars) and grep stdout for `system.error` with `name="queue.put"` and `code="queue.schemaMismatch"`. The file remains unchanged.
- **Boot reconciliation.** Add a manual orphan: `echo '{}' > .persistence/queues/local-user/demo-repo/demo/ghost.ndjson`. Restart `pnpm dev` and grep stdout for `queue-lifecycle.boot-sweep-orphan-removed { ... queue: "ghost" }`. The file is unlinked.
- **Re-upload preserves data.** Touch a workflow file to trigger hot-reload; verify the existing items in `jobs.ndjson` are still there (sha changed, but `(owner, repo, workflow, queueName)` identity is sha-independent).
