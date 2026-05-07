## ADDED Requirements

### Requirement: Event-detail fragment endpoint

The runtime SHALL expose `GET /invocations/:owner/:repo/:id/event`. The endpoint SHALL validate `:owner` and `:repo` against their respective regexes, enforce owner-membership via the shared authorization middleware, and read the invocation's events via `eventStore.query([{owner, repo}]).where('id', '=', id).orderBy('seq', 'asc').execute()`. The endpoint SHALL return an HTML fragment (not a full page shell) containing the persisted EventStore row rendered as a single collapsible JSON tree using the shared client-side renderer (`window.wfeRenderJsonTree`, defined by `/static/json-tree.js`).

The endpoint SHALL render the row losslessly: every column persisted by the EventStore for that row SHALL appear in the JSON tree (no per-kind field filtering applied at the endpoint).

The endpoint SHALL return `404 Not Found` when:
- The supplied `(owner, repo)` is not registered, or
- The user is not a member of `owner`, or
- No invocation with `id` exists under `(owner, repo)`, or
- The invocation's only event is not of kind `trigger.rejection` or `system.upload` (i.e. the row is a real paired-bar invocation, a `trigger.exception`, or any other kind).

All four cases SHALL produce the same fail-closed `404` response shape — the endpoint SHALL NOT distinguish "wrong kind" from "non-member" in the response, preserving the enumeration-prevention pattern used by the other scoped routes.

#### Scenario: Event-detail fragment for a rejection row renders the persisted row as a JSON tree

- **GIVEN** an `(owner, repo) = (acme, foo)` with one `trigger.rejection` event whose `id = "evt_abc"`, `name = "http.body-validation"`, `input = {trigger: "webhook", issues: [{path: ["name"], message: "Required"}], method: "POST", path: "/webhooks/acme/foo/demo/webhook"}`
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/evt_abc/event`
- **THEN** the response status SHALL be `200 OK`
- **AND** the response body SHALL be an HTML fragment (no page shell)
- **AND** the fragment SHALL contain the `id`, `kind`, `name`, `at`, and `input` field labels rendered through `window.wfeRenderJsonTree`
- **AND** the rendered tree SHALL include `input.issues[0].path` and `input.issues[0].message` so the user can inspect every Zod issue, not only the first

#### Scenario: Event-detail fragment for an upload row renders dispatch user and workflowSha

- **GIVEN** an `(owner, repo) = (acme, foo)` with one `system.upload` event whose `id = "evt_xyz"`, `meta = {dispatch: {source: "upload", user: {login: "alice", mail: "alice@acme"}}, workflowSha: "abc12345"}`
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/evt_xyz/event`
- **THEN** the response status SHALL be `200 OK`
- **AND** the rendered tree SHALL include `meta.dispatch.user.login`, `meta.dispatch.user.mail`, and `meta.workflowSha`

#### Scenario: Event-detail fragment 404s for a real paired-bar invocation

- **GIVEN** a member of `acme` and an invocation `evt_real` under `(acme, foo)` whose events include a `trigger.request` and a paired `trigger.response`
- **WHEN** `GET /invocations/acme/foo/evt_real/event` is requested
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the response shape SHALL match the `404` returned for non-existent owner/repo

#### Scenario: Event-detail fragment 404s for a trigger.exception row

- **GIVEN** a member of `acme` and a single-leaf `trigger.exception` invocation `evt_exc` under `(acme, foo)`
- **WHEN** `GET /invocations/acme/foo/evt_exc/event` is requested
- **THEN** the response status SHALL be `404 Not Found`

#### Scenario: Event-detail fragment 404s for a non-member

- **GIVEN** a user who is NOT a member of `evil-corp`
- **WHEN** `GET /invocations/evil-corp/foo/evt_anything/event` is requested
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the response shape SHALL be identical to the `404` returned for a non-existent owner

## MODIFIED Requirements

### Requirement: Invocation rows are expandable into an inline flamegraph

Each rendered invocation row whose status is `succeeded` or `failed` SHALL provide an expand affordance. When activated, the affordance SHALL reveal:

- For real paired-bar invocations (rows with a `trigger.request` opening event): an inline flamegraph fragment loaded from `GET /invocations/:owner/:repo/:id/flamegraph`.
- For synthetic single-leaf rows of kind `trigger.rejection` or `system.upload`: an inline event-detail fragment loaded from `GET /invocations/:owner/:repo/:id/event` (see "Event-detail fragment endpoint").

