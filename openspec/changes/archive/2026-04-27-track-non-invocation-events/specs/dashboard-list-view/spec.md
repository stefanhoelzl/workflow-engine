## ADDED Requirements

### Requirement: Sandbox-exhaustion dimension pill on failed invocation rows

When a `failed` invocation row is rendered, the renderer SHALL look up an associated `system.exhaustion` event (single row, matched by `invocationId`) and, if found, render a small dimension pill next to the `failed` status indicator. The pill SHALL display one of `CPU`, `MEM`, `OUT`, or `PEND` corresponding to the event's `name` field (`"cpu" | "memory" | "output" | "pending"`). The pill's `<title>` SHALL contain `budget=<value>` and (when present) `observed=<value>` from the event's `input` field, with units appropriate to the dimension (`ms` for cpu, `bytes` for memory/output, no unit for pending).

If no `system.exhaustion` event is associated with the invocation, the row SHALL render exactly as today (failed status only, no pill). The pill SHALL NOT be rendered for `succeeded` or `pending` rows.

The lookup SHALL be implemented as a LEFT JOIN against the `events` table on `(invocationId, kind = 'system.exhaustion')`, fetching at most one row per invocation. Memory-class breaches do not produce `system.exhaustion` events (per `invocations/spec.md`) and SHALL therefore not produce a pill — though the dimension `MEM` is reserved for forward compatibility if memory ever becomes a terminal-class breach.

#### Scenario: CPU-killed invocation renders CPU pill

- **GIVEN** a failed invocation whose terminal `trigger.error` was preceded by a `system.exhaustion` event with `name: "cpu"`, `input: { budget: 60000, observed: 60002 }`
- **WHEN** the row is rendered
- **THEN** a `CPU` pill SHALL appear next to the `failed` status
- **AND** the pill's `<title>` SHALL include `budget=60000ms` and `observed=60002ms`

#### Scenario: Output-bytes breach renders OUT pill

- **GIVEN** a failed invocation associated with `system.exhaustion { name: "output", input: { budget: 4194304, observed: 4194305 } }`
- **WHEN** the row is rendered
- **THEN** an `OUT` pill SHALL appear next to the `failed` status

#### Scenario: Pending-callables breach renders PEND pill

- **GIVEN** a failed invocation associated with `system.exhaustion { name: "pending", input: { budget: 100, observed: 101 } }`
- **WHEN** the row is rendered
- **THEN** a `PEND` pill SHALL appear next to the `failed` status

#### Scenario: Plain handler-throw failed row has no pill

- **GIVEN** a failed invocation whose terminal `trigger.error` has no preceding `system.exhaustion` event
- **WHEN** the row is rendered
- **THEN** NO dimension pill SHALL appear

## MODIFIED Requirements

### Requirement: Single-leaf trigger.exception invocations render inline

The dashboard invocation list SHALL render synthetic invocations consisting of a single leaf event (`trigger.exception`, `trigger.rejection`, or `system.upload`) inline alongside real handler-driven invocations, in the same flat list and obeying the same `(owner, repo)` filtering and pending-first / completed-newest sort order. Single-leaf invocations have no pending phase and SHALL be sorted under the completed-rows group, ordered by their `at` timestamp (which equals both `startedAt` and `completedAt` for synthetic invocations).

A synthetic-`trigger.exception` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A wrench / settings glyph (or equivalent affordance distinct from the normal `failed` red indicator) and the label `"trigger setup failed"` accessible via `<title>`.
- NO dispatch chip.

A synthetic-`trigger.rejection` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A shield-cross glyph (or equivalent rejected-by-validation affordance distinct from both `failed`-red and the wrench setup-failed glyph) and the label `"trigger rejected"` accessible via `<title>`. The `<title>` SHALL additionally include a brief summary of the first issue's path + message for at-a-glance debuggability.
- NO dispatch chip.

