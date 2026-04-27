## ADDED Requirements

### Requirement: trigger.rejection is a leaf event kind for HTTP body validation failures

The runtime SHALL define `trigger.rejection` as a leaf invocation event kind for caller-payload-validation failures on the HTTP webhook surface that occur *before* any handler runs. `trigger.rejection` is emitted host-side, has no paired `trigger.request`, and does not participate in `RunSequencer` frame pairing. It is distinct from `trigger.exception` semantically: `trigger.exception` carries author-fixable *setup* failures (bad cron schedule, IMAP misconfiguration); `trigger.rejection` carries a single rejected request whose root cause is the caller (or the author's body schema being too strict for the caller's payload).

`trigger.rejection` events SHALL carry: a `name` discriminator (e.g. `"http.body-validation"`); an `input` field with shape `{issues: Array<{path, message}>, method: string, path: string}`; no `output`, no `error`. The HTTP request body SHALL NOT be persisted on the event.

`trigger.rejection` events SHALL be emitted exclusively via the `executor.fail(owner, repo, workflow, descriptor, params)` method using the same `entry.exception` plumbing that `trigger.exception` uses, so the runtime stamping path is identical: `seq = 0`, `ref = 0`, `ts = 0`, `at = new Date().toISOString()` at emission, runtime-stamped `owner` / `repo` / `workflow` / `workflowSha` / `id`. The `meta.dispatch` field SHALL NOT appear on `trigger.rejection` events.

Synthetic-invocation reconstruction (see "Synthetic invocation record from a single trigger.exception event") SHALL apply to `trigger.rejection` events identically: a `trigger.rejection` event with a fresh `invocationId` and no preceding `trigger.request` produces a synthetic failed invocation record whose `error` is derived from the `input.issues` summary.

#### Scenario: trigger.rejection event has the documented shape

