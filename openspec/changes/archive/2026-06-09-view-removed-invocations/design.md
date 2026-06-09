## Context

Invocation events are immutable rows in the DuckDB EventStore keyed by `(owner, repo, workflow, name)` *strings* (`packages/runtime/src/event-store.ts`). The `WorkflowRegistry` is an in-memory map atomically swapped on every upload (`packages/runtime/src/workflow-registry.ts`). The two never reconcile historically: renaming or removing a trigger drops it from the registry, leaving its old events with no registry entry.

Three UI consequences today:
- **Repo-wide flat list** (`GET /invocations/:owner/:repo`) — removed rows *are* still shown; the EventStore query is not registry-filtered.
- **Sidebar tree** — built purely from `registry.list()`/`registry.repos()` (`sidebar-tree.tsx:279-301`), so removed workflows/triggers have no node.
- **Filter URLs** — the `:workflow` guard `404`s an absent name when the registry is non-empty (`invocations/middleware.tsx`), and the per-trigger query filters `WHERE name = ?` on the new name.

The sidebar is a *single unified tree* reused across `/invocations`, `/trigger`, and `/queue` (`shared-layout` spec, "Navigation sidebar"). The trigger-kind icon registry is a cross-surface contract in `ui-foundation` that already carries a synthetic `upload` kind for `system.upload` rows.

## Goals / Non-Goals

**Goals:**
- Make a removed/renamed workflow or trigger's run history reachable through the sidebar tree and by URL on the invocations surface.
- Visually distinguish removed nodes and rows from live ones without losing the live working set's prominence.
- Add zero new write paths and no schema change; reuse the immutable event history as the source of truth for "what once existed."

**Non-Goals:**
- **Stable trigger identity / rename continuity.** A renamed trigger is two separate histories (old removed + new live), not one merged timeline.
- **Removed awareness on `/trigger` and `/queue`.** Those surfaces stay registry-only; an removed has no config and no queue.
- **Recovering a removed trigger's *kind*.** The kind is not on run events and is only fragilely recoverable from historical `system.upload` snapshots; removed entities render a archive box instead.
- **Removal bookkeeping / soft-delete records.** Removed status is inferred by diffing events against the registry; retention pruning is the GC.

## Decisions

### D1: Removed = `(workflow, name)` pair in events but not in the registry

Inferred, not recorded. A single global `SELECT DISTINCT owner, repo, workflow, name` over the user's authorised scopes yields every pair that ever ran; subtracting the registry's live pairs gives the removed set. Covers removed *and* renamed identically. Alternative — an explicit archive box written on upload-diff — was rejected: more plumbing, a new write path, and it must survive registry rebuilds, for no behavioural gain over inference.

### D2: Removeds are an invocations-surface concept only

The unified tree is fed by a **pure** `buildSidebarData(registry, owners, removedPairs?)`. The removed-pairs argument is supplied **only** on the `/invocations` route; `/trigger` and `/queue` call sites omit it and render exactly as today. This keeps the extra DB round-trip off those surfaces entirely and encodes "removed = history" in the data flow rather than a render-time `if`. Alternatives (archive box-everywhere-disabled, or always-link-to-invocations) were rejected: they teach two surfaces about a thing they cannot act on, and the always-link variant breaks the "tree links preserve current surface" invariant.

### D3: The removed-pairs query is global and complete, not the page's rendered rows

The page's invocation rows are scope-narrow (filtered by the active URL) and `limit`-windowed; the sidebar is always global and complete. Reusing page rows would make removed nodes appear only for the current narrow, recent slice and reshuffle on every drill-in. So removed pairs come from a dedicated query: all scopes, no limit, distinct tuples only (bounded by the number of trigger names that ever existed, not the run count) — lighter than fetching rows.

### D4: Tree marking — sentinel `kind` for triggers, boolean for workflows

