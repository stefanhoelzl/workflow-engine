## Context

The list view at `/dashboard/*` is the operator's primary landing surface. It renders a flat list of invocations (real handler-driven, plus three synthetic kinds: `trigger.exception`, `trigger.rejection`, `system.upload`). Today the page name (`Dashboard`), the URL (`/dashboard`), the identifiers (`DashboardPage`, `dashboardMiddleware`, `DashboardFilter`), and the spec (`dashboard-list-view`) all use the legacy "dashboard" label even though no requirement, scenario, or feature in the spec is dashboard-shaped — they describe an invocations list. The view also accumulated three small visual inconsistencies that this change addresses together so they don't drift further: a sticky breadcrumb+h1 bar that duplicates context already on the page, an upload row that lacks the leading kind-icon every other row carries while wearing two redundant outcome labels (`upload` chip + `UPLOADED` status badge), and a sort key (`completedTs`) that disagrees with the timestamp shown on each row (`startedAt`).

Bundling the rename with the visual cleanup is deliberate: every test, spec, and route that touches the view will be edited once for the rename, and editing it twice (once per concern) would churn the same files. The blast radius is wide but shallow — almost entirely string substitutions plus a handful of CSS rule changes and a 2-line sort tweak.

## Goals / Non-Goals

**Goals:**

- Rename `dashboard` → `invocations` across URL prefix, identifiers, file paths, spec capability, and user-visible labels.
- Remove the sticky `.page-header` from the invocations view.
- Give synthetic `system.upload` rows the same visual contract as every other row (leading kind-icon in the identity slot), and collapse the redundant `UPLOAD` chip + `UPLOADED` status badge into a single right-side `UPLOAD` chip.
- Sort terminal rows by `startedTs` DESC so the rendered timestamp matches the sort order.
- Update the `dashboard-list-view` capability to `invocations-list-view` and propagate the URL change to every spec that names it.

**Non-Goals:**

- No backward-compat redirect from `/dashboard/*` → `/invocations/*`. Internal-only app, no external bookmarks expected.
- No change to the synthetic-kind discriminator strings (`system.upload`, `trigger.exception`, `trigger.rejection`) — these are events on the wire, not UI-internal labels. Renaming them would touch event-store / persistence surfaces and is out of scope.
- No change to the trigger view (`/trigger/*`) chrome. The recent fixed-tabbar refactor settled that surface; we do not extend the cleanup pass into it.
- No change to flamegraph rendering or to the per-row expand affordance contract.
- No SDK or sandbox-stdlib surface change. `workflows/src/demo.ts` is untouched.

## Decisions

### D1. Hard URL cutover, no redirect

`/dashboard/*` is removed; `/invocations/*` replaces it. No `301` redirect handler.

**Rationale**: The app is internal. Any consumer that has bookmarked `/dashboard` is a developer's browser, fixable with a single visit. A redirect would be dead code we'd later schedule for removal — strictly worse than a clean cut. (User confirmed.)

**Alternative rejected**: Keep `/dashboard/*` as a permanent alias. Doubles the public route surface and forces every test, spec, and CSP/auth matcher to handle two prefixes.

### D2. Capability rename via remove + add

The OpenSpec change deletes `dashboard-list-view` and adds `invocations-list-view`, rather than modifying `dashboard-list-view` in place.

**Rationale**: The capability *name* is changing, and OpenSpec deltas don't model a rename primitive — `MODIFIED` deltas leave the capability id untouched. Remove-and-add is the cleanest way to express "this capability is now called X" while still exercising the schema's normal validation. The new spec carries the renamed-and-amended requirements; the old spec disappears in the same change.

**Alternative rejected**: Leave the capability id as `dashboard-list-view` and only edit URLs in its requirements. Locks in a misleading id forever.

### D3. Leading upload icon as a `TriggerKindIcon` extension, not a sibling component

`buildUploadRow` sets `triggerKind: "upload"` on synthetic upload rows; `kindGlyph` in `icons.tsx` grows an `"upload"` case (the existing arrow shape from the current `<UploadIcon>`). CSS adds `.trigger-kind-icon--upload { color: var(--accent); }`.

**Rationale**: The leading-icon slot is already wired to `triggerKind`. Routing upload rows through the same pipeline keeps `CardSummary` free of `if (syntheticKind === "system.upload")` branches and gives every row a uniform identity-region shape. The accent-coloured variant is one CSS rule.