Pending rows and synthetic `trigger.exception` rows SHALL NOT provide an expand affordance. Multiple rows MAY be expanded simultaneously (no accordion coordination).

The fragment SHALL be loaded on demand the first time a row is expanded, scoped to that row's own `(owner, repo)` rather than to the page-level filter — so a cross-scope view still resolves each row's fragment correctly. Subsequent toggles on a row that has already loaded its fragment SHALL NOT trigger a re-fetch.

#### Scenario: Terminal row's flamegraph is fetched from its own scope

- **GIVEN** a cross-scope `/invocations` request and a succeeded invocation `evt_abc` belonging to `(alice, utils)`
- **WHEN** the user expands the row for `evt_abc`
- **THEN** the runtime SHALL request the flamegraph fragment for `evt_abc` scoped to `(alice, utils)`, not to the page's current filter scope

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT include an expand affordance
- **AND** activating the row SHALL NOT trigger a flamegraph fetch

#### Scenario: trigger.exception row has no expand affordance

- **GIVEN** a synthetic `trigger.exception` invocation
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT include an expand affordance
- **AND** activating the row SHALL NOT trigger a fragment fetch

#### Scenario: trigger.rejection row expands to event-detail fragment

- **GIVEN** a synthetic `trigger.rejection` invocation `evt_rej` belonging to `(acme, foo)`
- **WHEN** the user expands the row for `evt_rej`
- **THEN** the runtime SHALL request `GET /invocations/acme/foo/evt_rej/event`
- **AND** the runtime SHALL NOT request a flamegraph fragment for `evt_rej`

#### Scenario: system.upload row expands to event-detail fragment

- **GIVEN** a synthetic `system.upload` invocation `evt_up` belonging to `(acme, foo)`
- **WHEN** the user expands the row for `evt_up`
- **THEN** the runtime SHALL request `GET /invocations/acme/foo/evt_up/event`
- **AND** the runtime SHALL NOT request a flamegraph fragment for `evt_up`

### Requirement: Flamegraph fragment endpoint

The runtime SHALL expose `GET /invocations/:owner/:repo/:id/flamegraph`. The endpoint SHALL validate `:owner` and `:repo` against their respective regexes, enforce owner-membership via the shared authorization middleware, and read the invocation's events via `eventStore.query([{owner, repo}]).where('id', '=', id).orderBy('seq', 'asc').execute()` and return an HTML fragment (not a full page shell).

The endpoint SHALL return `404 Not Found` when:
- The supplied `(owner, repo)` is not registered, or
- The user is not a member of `owner`, or
- The invocation has no `trigger.request` opening event (i.e. the row is a synthetic single-leaf row of kind `trigger.exception`, `trigger.rejection`, or `system.upload`).

All `404` cases SHALL share the same fail-closed response shape used by the other scoped routes (no enumeration distinction between "non-member" and "synthetic id").

#### Scenario: Flamegraph fragment requires scope in URL

- **WHEN** a request arrives at `GET /invocations/acme/foo/evt_abc/flamegraph` with a valid session for a member of `acme`
- **THEN** the endpoint SHALL return the flamegraph HTML fragment for invocation `evt_abc` scoped to `(acme, foo)`
- **AND** the response SHALL NOT include the page shell

#### Scenario: Flamegraph endpoint scoped by (owner, repo), not just owner

- **GIVEN** invocations `evt_abc` under `(acme, foo)` and `evt_abc` under `(acme, bar)` (same id, different scope — hypothetical)
- **WHEN** `GET /invocations/acme/foo/evt_abc/flamegraph` is requested
- **THEN** only the events belonging to `(acme, foo)` SHALL be rendered
- **AND** events from `(acme, bar)` SHALL NOT appear in the fragment

#### Scenario: Flamegraph endpoint 404s for synthetic single-leaf invocations

- **GIVEN** a member of `acme` and a synthetic invocation `evt_synth` under `(acme, foo)` whose only event is one of `trigger.exception` / `trigger.rejection` / `system.upload`
- **WHEN** `GET /invocations/acme/foo/evt_synth/flamegraph` is requested
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the response SHALL NOT include a "No flamegraph available" empty fragment

### Requirement: Expandable invocation rows carry an expand affordance

