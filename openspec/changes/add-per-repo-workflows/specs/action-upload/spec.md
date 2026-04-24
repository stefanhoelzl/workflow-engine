## MODIFIED Requirements

### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows/:owner/:repo` endpoint that accepts a `application/gzip` body containing a tar.gz archive of a workflow bundle. The `:owner` segment SHALL match the owner regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) and the `:repo` segment SHALL match the repo regex (`^[a-zA-Z0-9._-]{1,100}$`); requests whose path segments fail regex validation SHALL be rejected with `404 Not Found` identical to "owner does not exist" (enumeration prevention). The upload handler SHALL extract the archive into a file map and pass it to the WorkflowRegistry along with `(owner, repo)` from the path, for validation, persistence, and registration. The archive SHALL contain at its root a `manifest.json` and an `actions/` directory with `.js` action source files. The manifest SHALL NOT declare `owner` or `repo` fields; scope is derived solely from the URL path.

Error responses SHALL include a JSON body. A `415` response SHALL include `{ "error": <string> }`. A `422` response SHALL include `{ "error": <string> }` where `<string>` is a specific reason for the failure (e.g., `missing manifest.json`, `missing action module: <path>`, or `invalid manifest: <details>`). When the `422` is caused by manifest validation failing the `ManifestSchema`, the body SHALL additionally include `issues: Array<{ path: Array<string | number>, message: string }>` derived from the underlying Zod validation issues.

#### Scenario: Successful upload

- **WHEN** a valid tar.gz archive with a correct manifest and all referenced action files is posted to `POST /api/workflows/:owner/:repo` with a valid auth token and the authenticated user is a member of `owner`
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** the workflow SHALL be registered under `(owner, repo)` and available for event matching

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`
- **AND** the response body SHALL be `{ "error": "Not a valid gzip/tar archive" }`

#### Scenario: Manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL include `error` naming the specific failure (e.g., `missing manifest.json` or `invalid manifest: <message>`)
- **AND** when the failure is a `ManifestSchema` validation error, the response body SHALL include `issues: Array<{ path, message }>` reflecting the Zod validation issues

#### Scenario: Referenced action source file missing from archive

- **WHEN** the manifest references an action module `actions/handleFoo.js` but the archive does not contain that file
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL be `{ "error": "missing action module: actions/handleFoo.js" }` (or an equivalent specific message naming the missing path)

#### Scenario: Authorized user uploading to an owner they do not belong to

- **WHEN** an authenticated user uploads to `POST /api/workflows/:owner/:repo` where `owner` is not in the user's `orgs` list
- **THEN** the runtime SHALL respond with `404 Not Found` with no body distinguishing "no bundles here" from "you do not belong here"

#### Scenario: Sibling repo unaffected by upload

- **GIVEN** owner `acme` has existing bundles at `acme/foo` and `acme/bar`
- **WHEN** a new bundle is uploaded to `acme/foo`
- **THEN** `acme/bar`'s bundle SHALL remain intact in storage and the registry
- **AND** only `acme/foo`'s triggers SHALL be reconfigured

### Requirement: Hot reload after upload

After a successful upload, the WorkflowRegistry SHALL make the workflow available immediately. New events SHALL be matched against the updated action list. Actions already executing SHALL finish with the old code.

#### Scenario: New events match uploaded workflow

- **WHEN** workflow "foo" is uploaded under `(owner, repo)` with an action listening on event type "order.created"
- **AND** an "order.created" event is subsequently triggered for that `(owner, repo)`
- **THEN** the scheduler SHALL execute "foo"'s action

#### Scenario: Replaced workflow takes effect immediately

- **WHEN** workflow "foo" is uploaded under `(owner, repo)`, replacing a previously uploaded "foo" in the same `(owner, repo)`
- **AND** an event matching "foo"'s action is triggered
- **THEN** the scheduler SHALL execute the new version's action code

#### Scenario: In-flight action completes with old code

- **WHEN** workflow "foo" is being replaced in `(owner, repo)` while an action from the old "foo" is executing
- **THEN** the in-flight action SHALL complete using the old code
- **AND** subsequent events SHALL use the new code

#### Scenario: Invalid upload removes existing workflow from the repo

- **WHEN** workflow "foo" exists in the registry under `(owner, repo)`
- **AND** a new upload for `(owner, repo)` fails validation (e.g., missing action source)
- **THEN** the existing bundle for `(owner, repo)` SHALL be removed from the registry
- **AND** sibling repos under the same owner SHALL NOT be affected
- **AND** the runtime SHALL log the removal with the error reason

### Requirement: Upload response classifies reconfigure failures

The `POST /api/workflows/:owner/:repo` upload handler SHALL classify reconfigure failures aggregated from the registered `TriggerSource` backends into distinct response categories:

- **Manifest validation failure** (Zod schema, unknown trigger kind, missing bundle file) → `422 Unprocessable Entity` with the existing body shape: `{error: <reason>, issues?: [...]}`. This category is detected before any backend's `reconfigure` is called.
- **User-config failure** (at least one backend returned `{ok: false, errors: [...]}` and no backend threw) → `400 Bad Request` with body `{error: "trigger_config_failed", errors: TriggerConfigError[]}` where `errors` is the flattened union of all backends' returned errors.
- **Backend-infra failure** (at least one backend threw during `reconfigure`) → `500 Internal Server Error` with body `{error: "trigger_backend_failed", errors: Array<{backend: string, message: string}>}` where each entry corresponds to a backend that threw.
- **Both user-config and backend-infra** — the response SHALL be `400` with both classes surfaced: `{error: "trigger_config_failed", errors: [...]}` containing the union of user-config errors, AND the response SHALL include a separate `infra_errors: Array<{backend, message}>` field for the thrown failures. User-facing (actionable) errors take the HTTP status precedence.

The upload handler SHALL NOT persist the `(owner, repo)` tarball when any of these failure categories applies (see `workflow-registry` spec: persist-on-full-success).

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
- **THEN** the handler SHALL persist the tarball via `StorageBackend.writeBytes("workflows/<owner>/<repo>.tar.gz", bytes)`
- **AND** the handler SHALL return `204 No Content`
- **AND** no error body SHALL be emitted
