# Action Upload Specification

## Purpose

Expose a per-tenant HTTP endpoint (`POST /api/workflows/<tenant>`) that accepts a gzipped tar archive of a workflow bundle, validates it against `ManifestSchema`, persists the tarball, registers every workflow in the tenant with the runtime (hot-reloading live event handling), and returns specific, machine-readable failure reasons on error. Tenant-authorization (identifier regex + `isMember` check) is gated by `requireTenantMember()` middleware before the upload handler runs.
## Requirements
### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows/<tenant>` endpoint that accepts a `application/gzip` body containing a tar.gz archive of a workflow bundle for the named tenant. The upload handler SHALL extract the archive into a file map and pass it to the `WorkflowRegistry` for validation, persistence, and registration. The archive SHALL contain at its root a `manifest.json` (of shape `{workflows: [...]}`) and per-workflow bundle files.

The `<tenant>` path parameter SHALL be validated by the `requireTenantMember()` middleware (see `auth` capability) BEFORE the upload handler runs: invalid tenant identifiers AND non-member users SHALL both receive `404 Not Found` with body `{error: "Not Found"}`. The upload handler SHALL NOT receive a request whose `<tenant>` has not been validated and authorized.

Error responses from the upload handler itself (after tenant authorization passes) SHALL include a JSON body. A `415` response SHALL include `{ "error": <string> }`. A `422` response SHALL include `{ "error": <string> }` where `<string>` is a specific reason for the failure (e.g., `missing manifest.json`, `missing workflow module: <path>`, or `invalid manifest: <details>`). When the `422` is caused by manifest validation failing `ManifestSchema`, the body SHALL additionally include `issues: Array<{ path: Array<string | number>, message: string }>` derived from the underlying Zod validation issues.

#### Scenario: Successful upload

