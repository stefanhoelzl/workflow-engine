## Context

The invocations list (`/invocations`) renders a flat list of rows backed by the `EventStore`. Each row is one invocation. Real invocations (a `trigger.request` paired with a `trigger.response` or `trigger.error`) are rendered as `<details>` elements that fetch a flamegraph fragment via htmx on first expand. Three other row kinds — single-leaf rows produced host-side, bypassing the sandbox — render today as non-expandable rows:

- `trigger.exception` — server-internal trigger setup failures (IMAP misconfig, HTTP response-header strip). Author/operator concern, not workflow author concern.
- `trigger.rejection` — HTTP webhook body schema validation rejected the caller's payload. Caller bug; the workflow never ran. The persisted `input` carries `{trigger, issues, method, path}` — body is intentionally omitted (`http.ts:262`, "caller bodies are untrusted and may carry PII").
- `system.upload` — a workflow bundle was uploaded. Audit trail. The persisted `meta` carries dispatch user info and `workflowSha`.

Each of these rows surfaces a single inline tooltip via the row's pill `<title>`: a one-issue summary for rejection, a setup-failure cause for exception, and an uploader login for upload. Anything beyond the tooltip's first field is unreachable from the UI.

The flamegraph endpoint (`GET /invocations/:owner/:repo/:id/flamegraph`) is the existing fragment-loading sibling. For synthetic single-leaf rows, `computeLayout` returns `null` (no `trigger.request` to anchor a paired-bar layout) and the handler falls through to `FlameEmpty` ("No flamegraph available for this invocation."). The `Single-leaf invocation flamegraph renders the leaf event` requirement in `invocations-list-view/spec.md` describes an instant-marker view for synthetic rows, but it is paper-only: no code path emits markers without a layout, no test covers it, and the row affordance that would trigger the fetch is not present.

## Goals / Non-Goals

**Goals:**

- Make `trigger.rejection` and `system.upload` rows inspectable in-page without dropping into the EventStore.
- Reuse the existing htmx+`<details>` pattern (no new client-side framework code, no new style of fragment loader).
- Keep the rejection/upload pill `<title>` tooltip — it's the at-a-glance summary; expansion is the deep dive.
- Tighten the spec/code drift around the unimplemented instant-marker requirement.

**Non-Goals:**

- Make `trigger.exception` rows expandable. They surface server-internal failures (e.g. IMAP misconfig, HTTP response-header strip) that are operator concerns, not workflow-author concerns. The existing tooltip on the "trigger setup failed" pill is sufficient. Out of scope.
- Replace the flamegraph view for real rows. The flamegraph endpoint is unchanged for rows that have a paired `trigger.request`.
- Add deep-linking / URL-hash auto-expand. The hash anchor on the row is preserved; the user clicks to expand.
- Curate the rendered payload per kind. The fragment renders the EventStore row losslessly as a single JSON tree.
- Touch `demo.ts`. The existing canonical webhook with a strict zod body produces `trigger.rejection` rows on demand for dev-probes; no SDK surface is changing.

## Decisions

### Decision 1 — separate `/event` endpoint, not a polymorphic `/flamegraph`

Two endpoint shapes were considered:

- **A. Polymorphic `/flamegraph`** — extend the existing handler to render an event-detail fragment when the row is single-leaf, paired-bar otherwise.
- **B. New `/event` endpoint** — sibling to `/flamegraph`, restricted to single-leaf rejection/upload rows.

We picked **B**. Reasons:

- The two fragments have nothing in common visually (paired-bar SVG vs JSON tree). Polymorphism on `/flamegraph` would be branching in the handler with two unrelated render paths sharing a route only by accident.
- Per-route 404 semantics stay clean: `/flamegraph` says "this id has no paired-bar layout", `/event` says "this id has no inspectable single-leaf event". Polymorphism would muddy both.
- The row's `hx-get` URL is a natural per-kind dispatch point (`page.tsx` already branches `noFlamegraph`); generating two URLs is trivial.

### Decision 2 — 404 for `/event` on non-eligible ids; 404 for `/flamegraph` on synthetic ids

Three options for `/event` on non-eligible ids (real paired row, `trigger.exception`, unknown id, non-member):

- **404 Not Found** — matches the existing fail-closed pattern (spec L112). Treats "non-eligible kind" identically to "not a member" — no enumeration leak about which ids are which kind.
- **400 Bad Request** — distinguishes "you asked the wrong endpoint", but leaks "id exists but isn't synthetic".
- **200 + empty fragment** — silently degrades; htmx swap target ends up empty, user sees no signal.