**Alternative rejected**: Render `<UploadIcon>` directly in `CardSummary` with a conditional. Adds a branch to the row renderer for one synthetic kind; future synthetic kinds would each accumulate their own branch.

### D4. Right-side `UPLOAD` chip replaces the status badge

The dispatch chip (`.entry-dispatch`) for `dispatch.source === "upload"` renders as uppercase `UPLOAD` and is positioned at the row's far right (the slot vacated by the deleted status badge). The `UPLOADED` status badge is dropped for upload rows. The right-side synthetic `<UploadIcon>` glyph is also dropped (its role moved to the leading slot).

**Rationale**: The leading accent icon plus the right-side chip already say "this is an upload" twice — adding `UPLOADED` as a status badge is a third repetition and adds visual noise. Keeping the chip (rather than the badge) preserves the existing blue/info colour family for upload rows, distinguishing them from green/red outcome rows. Pushing the chip to the far right uses a `margin-left: auto` rule analogous to the existing `.entry-header .badge { margin-left: auto }`.

**Alternative rejected**: Keep `UPLOADED` status badge on the far right and drop the chip. The status-badge palette is `pending` / `succeeded` / `failed`; introducing `uploaded` as a fourth status colour expands the badge palette and conflicts with the user's stated mental model ("the blue upload badge").

### D5. Sort by `startedTs` DESC

`sortInvocationRows` keeps the pending-first split, but sorts terminal rows by `startedTs` DESC instead of `completedTs` DESC.

**Rationale**: Each row displays `startedAt`; sorting on a different key produces visually-disordered lists when invocations have meaningfully different durations. `startedAt` is also the more useful operator-facing key — "what started most recently" — for live debugging. Sub-second skew between `startedTs` and `completedTs` is rarely visible in practice; the fix is to align the two.

**Alternative rejected**: Show `completedAt` and keep `completedTs` sort. Loses the "when did this fire" information without offering a benefit.

### D6. Page-header CSS deleted, not retained for other surfaces

`.page-header` was used only by the dashboard page in the runtime UI. The rule is deleted entirely from `workflow-engine.css`.

**Rationale**: Carrying dead CSS is precisely the kind of drift that creates the inconsistencies this change is fixing. If a future surface needs a sticky page header, it can re-introduce the rule with whatever shape it actually needs at that point.

## Risks / Trade-offs

- **[Risk]** `/dashboard` URL appears in CSP allowlists, `secure-headers.ts` referer matchers, and CI smoke tests beyond what `grep` surfaces in the runtime package. → **Mitigation**: The implementation pass runs `grep -rn '/dashboard\|dashboard-list-view\|DashboardPage\|dashboardMiddleware'` across the entire repo (including `infrastructure/`, `docs/`, `openspec/`, and `workflows/`) before declaring done; tasks list every hit.
- **[Risk]** OpenSpec `dashboard-list-view` is referenced by other specs (e.g. `invocations`, `trigger-ui`). Deleting the capability without fixing references would leave dangling links. → **Mitigation**: Tasks include a sweep of `openspec/specs/` for `dashboard-list-view` strings, updating each occurrence to `invocations-list-view` and each `/dashboard/...` URL to `/invocations/...` via `## MODIFIED Requirements` deltas.
- **[Risk]** `pnpm test:e2e` is gated separately and not in the default `pnpm validate`. A URL-prefix rename is exactly the class of change e2e covers. → **Mitigation**: tasks.md lists `pnpm test:e2e` as a required pre-push step (per CLAUDE.md guidance for changes touching authenticated UI routes).
- **[Trade-off]** Bundling rename + visual cleanup makes the diff larger and slightly harder to review than two sequential PRs. → Accepted because every file the rename touches is also a file the visual cleanup touches; splitting would force reviewers to re-read the same files twice.
- **[Risk]** The flamegraph fragment URL collapse (`/dashboard/:owner/:repo/invocations/:id/flamegraph` → `/invocations/:owner/:repo/:id/flamegraph`) drops the literal `invocations` segment that previously disambiguated. → **Mitigation**: The new prefix already names the surface; the segment was redundant. `Card`'s `flamegraphUrl` template is the only call site; tests follow.