- **WHEN** a valid tar.gz archive with a correct manifest and all referenced workflow module files is posted to `POST /api/workflows/<tenant>` with a valid auth token whose user passes the `isMember(user, tenant)` check
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** every workflow in the manifest SHALL be registered and available for event matching

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`
- **AND** the response body SHALL be `{ "error": "Not a valid gzip/tar archive" }`

#### Scenario: Manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL include `error` naming the specific failure
- **AND** when the failure is a `ManifestSchema` validation error, the response body SHALL include `issues: Array<{ path, message }>` reflecting the Zod validation issues

#### Scenario: Non-member tenant returns 404

- **GIVEN** `user = { name: "alice", orgs: [] }` on the request context
- **WHEN** `POST /api/workflows/victim` is requested (alice is not a member of the `victim` tenant)
- **THEN** the `requireTenantMember()` middleware SHALL respond with `404 Not Found` before reaching the upload handler
- **AND** the response body SHALL be `{"error": "Not Found"}`

#### Scenario: Invalid tenant identifier returns 404

- **WHEN** `POST /api/workflows/../etc/passwd` is requested
- **THEN** the `requireTenantMember()` middleware SHALL respond with `404 Not Found` indistinguishably from a non-member response

### Requirement: Hot reload after upload

After a successful upload, the WorkflowRegistry SHALL make the workflow available immediately. New events SHALL be matched against the updated action list. Actions already executing SHALL finish with the old code.

#### Scenario: New events match uploaded workflow

- **WHEN** workflow "foo" is uploaded with an action listening on event type "order.created"
- **AND** an "order.created" event is subsequently triggered
- **THEN** the scheduler SHALL execute "foo"'s action

#### Scenario: Replaced workflow takes effect immediately

- **WHEN** workflow "foo" is uploaded, replacing a previously uploaded "foo"
- **AND** an event matching "foo"'s action is triggered
- **THEN** the scheduler SHALL execute the new version's action code

#### Scenario: In-flight action completes with old code

- **WHEN** workflow "foo" is being replaced while an action from the old "foo" is executing
- **THEN** the in-flight action SHALL complete using the old code
- **AND** subsequent events SHALL use the new code

#### Scenario: Invalid upload removes existing workflow

- **WHEN** workflow "foo" exists in the registry
- **AND** a new upload for "foo" fails validation (e.g., missing action source)
- **THEN** the existing "foo" SHALL be removed from the registry
- **AND** the runtime SHALL log the removal with the error reason

### Requirement: Upload response classifies reconfigure failures

The `POST /api/workflows/<tenant>` upload handler SHALL classify reconfigure failures aggregated from the registered `TriggerSource` backends into distinct response categories:

- **Manifest validation failure** (Zod schema, unknown trigger kind, missing bundle file) → `422 Unprocessable Entity` with the existing body shape: `{error: <reason>, issues?: [...]}`. This category is detected before any backend's `reconfigure` is called. Unchanged from today.
- **User-config failure** (at least one backend returned `{ok: false, errors: [...]}` and no backend threw) → `400 Bad Request` with body `{error: "trigger_config_failed", errors: TriggerConfigError[]}` where `errors` is the flattened union of all backends' returned errors.
- **Backend-infra failure** (at least one backend threw during `reconfigure`) → `500 Internal Server Error` with body `{error: "trigger_backend_failed", errors: Array<{backend: string, message: string}>}` where each entry corresponds to a backend that threw.
- **Both user-config and backend-infra** — the response SHALL be `400` with both classes surfaced: `{error: "trigger_config_failed", errors: [...]}` containing the union of user-config errors, AND the response SHALL include a separate `infra_errors: Array<{backend, message}>` field for the thrown failures. User-facing (actionable) errors take the HTTP status precedence.

The upload handler SHALL NOT persist the tenant tarball when any of these failure categories applies (see `workflow-registry` spec: persist-on-full-success).

#### Scenario: Manifest-level failure unchanged

- **WHEN** the uploaded manifest fails `ManifestSchema` validation
- **THEN** the handler SHALL return `422` with `{error: "invalid manifest: …", issues: [...]}`
- **AND** no backend SHALL receive a `reconfigure` call
- **AND** the tarball SHALL NOT be persisted

#### Scenario: Manifest references unknown trigger kind

- **WHEN** the uploaded manifest contains a trigger with `type: "imap"` and no IMAP backend is registered
- **THEN** the handler SHALL return `422` with `{error: "invalid manifest: unsupported trigger kind 'imap'"}`
- **AND** no backend SHALL receive a `reconfigure` call
- **AND** the tarball SHALL NOT be persisted

#### Scenario: Backend returns user-config error

- **WHEN** reconfigure succeeds across the HTTP backend but the IMAP backend returns `{ok: false, errors: [{backend: "imap", trigger: "newMail", message: "authentication failed"}]}`
- **THEN** the handler SHALL return `400` with body `{error: "trigger_config_failed", errors: [{backend: "imap", trigger: "newMail", message: "authentication failed"}]}`
- **AND** the tarball SHALL NOT be persisted
- **AND** the HTTP backend's state SHALL remain at the new entries (partial success, documented non-guarantee)

#### Scenario: Backend throws infra error

- **WHEN** reconfigure succeeds for the HTTP backend but the IMAP backend throws `Error("connection reset")`
- **THEN** the handler SHALL return `500` with body `{error: "trigger_backend_failed", errors: [{backend: "imap", message: "connection reset"}]}`
- **AND** the tarball SHALL NOT be persisted

#### Scenario: Both user-config and infra errors

- **WHEN** one backend returns `{ok: false, errors: [userErr]}` and another backend throws `Error("infra")`
- **THEN** the handler SHALL return `400` (user-config takes precedence)
- **AND** the body SHALL contain both `errors: [userErr]` AND `infra_errors: [{backend: <name>, message: "infra"}]`
- **AND** the tarball SHALL NOT be persisted

#### Scenario: Successful upload persists

- **WHEN** all backends return `{ok: true}`
- **THEN** the handler SHALL persist the tarball via `StorageBackend.writeBytes("workflows/<tenant>.tar.gz", bytes)`
- **AND** the handler SHALL return `204 No Content`
- **AND** no error body SHALL be emitted