Invocation rows that are expandable (those with terminal status, i.e. `succeeded` or `failed`, plus synthetic `trigger.rejection` and `system.upload` rows) SHALL carry a visible expand affordance (e.g. a chevron glyph) that transitions to an "open" state when the row is expanded. Pending rows and synthetic `trigger.exception` rows, which are not expandable, SHALL NOT carry this affordance.

The affordance SHALL be driven by the native `[open]` state of the `<details>` element, so that no client-side JavaScript is required to keep it in sync with the row's open/closed state.

#### Scenario: Expandable row shows an expand affordance

- **GIVEN** a succeeded invocation row rendered as a `<details>` element
- **WHEN** the row is rendered in its closed state
- **THEN** the row's summary SHALL contain a visible affordance element (e.g. an element with a class signalling "expand")

#### Scenario: Affordance transitions on open

- **GIVEN** an expandable row whose affordance is styled to rotate on `[open]`
- **WHEN** the row is expanded
- **THEN** the affordance element SHALL be in its transformed state (per the CSS rule selecting `[open] > summary <affordance>`)

#### Scenario: Pending row carries no affordance

- **GIVEN** a pending invocation row
- **WHEN** the row is rendered
- **THEN** the row SHALL NOT contain the expand affordance

#### Scenario: trigger.exception row carries no affordance

- **GIVEN** a synthetic `trigger.exception` invocation row
- **WHEN** the row is rendered
- **THEN** the row SHALL NOT contain the expand affordance

#### Scenario: trigger.rejection and system.upload rows carry the affordance

- **GIVEN** a synthetic `trigger.rejection` row and a synthetic `system.upload` row in the rendered list
- **WHEN** the rows are rendered in their closed state
- **THEN** each row's summary SHALL contain a visible expand affordance element

### Requirement: Single-leaf trigger.exception invocations render inline

The invocations list SHALL render synthetic invocations consisting of a single leaf event (`trigger.exception`, `trigger.rejection`, or `system.upload`) inline alongside real handler-driven invocations, in the same flat list and obeying the same `(owner, repo)` filtering and pending-first / newest-started sort order. Single-leaf invocations have no pending phase and SHALL be sorted under the terminal-rows group, ordered by their `at` timestamp (which equals both `startedAt` and `completedAt` for synthetic invocations).

A synthetic-`trigger.exception` row SHALL display:

- The standard leading kind-icon, `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A wrench / settings glyph (or equivalent affordance distinct from the normal `failed` red indicator) and the label `"trigger setup failed"` accessible via `<title>`.
- NO dispatch chip.
- NO expand affordance — the row is not expandable. The `<title>` tooltip on the wrench glyph is the sole inspection surface for `trigger.exception` rows. (Server-internal trigger setup failures are an operator concern, not a workflow-author concern; the cause + optional stage + optional error message composed into the tooltip are sufficient.)

A synthetic-`trigger.rejection` row SHALL display:

- The standard leading kind-icon, `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A shield-cross glyph (or equivalent rejected-by-validation affordance distinct from both `failed`-red and the wrench setup-failed glyph) and the label `"trigger rejected"` accessible via `<title>`. The `<title>` SHALL additionally include a brief summary of the first issue's path + message for at-a-glance debuggability.
- NO dispatch chip.
- An expand affordance that, when activated, fetches an event-detail fragment from `GET /invocations/:owner/:repo/:id/event` (see "Event-detail fragment endpoint" and "Invocation rows are expandable into an inline flamegraph"). The fragment renders the full persisted event row as a JSON tree.

A synthetic-`system.upload` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields. The `trigger` field SHALL render as the literal `"upload"`.
- A leading kind-icon (upload arrow) rendered in the accent colour, occupying the same row slot every other invocation row uses for its trigger-kind icon. The leading icon SHALL be the only upload-kind glyph on the row — there SHALL NOT be a second upload glyph rendered on the right side of the row.
- NO `succeeded`/`failed`/`pending`/`uploaded` status badge. The leading kind-icon plus the right-side dispatch chip together convey the kind and outcome.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A `<title>` accessible on the leading kind-icon SHALL include `"workflow uploaded"` and `sha=<workflowSha-short>` for at-a-glance version identification.
- A dispatch chip with visible label `"UPLOAD"` (uppercase) positioned at the row's far right (replacing the status-badge slot). The chip's `<title>` SHALL carry the uploader's name and mail (from `meta.dispatch.user`).
- An expand affordance that, when activated, fetches an event-detail fragment from `GET /invocations/:owner/:repo/:id/event`. The fragment renders the full persisted event row as a JSON tree (including `meta.dispatch.user`, `meta.workflowSha`, and any other persisted columns).