A synthetic-`system.upload` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields. The `trigger` field SHALL render as the literal `"upload"`.
- A status of `"uploaded"` (a third row status alongside `pending`/`succeeded`/`failed`).
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- An upload-arrow glyph and the label `"workflow uploaded"` accessible via `<title>`. The `<title>` SHALL additionally include `sha=<workflowSha-short>` for at-a-glance version identification.
- The dispatch chip SHALL render with visible label `"upload"` and `<title>` carrying the uploader's name and mail (from `meta.dispatch.user`).

For all three synthetic kinds, rows SHALL NOT carry a flamegraph link (single-leaf events have no paired-bar layout to graph) and SHALL NOT carry a dimension pill.

#### Scenario: trigger.exception synthetic row renders wrench glyph

- **GIVEN** an `(owner, repo)` whose IMAP trigger has produced one synthetic invocation (single `trigger.exception` event with `name: "imap.poll-failed"`)
- **WHEN** `GET /dashboard/<owner>/<repo>` is requested
- **THEN** the row SHALL render the wrench/settings glyph with `<title>` text including `"trigger setup failed"`
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: trigger.rejection synthetic row renders shield-cross glyph

- **GIVEN** an `(owner, repo)` whose HTTP trigger has produced one synthetic invocation (single `trigger.rejection` event with `name: "http.body-validation"` and one issue `{path: ["name"], message: "Required"}`)
- **WHEN** the dashboard is requested
- **THEN** the row SHALL render the shield-cross glyph with `<title>` text including `"trigger rejected"` and a summary of the first issue
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: system.upload synthetic row renders upload-arrow glyph and dispatch chip

- **GIVEN** an `(owner, repo)` with one `system.upload` event for workflow `demo` at sha `abc12345`, dispatched by user `{name: "alice", mail: "alice@acme"}`
- **WHEN** the dashboard is requested
- **THEN** the row SHALL render the upload-arrow glyph with `<title>` text including `"workflow uploaded"` and `sha=abc12345`
- **AND** the row's status SHALL render as `"uploaded"`
- **AND** the row SHALL render a dispatch chip with visible label `"upload"` and `<title>` containing `alice` and `alice@acme`
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: All three synthetic kinds have zero duration

- **GIVEN** any synthetic-row invocation
- **WHEN** the row is rendered
- **THEN** the duration SHALL render as `0` (or the minimal-unit zero rendering produced by the smart-unit formatter)

### Requirement: Single-leaf invocation flamegraph renders the leaf event

When a user expands a synthetic-row invocation (one of `trigger.exception`, `trigger.rejection`, `system.upload`) — to the extent the row exposes an expand affordance — the flamegraph fragment endpoint SHALL render an instant-marker representation of the single leaf event rather than attempting to render a paired-bar layout. The marker SHALL use a visual treatment consistent with other instant markers (see "Instant markers for single-record events") and SHALL carry a `<title>` containing the event's `kind` and `name` and (for `trigger.exception`) the `error.message` text or (for `trigger.rejection`) a brief summary of the first issue or (for `system.upload`) the `workflowSha`.

The flamegraph SHALL NOT attempt to render an `orphan` bar for a synthetic single-leaf invocation. The orphan-bar treatment is reserved for paired `*.request` events whose terminal is missing (engine-crashed invocations); single-leaf invocations have no opening request to orphan.

In the current implementation, `trigger.rejection` and `system.upload` rows do NOT expose a flamegraph expand affordance (per "Single-leaf trigger.exception invocations render inline" above). This requirement applies to `trigger.exception` rows today and is documented for forward consistency if expand affordances are extended to other single-leaf kinds.

#### Scenario: Expanded synthetic trigger.exception invocation renders an instant marker

- **GIVEN** a synthetic invocation whose only event is `{ kind: "trigger.exception", name: "imap.poll-failed", input: { stage: "search", failedUids: [] }, error: { message: "BAD UNKNOWN_KEYWORD" } }`
- **WHEN** the user expands the row and the flamegraph fragment is rendered
- **THEN** the rendered SVG SHALL contain an instant-marker element for the event
- **AND** the marker's `<title>` SHALL include `"trigger.exception"`, `"imap.poll-failed"`, and `"BAD UNKNOWN_KEYWORD"`
- **AND** the rendered SVG SHALL NOT contain any `<rect>` with the `orphan` class