- **GIVEN** an HTTP webhook handler whose body schema rejects a caller's POST
- **WHEN** the resulting `trigger.rejection` event reaches a bus consumer
- **THEN** the event SHALL have `kind: "trigger.rejection"`, `name: "http.body-validation"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event's `input` SHALL contain `{issues: Array<{path, message}>, method, path}`
- **AND** the event SHALL NOT carry the request body
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: trigger.rejection has no paired trigger.request

- **GIVEN** an HTTP rejection event for `invocationId: "evt_xyz"`
- **WHEN** the EventStore lists events for that `invocationId`
- **THEN** the result SHALL contain exactly one event of kind `trigger.rejection`
- **AND** SHALL NOT contain any event of kind `trigger.request`, `trigger.response`, or `trigger.error`

### Requirement: system.upload event kind for workflow uploads

The runtime SHALL recognise a leaf event kind `system.upload` under the existing reserved `system.*` prefix. The kind represents a successful registration of one workflow at a specific `workflowSha` and SHALL carry:

```
kind: "system.upload"
name: <workflow name>
type: "leaf"
input: <per-workflow manifest sub-snapshot>
meta: { dispatch: { source: "upload", user: { name, mail } } }
```

`system.upload` events SHALL be emitted by the upload handler (`packages/runtime/src/api/upload.ts`) AFTER `WorkflowRegistry` registration succeeds, ONCE per workflow in the bundle, AND ONLY when no prior `system.upload` event with matching `(owner, repo, workflow, workflowSha)` already exists in the EventStore (sha-based dedup). Re-uploading identical bytes SHALL NOT produce a new event.

`system.upload` events SHALL NOT be emitted by:

- guest code or plugin code (the prefix is reserved for runtime-driven happenings)
- the executor's invocation path (uploads do not go through the sandbox)
- any path other than the upload handler

The runtime SHALL stamp `owner`, `repo`, `workflow`, `workflowSha`, `id` (a fresh `evt_…`), `kind`, `name`, `seq` (set to `0`), `ref` (set to `0`), `ts` (set to `0`), `at` (set to `new Date().toISOString()` at emission), and `meta.dispatch = {source: "upload", user}` populated from the authenticated request context.

Synthetic-invocation reconstruction (see "Synthetic invocation record from a single trigger.exception event") SHALL apply to `system.upload` events: each event produces a synthetic invocation record with `status: "succeeded"`, `result: {workflowSha}`, `startedAt = completedAt = at`, and an empty `error` field. The synthetic record's `trigger` field SHALL be the literal string `"upload"` for rendering purposes.

#### Scenario: First upload of a (workflow, sha) emits a system.upload event

- **GIVEN** an authenticated user uploads a bundle containing workflow "demo" at sha `abc123` to `(owner: "acme", repo: "billing")` for the first time
- **WHEN** the upload handler completes successfully
- **THEN** the EventStore SHALL contain exactly one new event with `kind: "system.upload"`, `name: "demo"`, `owner: "acme"`, `repo: "billing"`, `workflow: "demo"`, `workflowSha: "abc123"`
- **AND** the event SHALL carry `meta.dispatch = {source: "upload", user: {name, mail}}` populated from the request's authenticated session

#### Scenario: Re-upload with identical sha emits no new event

- **GIVEN** a `system.upload` event with `owner: "acme"`, `repo: "billing"`, `workflow: "demo"`, `workflowSha: "abc123"` already exists in the EventStore
- **WHEN** the same user re-uploads a bundle whose `demo` workflow still hashes to `abc123`
- **THEN** NO new `system.upload` event SHALL be inserted for `(acme, billing, demo, abc123)`

#### Scenario: Mixed re-upload emits only changed workflows

- **GIVEN** a bundle whose `demo` is unchanged at sha `abc123` (already recorded) and whose `report` is now at a fresh sha `def456`
- **WHEN** the upload completes
- **THEN** the EventStore SHALL gain exactly one new event with `name: "report"`, `workflowSha: "def456"`
- **AND** SHALL NOT gain a new event for `demo`

## MODIFIED Requirements

### Requirement: Synthetic invocation record from a single trigger.exception event

When the EventStore observes a `trigger.exception`, `trigger.rejection`, or `system.upload` event with a fresh `invocationId` and no preceding `trigger.request`, the invocation record builder SHALL construct a synthetic invocation record from the single leaf event. The record SHALL have:

- `id`: from `event.invocationId`
- `workflow`: from `event.workflow`
- `trigger`: from `event.name`-derived trigger name (or the literal `"upload"` for `system.upload` events)
- `input`: the empty object `{}` for `trigger.exception` and `trigger.rejection`; the per-workflow manifest sub-snapshot from `event.input` for `system.upload`
- `startedAt`: equal to `event.at`
- `completedAt`: equal to `event.at` (atomic terminal)
- `status`: `"failed"` for `trigger.exception` and `trigger.rejection`; `"succeeded"` for `system.upload`
- `error`: `event.error` (`trigger.exception`) or a derived summary of `event.input.issues` (`trigger.rejection`); absent for `system.upload`
- `result`: `{workflowSha: event.workflowSha}` for `system.upload`; absent for the other two

#### Scenario: Synthetic invocation reconstructed from a single trigger.exception event

- **GIVEN** the EventStore receives a single `trigger.exception` event with `invocationId: "evt_abc12345"`, `workflow: "ingest"`, `name: "imap.poll-failed"`, `at: "2026-04-26T10:00:00.000Z"`, `error: { message: "auth failed" }`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `id: "evt_abc12345"`, `workflow: "ingest"`, `input: {}`, `startedAt: "2026-04-26T10:00:00.000Z"`, `completedAt: "2026-04-26T10:00:00.000Z"`, `status: "failed"`, `error: { message: "auth failed" }`
- **AND** the record SHALL NOT have a `result` field

#### Scenario: Synthetic invocation reconstructed from a single trigger.rejection event

- **GIVEN** the EventStore receives a single `trigger.rejection` event with `invocationId: "evt_def67890"`, `workflow: "demo"`, `name: "http.body-validation"`, `input: {issues: [{path: ["name"], message: "Required"}], method: "POST", path: "/webhooks/local/demo/runDemo"}`, `at: "2026-04-26T11:00:00.000Z"`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `status: "failed"` and an `error` field summarizing the issues

#### Scenario: Synthetic invocation reconstructed from a single system.upload event

- **GIVEN** the EventStore receives a single `system.upload` event with `invocationId: "evt_uvw00001"`, `workflow: "demo"`, `workflowSha: "abc123"`, `name: "demo"`, `meta.dispatch: {source: "upload", user: {name: "alice", mail: "alice@acme"}}`, `at: "2026-04-26T12:00:00.000Z"`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `status: "succeeded"`, `result: {workflowSha: "abc123"}`, `trigger: "upload"`
- **AND** the record SHALL NOT have an `error` field

### Requirement: Dispatch provenance on trigger.request

Every `trigger.request` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. Every `system.upload` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "upload", user: { login: string, mail: string } }`.

