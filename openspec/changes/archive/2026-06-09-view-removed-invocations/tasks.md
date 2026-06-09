## 1. EventStore removed-pairs query

- [x] 1.1 Add a helper that runs a global `SELECT DISTINCT owner, repo, workflow, name` over a set of `(owner, repo)` scopes (no `limit`), filtered to `trigger.request` (the kind whose `name` column is the trigger declaration name). Reuse `EventStore.query(scopes)`; no schema change. → `ui/invocations/removed entities.ts: queryRemovedPairs`.
- [x] 1.2 Add a bounded existence probe used by the route guard: `SELECT id … WHERE owner=? AND repo=? AND workflow=? LIMIT 1`, returning a boolean (workflow-level; spans all kinds incl. synthetic). → `removed entities.ts: workflowHistoryExists`.
- [x] 1.3 Unit-test both: distinct query returns one row per pair regardless of run count + excludes non-`trigger.request`; existence probe true for any historical workflow (incl. `system.upload`), false otherwise. → `removed entities.test.ts`.

## 2. Removed trigger-kind glyph (ui-foundation)

- [x] 2.1 Register an `removed` kind in the trigger-kind icon registry (`icons.tsx`) with a archive box inline-SVG glyph following the icon-rendering invariants. → `RemovedIcon` + `kindGlyph` case.
- [x] 2.2 Add a `.trigger-kind-icon--removed` CSS rule (`--text-muted`, NOT the `upload` accent) in `workflow-engine.css`.
- [x] 2.3 Add the `removed` row to the kind/icon table in `docs/ui-guidelines.md`.
- [x] 2.4 Test: registry returns a distinct glyph for `"removed"`; assert no live trigger descriptor ever yields `"removed"`. → `sidebar-tree.test.tsx`.

## 3. Sidebar removed reconstruction (shared-layout)

- [x] 3.1 Extend `TriggerRef` (`kind` carries the `"removed"` sentinel) and `WorkflowGroup` (`removed?: true`); keep `buildSidebarData` a pure function with an optional `removedPairs` argument.
- [x] 3.2 In `buildSidebarData`, union registry data with `removedPairs` at repo, workflow, and trigger levels (`mergeRemovedPairs`); mark removed nodes; sink removed entities after live siblings at each level (no divider).
- [x] 3.3 Render removed trigger leaves with the archive-box glyph + muted class and removed workflow rows muted; all-removed repo takes the populated branch (event-derived repos via `ensureRepoGroups`).
- [x] 3.4 Pass `removedPairs` **only** on the `/invocations` route's sidebar build (`buildSidebarTree`); `/trigger` and `/queue` omit it and stay registry-only.
- [x] 3.5 Tests: removed trigger → removed leaf sorted after live; fully-removed workflow → removed repo child; renamed trigger → both leaves; event-only repo surfaced; no removed entities without pairs; active-state on removed URL; sentinel never on live trigger. → `sidebar-tree.test.tsx`.

## 4. Route-guard widening (invocations-list-view)

- [x] 4.1 Replace the registry-only `:workflow` check with "in registry OR `workflowHistoryExists`" (`workflowSegmentMissing` helper). **Decision:** the `:trigger` segment is NOT separately validated — it only narrows the query — because `trigger.exception`/`rejection` stamp the trigger name into `input.trigger`, not the `name` column, so a `name`-column probe would wrongly 404 valid history.
- [x] 4.2 Keep the `404` (enumeration shape) when the workflow is in neither registry nor events; membership stays enforced upstream before the probe.
- [x] 4.3 Tests: removed-workflow URL → 200 with history; removed-trigger URL → 200 with only its rows; garbage workflow → 404; (non-member 404 covered by existing auth-scoping suite). → `middleware.test.ts`.

## 5. Row removed marking (invocations-list-view)

- [x] 5.1 In `fetchInvocationRowsForScopes` + `buildSyntheticTriggerRow`, promote the existing `undefined` `lookupTriggerKind` result into `triggerKind: "removed"` + an `removed` flag (no new query).
- [x] 5.2 `system.upload` rows excluded (`buildUploadRow` keeps `triggerKind: "upload"`, never removed).
- [x] 5.3 Render removed rows with the archive box leading icon + `entry--removed` muted class, matching the sidebar.
- [x] 5.4 Confirmed the prior undefined-kind fallback was an empty icon span (`LeadingKindIcon`), now superseded by the archive box; covered by render tests.
- [x] 5.5 Tests: removed-trigger rows marked removed in the repo-wide list; live rows unaffected; upload rows never marked. → `middleware.test.ts`.

## 6. Validation & dev verification

- [x] 6.1 `pnpm validate` passes — lint 0, check 0, **1538 tests pass**, tofu fmt + validate ok.
- [x] 6.2 Dev probe — spawned `pnpm dev --random-port --kill`, parsed port from the `[READY]` marker (35713).
- [x] 6.3 Dev probe — created a real removed: fired `GET /webhooks/local-user/demo-repo/demo/ping` to seed history, then renamed `ping`→`pingRenamed` in `demo.ts` (hot-reload re-upload), then reverted `demo.ts` via `git checkout`.
- [x] 6.4 Dev probe — scraped `/invocations/local-user/demo-repo`: `pingRenamed` rendered as a live leaf, `ping` as `sidebar-trigger--removed` (archive box, tooltip "removed — no longer in current upload"), sunk below live; the historical ping row carried `entry--removed` + `trigger-kind-icon--removed`.
- [x] 6.5 Dev probe — `GET /invocations/local-user/demo-repo/demo/ping` (renamed trigger) → **200** with only its historical row; `GET /invocations/local-user/demo-repo/no-such-wf-xyz` (garbage workflow) → **404**.
- [x] 6.6 Killed the dev process tree; verified `demo.ts` reverted and the working tree holds only the intended change.
