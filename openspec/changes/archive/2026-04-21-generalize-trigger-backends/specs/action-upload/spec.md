## ADDED Requirements

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