- For `trigger.request`: `source` SHALL be `"trigger"` when the invocation was wired through a registered trigger backend (HTTP webhook POST at `/webhooks/*`, cron tick, future kinds). `source` SHALL be `"manual"` when the invocation was dispatched through the `/trigger/*` UI endpoint.
- For `system.upload`: `source` SHALL be `"upload"` and `user` SHALL be present (uploads are always authenticated; there is no anonymous upload path).
- For `trigger.request` with `source === "manual"`: `user` SHALL be present when the dispatching request carried an authenticated session (populated as `{ name, mail }`). For manual fires in open-mode dev without an authenticated session, `user` SHALL be populated with the sentinel `{ name: "local", mail: "" }`. `user` SHALL be absent for `source: "trigger"` dispatches.
- The `meta` container and the `dispatch` key it holds SHALL appear on `trigger.request` and `system.upload` events only. Other event kinds (`trigger.response`, `trigger.error`, `trigger.exception`, `trigger.rejection`, `action.*`, `system.request`, `system.response`, `system.error`, `system.call`, `system.exception`, `system.exhaustion`) SHALL NOT carry `meta.dispatch`.

The dispatch blob SHALL be stamped by the runtime, never by the sandbox or by plugin code. For `trigger.request`, stamping happens in `executor.sb.onEvent`. For `system.upload`, stamping happens in the upload handler's host-side emission path (uploads do not go through the sandbox). Both stamping sites SHALL assert on the kind to enforce the invariant.

Workflow handler code SHALL NOT see `meta.dispatch` — the `input` passed to the handler SHALL NOT include `dispatch`.

#### Scenario: External webhook POST produces source=trigger

- **GIVEN** an external caller sends `POST /webhooks/<owner>/<repo>/<workflow>/<name>` with a valid body
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Cron tick produces source=trigger

- **GIVEN** a cron trigger fires on schedule
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Authenticated UI fire produces source=manual with user

- **GIVEN** an authenticated user with session `{ name: "Jane Doe", mail: "jane@example.com" }` POSTs to `/trigger/<owner>/<repo>/<workflow>/<name>`
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`

#### Scenario: UI fire without a user omits dispatch.user

- **GIVEN** a test that mounts `/trigger/*` with a stub `sessionMw` that does not set `c.set("user", …)` so `c.get("user")` is undefined
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual" }` with no `user` field

#### Scenario: Workflow upload produces source=upload with user

- **GIVEN** an authenticated user `{ name: "alice", mail: "alice@acme" }` successfully uploads a bundle to `(owner: "acme", repo: "billing")`
- **WHEN** the upload handler emits a `system.upload` event for a workflow `demo`
- **THEN** the event SHALL carry `meta.dispatch = { source: "upload", user: { login: "alice", mail: "alice@acme" } }`

#### Scenario: Non-trigger non-upload events do not carry meta.dispatch

- **GIVEN** an invocation that emits `trigger.request`, `action.request`, `action.response`, and `trigger.response`
- **WHEN** the events are inspected
- **THEN** only `trigger.request` SHALL carry `meta.dispatch`
- **AND** `action.request`, `action.response`, and `trigger.response` SHALL NOT carry a `meta` field (or `meta` SHALL be empty of `dispatch`)

#### Scenario: Workflow handler input omits dispatch

- **GIVEN** a workflow handler bound to an HTTP trigger fired from the UI by a named user
- **WHEN** the handler runs with `payload` as its argument
- **THEN** `payload` SHALL contain `{ body, headers, url, method }` and SHALL NOT contain a `dispatch` field