Trigger leaves already switch on `kind` to pick an icon (`sidebar-tree.tsx:91`), so an removed trigger carries `kind: "removed"` — a sentinel that does triple duty (archive box icon, muted class, sort key). Workflows have no icon (`WorkflowNode` renders a plain label), so a fully-removed workflow carries an explicit `removed?: true` boolean driving muted styling + sort. The `"removed"` sentinel is safe because we deliberately do not recover kind, so the identity-axis and existence-axis never coexist on the same node. The `removed` glyph is registered in the `ui-foundation` trigger-kind registry alongside the precedent `upload` kind.

### D5: Three-level union, removed entities sunk below live, no divider

The union happens at repo, workflow, and trigger levels — a repo whose every workflow was removed is absent from `registry.repos()` and must still get a node from event-derived repos. Within each level, live nodes render first in current order, then removed ones (`removed ? 1 : 0` sort key). No visual divider — sorting alone conveys the grouping, and it sidesteps the stray-divider edge case for all-removed levels.

### D6: Route guard widens "exists" to registry ∪ events — at the workflow level only

`GET /invocations/:owner/:repo/:workflow` validation becomes: the workflow is valid if in the registry OR `SELECT 1 FROM events WHERE owner/repo/workflow LIMIT 1` returns a row. A workflow in neither still `404`s. This is a cheap existence probe, distinct from D3's set query.

The `:trigger` segment is deliberately **not** separately validated — and never was. It only narrows the query (`WHERE workflow = ? AND name = ?`), rendering an empty list when nothing matches. Adding a trigger-level existence probe on the `name` column would wrongly `404` `trigger.exception` / `trigger.rejection` history, because those events stamp the trigger declaration name into `input.trigger`, not `name` (the `name` column holds the failure cause). So a removed/renamed trigger stays navigable whenever its owning workflow resolves; its `trigger.request` rows return via the existing name filter. Safe: owner-membership is enforced upstream, so widening "exists" to include the member's own history confirms nothing to a non-member and preserves the enumeration-prevention `404` for a truly-unknown workflow.

### D7: Row marking is free for trigger rows; `system.upload` rows excluded

`fetchInvocationRowsForScopes` already calls `lookupTriggerKind(registry, …)` per row; it returns `undefined` exactly when the `(workflow, trigger)` pair is not a live trigger (`middleware.tsx:106-112`). Today that `undefined` is discarded. We promote it to an explicit removed state on the row, rendered with the same archive box + muted treatment as the tree — no new query. `system.upload` rows are excluded: their `name` is the *workflow* name, so `lookupTriggerKind` returns `undefined` even for live workflows (false positive); the archive boxd workflow node in the tree already conveys removed-workflow awareness.

## Risks / Trade-offs

- **Extra DB round-trip on every invocations page render (D3)** → The distinct query is indexed on `(owner, repo)` and returns only deduped tuples (cardinality ≈ trigger names ever seen, not runs). If it ever shows up as slow, cache per `(owner, repo)` invalidated on upload/prune — deferred until measured.
- **Renamed trigger shows as two nodes** → Accepted and documented; matches the "no stable identity" non-goal. The old node is muted, so the live one stays visually dominant.
- **Inferred removed status can flip on upload** → A re-added trigger name silently becomes live again (its old rows rejoin the live node). This is correct behaviour, but means removed status is a function of *current* registry, not history — documented so it is not mistaken for a bug.
- **Sentinel `kind: "removed"` collides with a future real kind** → Mitigation: trigger kinds are a closed SDK set (http/cron/manual/imap/ws/upload); `"removed"` is reserved in the registry the same way `upload` is, and guarded by a test asserting it is never produced by a live trigger descriptor.
- **`undefined`-kind rows have an existing fallback render** → Verify the current row renderer has no silent fallback icon for undefined kind that the archive box would mask; covered by a render test.

## Migration Plan

No data migration — purely additive read behaviour over existing immutable events. No manifest, schema, or EventBus-consumer change. Rollback is reverting the code; historical events are untouched throughout. Ships behind no flag; the only externally observable behaviour changes are (a) previously-`404`ing removed URLs now `200`, and (b) new tree nodes/row markers — both additive.

## Open Questions

(none — all design branches resolved during exploration)
