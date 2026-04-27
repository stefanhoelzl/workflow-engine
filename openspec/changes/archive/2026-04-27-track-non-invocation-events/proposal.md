## Why

Today the dashboard only surfaces invocations — handler runs that were dispatched into the executor. Three classes of operationally-meaningful events are invisible to workflow authors: (1) workflow uploads, (2) HTTP trigger requests rejected for body-schema violations before any handler runs, and (3) cron triggers that failed to arm because their schedule or timezone was invalid. Sandbox limit breaches are recorded as `system.exhaustion` markers but only visible inside the flamegraph, so a row in the list shows "failed" without the dimension. Authors currently rediscover these conditions only through external feedback (broken integrations, a workflow that mysteriously never fires, a CPU-exhausted run masquerading as a generic failure).

## What Changes

- Emit `system.upload` (new event kind) per workflow on `POST /api/workflows/<owner>/<repo>`, **deduplicated by `(owner, repo, workflow, workflowSha)`** — re-uploading identical bytes does not produce a new event. `input` carries the per-workflow manifest sub-snapshot. `meta.dispatch = {source: "upload", user}`.
- Emit `trigger.rejection` (new event kind) when an HTTP webhook resolves to a real `(owner, repo, workflow, trigger)` but the request body fails the trigger's zod schema. `input = {issues, method, path}` — request body is NOT persisted (privacy). 404s do NOT emit (scanner noise). No rate limiting in v1.
- Emit `trigger.exception` (existing kind) at the cron arm-time catch in `cron.ts:126` when `computeNextDelay()` throws — covers initial arm, post-fire re-arm, and registry-reconfigure re-arm in a single call site.
- Surface sandbox limit dimensions on the failed-invocation row in the dashboard list as a small pill (`CPU` / `MEM` / `OUT` / `PEND`), tooltip = `budget` + `observed`. Reads `system.exhaustion` events already in the store.
- Generalize the synthetic-row reconstruction in `fetchInvocationRowsForScopes()` so any single-leaf event without a `trigger.request` partner renders as a row (covers `trigger.exception`, `trigger.rejection`, `system.upload`).
- Render new event kinds with distinct chip + glyph: `system.upload` → "Uploaded" + upload-arrow; `trigger.rejection` → "Rejected" + shield-cross. No duration column, no flamegraph link.
- Relax SECURITY.md §2 R-9: allow `meta.dispatch` on `system.upload` in addition to `trigger.request`. Executor widener stamps it on both kinds.
- Extend SECURITY.md §2 R-7 reserved-prefix enumeration: add `system.upload` and `trigger.rejection`.

**Not breaking** for workflow authors. **Additive** for out-of-tree consumers that match on `kind` strings — they'll see new kinds but existing kinds are unchanged.

## Capabilities

### New Capabilities
_None._ Every change extends an existing capability.

### Modified Capabilities

- `event-bus`: New `kind` enumerations (`system.upload`, `trigger.rejection`); `meta.dispatch` allowed on `system.upload`.
- `event-store`: No schema change; new query path for "synthetic single-leaf rows" generalizes the existing `trigger.exception` reconstruction.
- `dashboard-list-view`: Renders new row kinds (Uploaded / Rejected) and a sandbox-exhaustion dimension pill on failed invocation rows.
- `http-trigger`: On zod body 422, emit `trigger.rejection` before responding.
- `cron-trigger`: On `computeNextDelay()` throw at arm time, emit `trigger.exception` in addition to the existing `logger.error`.
- `action-upload`: After a successful `POST /api/workflows/<owner>/<repo>`, emit `system.upload` per workflow with sha-based dedup.
- `executor`: Widener stamps `meta.dispatch` on `system.upload` events, not only `trigger.request`.
- `invocations`: Document `meta.dispatch` carve-out for `system.upload`; document `system.upload` and `trigger.rejection` as synthetic single-leaf invocations.

## Impact

- **Code**: `packages/runtime/src/api/upload.ts` (emit + dedup query), `packages/runtime/src/triggers/http.ts` (emit on 422), `packages/runtime/src/triggers/cron.ts:126` (emit on arm failure), `packages/runtime/src/executor/index.ts` (widener allows `meta.dispatch` on `system.upload`), `packages/runtime/src/ui/dashboard/page.ts` + row query (new chip/glyph variants, exhaustion pill, generalized synthetic-row reconstruction), `packages/core/src/index.ts` (extend `EventKind` union).
- **Spec/Security**: SECURITY.md §2 R-7 (reserved prefix list adds two kinds), §2 R-9 (`meta.dispatch` carve-out for `system.upload`).
- **Storage**: No schema migration. Events ride the existing DuckDB `events` table; `system.upload` events get a fresh `id` per workflow. Sha-dedup is a `SELECT 1 WHERE kind=…` against the existing `(owner, repo)` index plus a per-row filter.
- **Out-of-tree consumers** matching on `kind` strings (dashboards, log filters): see two new kinds. No existing kind changes shape.
- **Workflow authors**: zero rebuild required.
