## Context

The dashboard surfaces invocations only — opens at `trigger.request` and closes at `trigger.response`/`trigger.error`/`trigger.exception`. A workflow author has zero visibility today into:

1. **Workflow uploads.** The `POST /api/workflows/<owner>/<repo>` handler returns 204 and emits no event. There is no audit trail of "who pushed which version when".
2. **HTTP webhook 422s.** The existing flow returns 422 with zod issues but archives nothing — the author can't see "your `body` schema rejected 17 callers in the last hour".
3. **Cron arm-time failures.** `cron.ts:121-136` catches `computeNextDelay()` throws, calls `logger.error("cron.schedule-invalid")`, and silently disables the entry. The trigger never fires; nothing reaches the user.
4. **Sandbox limit dimensions on the list.** `system.exhaustion` events exist but only render as flamegraph markers. A failed-row reader can't tell "CPU killed it" from "handler threw" without expanding.

The runtime already has the carrier infrastructure: `EventStore` (DuckDB) is keyed by `(id, seq)`, scoped by `(owner, repo)`, and `trigger.exception` already establishes the synthetic-single-leaf-as-row pattern. The cheapest path is to ride it.

## Goals / Non-Goals

**Goals:**
- Per-workflow upload audit trail with sha-based dedup.
- Author-visible record of HTTP body-validation rejections, scoped per (workflow, trigger).
- Author-visible record of cron arm-time failures (covers initial arm, post-fire re-arm, and registry-reconfigure re-arm via the single shared `arm()` site).
- Sandbox-exhaustion dimension visible without opening the flamegraph.
- Zero change to existing event shapes; new kinds extend `EventKind` additively.

**Non-Goals:**
- Diff-classified upload events (added/updated/removed). Sha-based dedup gives the same insight without diff logic.
- Coalescing or rate-limiting `trigger.rejection` in v1. EventStore is in-memory DuckDB; revisit if a noisy caller becomes a problem.
- Emitting on owner/repo/workflow/trigger 404s — that surface is dominated by scanner noise and belongs in HTTP access logs.
- Cron / IMAP `*.fire-threw` events — those are engine bugs and stay as `logger.error`.
- Promoting `system.exhaustion` outside the invocation tree.
- Persisting HTTP request bodies on rejection events (privacy).

## Decisions

### D1. Two new event kinds, both single-leaf, both ride the existing pipeline

`system.upload` (new under `system.*`) and `trigger.rejection` (new under `trigger.*`). Both are single-leaf events with no paired open/close, exactly like `trigger.exception` today.

Alternatives considered:
- **Parallel "audit log" table.** Rejected: forks the storage layer, forks the dashboard query, doubles surface area for a few-events-per-day delta.
- **One kind for all three (`system.audit`).** Rejected: kind discriminates rendering and filtering; collapsing them costs more than the two extra strings save.

### D2. Sha-based dedup for `system.upload`, not diff-classified events

Before emitting, the upload handler queries `EventStore` for any existing `kind = 'system.upload' AND owner = ? AND repo = ? AND workflow = ? AND workflowSha = ?`. If a row exists, no-op. Otherwise emit.

- **Why sha-based:** the workflow build hashes the per-workflow bundle into `workflowSha`. Identical bytes → identical sha → already-recorded → skip. No diff logic needed in the upload handler.
- **Why not always emit:** the user explicitly rejected diff logic and noise; sha-based dedup is the trivial implementation that satisfies "tell me when something new appears".
- **What's emitted on a re-upload of changed-A + unchanged-B:** one event for A (new sha), zero for B (sha already seen). One `wfe upload` call → between 0 and N events.
- **Concurrency:** the registry serializes uploads per `(owner, repo)`, so the dedup check + emit is not racy in practice. A weaker guarantee (rare duplicate row under concurrent uploads of the same sha) is acceptable; the dashboard collapses on `(workflow, sha)` for display anyway. No transactional dedup needed.

### D3. `meta.dispatch` extended to `system.upload`; kept off other kinds

Today SECURITY.md §2 R-9 restricts `meta.dispatch` to `trigger.request`. Carve out `system.upload` as a second allowed kind.

