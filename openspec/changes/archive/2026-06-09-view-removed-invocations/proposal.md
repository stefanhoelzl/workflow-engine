## Why

Invocation events are immutable and keyed by `(workflow, name)` *strings*, while the `WorkflowRegistry` is swapped wholesale on every upload. When a workflow or trigger is renamed or removed, its run history is removed: still present in the EventStore and visible in the repo-wide flat list, but unreachable through the sidebar tree (built only from the registry) and un-navigable by URL (the `:workflow` segment 404s and the per-trigger query filters on the new name). Operators lose the ability to drill into the history of anything they have renamed or deleted — exactly when they often most need it (debugging a removal, auditing a renamed trigger).

## What Changes

- The invocations sidebar tree reconstructs removed/renamed workflows and triggers as real, clickable nodes by unioning the live registry with the distinct `(owner, repo, workflow, name)` pairs found in the EventStore. Removed nodes are rendered muted with a archive box icon and sunk below their live siblings.
- Removed nodes appear **only** on the `/invocations` surface. The `/trigger` and `/queue` trees stay registry-only and unchanged.
- A renamed trigger appears as two nodes — the old name (removed) and the new name (live). There is no stable-identity continuity; rename and remove are treated identically.
- The `:workflow[/:trigger]` route guard widens its definition of "exists" from *in registry* to *in registry OR present in the EventStore*, so removed-workflow/trigger URLs return `200` with their historical rows instead of `404`. A name absent from both still `404`s.
- Invocation rows whose trigger is no longer live are marked with the same archive box + muted treatment in the flat list. Synthetic `system.upload` rows are excluded from removed marking.
- A new `removed` kind glyph (archive box) is registered in the cross-surface trigger-kind icon registry, following the existing `upload`-kind precedent.

## Capabilities

### New Capabilities

(none — all changes modify existing capabilities)

### Modified Capabilities

- `invocations-list-view`: the `:workflow[/:trigger]` filter routes treat EventStore history as a valid existence source (removed workflow/trigger URLs return `200`, not `404`); invocation rows for no-longer-live triggers render an removed marker.
- `shared-layout`: the navigation sidebar, on the invocations surface only, reconstructs and marks removed (removed/renamed) workflows and triggers, sunk below live siblings; other surfaces remain registry-only.
- `ui-foundation`: the cross-surface trigger-kind icon registry gains an `removed` kind whose glyph is a archive-box shape and whose treatment is muted/de-emphasised.

## Impact

- **Code**: `packages/runtime/src/ui/sidebar-tree.tsx` (removed union, flags, sort, archive box leaf), `packages/runtime/src/ui/invocations/middleware.tsx` (global distinct-pairs query, route-guard relaxation, row removed flag from the existing `lookupTriggerKind` result), `packages/runtime/src/ui/icons.ts` (removed/archive-box glyph), and the trigger-kind CSS (muted variant) in `workflow-engine.css`.
- **EventStore**: one new read shape — a global `SELECT DISTINCT owner, repo, workflow, name` over the user's scopes (no new write path, no schema change); plus a cheap `SELECT 1 … LIMIT 1` existence probe for the route guard.
- **Security**: route-guard widening occurs *after* owner-membership enforcement, so it leaks nothing new; truly-nonexistent names still `404`. No sandbox-boundary, manifest, or EventBus-consumer changes.
- **Self-cleaning**: retention pruning removes an removed's last run, after which its node and rows disappear with no extra bookkeeping.
- **Docs**: `docs/ui-guidelines.md` kind/icon table gains the `removed` entry.