We picked **404**. The same reasoning applies to `/flamegraph` for synthetic rows: today it returns `FlameEmpty`, but no internal caller reaches that branch (the row's affordance is not present). After the split, internal callers never request flamegraph for synthetic rows either (the row's `hx-get` points at `/event`). 404 surfaces accidental cross-wiring during the migration and keeps the two endpoints' enumeration semantics symmetric. `FlameEmpty` is removed from the synthetic-row path; the SVG-shaped fragment for paired-bar rows still renders the empty SVG when layout is null for non-synthetic reasons (defensive — no real row should hit this).

### Decision 3 — lossless JSON tree, not a curated per-kind payload

Two payload shapes were considered:

- **Lossless** — fragment renders the full EventStore row as a single `wfeRenderJsonTree`. Author can copy/correlate against raw EventStore queries.
- **Curated** — per-kind allowlist (`{kind, name, at, id, input}` for rejection, `{kind, name, at, id, meta}` for upload). Guards against forward EventStore growth leaking through.

We picked **lossless**. Rationale:

- The forward-leak risk (someone adds a column thinking it's internal, doesn't realize this endpoint dumps it) is governed by the EventStore schema (`event-store.ts` owns the columns) and SECURITY.md §2 — adding a column with sensitive content trips multiple gates regardless of this endpoint.
- The current rows are already designed to be UI-renderable: `trigger.rejection.input` deliberately omits caller body (untrusted, may carry PII per `http.ts:262`); `system.upload.meta.dispatch.user` is the existing authoritative author of the dispatch chip's tooltip and is rendered in plain text on every upload row.
- Lossless keeps the fragment renderer trivial: query → JSON tree → done. One scenario per kind asserts the *presence* of the kind-specific fields a user expects (so a regression that drops `input.issues` from rejection rows is caught), without the spec freezing the exact column list.

### Decision 4 — fetch on toggle (htmx), not inline at page render

Synthetic rows are sparse, but the EventStore row payload (lossless `meta`/`input`) can be larger than a tooltip on the page-render path. Inline-at-render would inflate the page response for rows that the user never expands. The existing flamegraph fragment pattern is well-trodden (`hx-trigger="toggle once"`, `hx-target="find .flame-slot"`, `hx-swap="innerHTML"`); we mirror it. Cache wins are the same: a row that's been expanded once is not re-fetched.

### Decision 5 — remove the `Single-leaf invocation flamegraph renders the leaf event` requirement

Verified unimplemented (see `proposal.md` for the verification trace). The new event-detail fragment supersedes the "render an instant marker on the flamegraph endpoint" idea. Rather than retain a forward-compat requirement we no longer want to honor, we excise it as `## REMOVED Requirements` with a `Migration` pointer to the new event-detail fragment.

## Risks / Trade-offs

- **Lossless rendering surface area** → Mitigation: covered by EventStore schema governance (§2 of SECURITY.md). The endpoint is one more reason to keep that governance honest. If a future column is added that *should not* be UI-visible, the guard is at the schema, not at this endpoint.
- **Spec churn (four MODIFIED requirements + one REMOVED)** → Mitigation: each MODIFIED block reproduces the full requirement to keep the archive process honest. The reviewer can diff old → new line-by-line.
- **Asymmetry in synthetic-row UX (rejection/upload expand, exception does not)** → Mitigation: documented in proposal "Why" and in the modified `Single-leaf … render inline` requirement so the asymmetry is intentional, not accidental. If `trigger.exception` ever grows into an author-actionable kind, a follow-up change can extend `/event` to cover it (the route's eligibility check is the only gate).
- **`hx-get` targets a different URL per row kind** → Mitigation: `page.tsx` already has `noFlamegraph` per-row branching; the URL chosen on `<details>` becomes a one-line ternary alongside the existing logic. Tested in `middleware.test.ts` by asserting the rendered `hx-get` attribute matches the row's kind.

## Migration Plan

No data migration. No deploy gate beyond the standard CI checks.

- Pre-merge: `pnpm validate` (lint + check + test) + `pnpm test:e2e` is not required (no runtime spawn / persistence / SDK surface change).
- Post-merge: ships with the next routine deploy. Already-emitted rejection/upload rows in the EventStore become inspectable immediately (they have full `input`/`meta` columns persisted; only the UI was omitting them).
- Rollback: revert the PR. No schema changes. Existing rows continue to render; users lose the expand affordance on rejection/upload until a forward-fix.