- **Why:** an upload IS a dispatched action — a user pushed a bundle. The dispatch identity (`{source: "upload", user}`) is the natural carrier. Reusing the existing field avoids inventing a parallel "uploader" slot.
- **Executor widener change:** `executor.sb.onEvent` (and the upload-side host stamping path, since uploads don't go through a sandbox) gains a second `kind` for which `meta.dispatch` is stamped. Both stamping sites assert on the kind to keep invariants tight.
- **Alternatives considered:** stamping uploader inside the `input` blob. Rejected: fragments dispatch identity into two places, breaks symmetry with manual trigger fires.

### D4. `trigger.rejection` carries zod issues only — never the request body

`input = {issues: ZodIssue[], method, path}`. No `body`, no `body-preview`, no headers.

- **Why:** webhook bodies are caller-controlled, often contain user PII / tokens / signed claims. Persisting them turns the EventStore into a long-lived archive of caller payloads with no redaction policy. Issues alone are author-actionable: zod paths point exactly at what's wrong.
- **Trade-off:** debugging "why does my webhook reject these" is slightly harder without the body. Acceptable — caller logs are the right home for caller-shaped data.

### D5. Cron emission at the existing catch site covers all three re-arm paths

The cron source has one `arm()` function called from three places: cold boot, post-fire re-arm, registry `reconfigure()`. All flow through the same `try { computeNextDelay() } catch` at `cron.ts:121-136`. Adding `entry.exception(...)` inside that catch automatically covers initial arm, hot-swap re-arm, and registry-update re-arm with no additional emission sites.

- **Reuses existing kind:** `trigger.exception` already exists for "author-fixable trigger setup failure" — same semantic, same row treatment, no new dashboard work for cron.
- **Name:** `name: "cron.schedule-invalid"` mirrors the existing `logger.error` discriminator and the IMAP `name: "imap.poll-failed"` precedent.

### D6. Generalized synthetic-row reconstruction in the dashboard query

Today `fetchInvocationRowsForScopes()` (`packages/runtime/src/ui/dashboard/page.ts`) special-cases `trigger.exception` events without a paired `trigger.request`. Generalize to: any single-leaf event whose `kind` is in a "renderable as row" set produces a synthetic row.

The set: `{trigger.exception, trigger.rejection, system.upload}`. Each maps to a distinct row variant (chip text + glyph). All share the no-duration / no-flamegraph-link / no-dispatch-chip-for-trigger-exception properties.

- **Alternative:** add a separate query path per kind. Rejected: triples the query cost and duplicates 3 nearly-identical SQL clauses.

### D7. Sandbox-exhaustion pill: secondary read on the `events` table

When rendering a `failed` invocation row, the row builder queries the `events` table for an associated `system.exhaustion` event with the same `id` (LEFT JOIN, single row max). If found, the pill renders the dimension. If not, the row renders without a pill (regular handler throw).

- **Why a secondary read:** `system.exhaustion` is rare; baking it into every row render would duplicate work for the 99% of rows that don't have one. A LEFT JOIN by `id` is cheap and keeps the row-row separation clean.
- **Alternative:** widen `terminal_state` columns. Rejected: schema churn for a UI affordance.

## Risks / Trade-offs

- **`system.upload` widens the executor's stamping invariant** → keep two assertions: stamping path A asserts `kind ∈ {trigger.request, system.upload}` for `meta.dispatch`; SECURITY.md §2 R-9 updated to match.
- **`trigger.rejection` could be spammed by a misbehaving caller** → no rate limit in v1; documented as future work. Mitigation: zod issues are bounded-size, EventStore is in-memory and process-lifetime-scoped (~hours).
- **Sha-dedup race under concurrent uploads of the same sha** → at-most-rare duplicate row, harmless to dashboard. No transactional dedup.
- **Cron `cron.schedule-invalid` emissions during registry reconfigure could fire repeatedly** if a bad schedule survives across uploads → mitigated by the fact that each upload is idempotent (same sha → same exception event id... actually no, the id is fresh per emission). Documented: fixing the schedule and re-uploading clears the trigger; the historical rejection events stay (which is the desired audit trail).
- **Generalized synthetic-row reconstruction increases the query's complexity** → unit tests cover all three kinds plus the legacy `trigger.exception` path.