For all three synthetic kinds, rows SHALL NOT carry a flamegraph link (single-leaf events have no paired-bar layout to graph) and SHALL NOT carry a dimension pill. The `trigger.rejection` and `system.upload` expand affordances target the event-detail endpoint, NOT the flamegraph endpoint.

#### Scenario: trigger.exception synthetic row renders wrench glyph

- **GIVEN** an `(owner, repo)` whose IMAP trigger has produced one synthetic invocation (single `trigger.exception` event with `name: "imap.poll-failed"`)
- **WHEN** `GET /invocations/<owner>/<repo>` is requested
- **THEN** the row SHALL render the wrench/settings glyph with `<title>` text including `"trigger setup failed"`
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL NOT render an expand affordance

#### Scenario: trigger.rejection synthetic row renders shield-cross glyph

- **GIVEN** an `(owner, repo)` whose HTTP trigger has produced one synthetic invocation (single `trigger.rejection` event with `name: "http.body-validation"` and one issue `{path: ["name"], message: "Required"}`)
- **WHEN** the invocations view is requested
- **THEN** the row SHALL render the shield-cross glyph with `<title>` text including `"trigger rejected"` and a summary of the first issue
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL render an expand affordance whose `hx-get` URL targets `/invocations/<owner>/<repo>/<id>/event`

#### Scenario: system.upload synthetic row renders accent leading icon and right-side UPLOAD chip

- **GIVEN** an `(owner, repo)` with one `system.upload` event for workflow `demo` at sha `abc12345`, dispatched by user `{name: "alice", mail: "alice@acme"}`
- **WHEN** the invocations view is requested
- **THEN** the row's leading icon slot SHALL render an upload-arrow glyph styled in the accent colour
- **AND** the leading icon SHALL carry a `<title>` containing `"workflow uploaded"` and `sha=abc12345`
- **AND** the row SHALL NOT render a `succeeded`/`failed`/`pending`/`uploaded` status badge
- **AND** the row SHALL render a dispatch chip with visible label `"UPLOAD"` (uppercase) positioned at the row's far right
- **AND** the dispatch chip's `<title>` SHALL contain `alice` and `alice@acme`
- **AND** the row SHALL render an expand affordance whose `hx-get` URL targets `/invocations/<owner>/<repo>/<id>/event`
- **AND** the row SHALL NOT render a second upload glyph anywhere outside the leading icon slot

#### Scenario: All three synthetic kinds have zero duration

- **GIVEN** any synthetic-row invocation
- **WHEN** the row is rendered
- **THEN** the duration SHALL render as `0` (or the minimal-unit zero rendering produced by the smart-unit formatter)

## REMOVED Requirements

### Requirement: Single-leaf invocation flamegraph renders the leaf event

**Reason**: This requirement was paper-only — it was never implemented. The flamegraph layout pipeline (`computeLayout` in `flamegraph.tsx`) returns `null` for any invocation that lacks a `trigger.request` opening event, and the SSR top-level renderer falls through to `FlameEmpty` ("No flamegraph available for this invocation."). No code path emits an instant marker for a synthetic single-leaf invocation, no test exercises it, and the row affordances that would have triggered the fetch were never present (`page.tsx` excluded all three synthetic kinds from `noFlamegraph`'s opposite). The new event-detail fragment endpoint (`GET /:owner/:repo/:id/event`) supersedes this requirement for the two user-relevant single-leaf kinds (`trigger.rejection`, `system.upload`); `trigger.exception` rows remain non-expandable by design (operator-internal failures, not author-actionable).

**Migration**: Consumers that anticipated an instant-marker rendering on the flamegraph endpoint for synthetic ids should instead expand the row (which now fetches the event-detail fragment) for `trigger.rejection` and `system.upload`, or rely on the existing pill `<title>` tooltip for `trigger.exception`. The flamegraph endpoint now returns `404 Not Found` for any synthetic single-leaf id (see the modified "Flamegraph fragment endpoint" requirement).
