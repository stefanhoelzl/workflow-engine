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

#### Scenario: Invalid upload preserves existing workflow (all-or-nothing)

- **WHEN** tenant "acme" exists in the registry with workflow "foo"
- **AND** a new upload for tenant "acme" fails validation (e.g., missing module referenced from the manifest) or fails backend `reconfigure` (user-config or infra error)
- **THEN** the existing tenant state SHALL remain unchanged (see `workflow-registry/spec.md` "Register returns a failure result on validation error")
- **AND** the runtime SHALL log the failure reason
- **AND** the previously persisted tarball (if any) SHALL remain unchanged on the storage backend

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

### Requirement: Upload handler rejects manifests containing secretBindings

The upload handler SHALL reject any uploaded bundle whose manifest contains a `secretBindings` field. `secretBindings` is an intermediate build-artifact field consumed and dropped by the CLI during `wfe upload`; the server-side `ManifestSchema` SHALL NOT accept it.

Response on such uploads SHALL be 422 with `{ "error": "invalid manifest: secretBindings must be consumed by wfe upload before POST" }` (or an equivalent descriptive message). The existing `ManifestSchema` validation path handles this by rejecting the out-of-schema field.

#### Scenario: Upload with secretBindings is rejected

- **GIVEN** a raw bundle whose manifest still contains `secretBindings: ["TOKEN"]` (i.e., the CLI sealing step was skipped)
- **WHEN** `POST /api/workflows/:tenant` receives it
- **THEN** the response SHALL be 422
- **AND** the body SHALL name the extraneous `secretBindings` field

#### Scenario: Upload with secrets but no secretBindings is accepted

- **GIVEN** a bundle whose manifest has `secrets` and `secretsKeyId` but NO `secretBindings`
- **WHEN** the upload is submitted
- **THEN** the handler SHALL accept the bundle (per the secrets-crypto-foundation upload decrypt-verify flow)

#### Scenario: Upload with neither field is accepted

- **GIVEN** a bundle whose manifest has neither `secrets`, `secretsKeyId`, nor `secretBindings` (no secrets used)
- **WHEN** the upload is submitted
- **THEN** the handler SHALL accept the bundle per existing behavior

### Requirement: Upload handler decrypt-verifies manifest.secrets

On each workflow upload, for every workflow whose manifest entry contains a `secrets` field, the upload handler SHALL decrypt-verify each ciphertext before accepting the bundle. For each `(envName, base64Ciphertext)` entry in `manifest.secrets`:

1. Look up the secret key via `keyStore.lookup(manifest.secretsKeyId)`.
2. If the lookup returns undefined, respond 400 with `{ error: "unknown_secret_key_id", tenant, workflow: <name>, keyId: <manifest.secretsKeyId> }`.
3. Attempt `crypto_box_seal_open(base64.decode(ciphertext), pk, sk)`.
4. If decryption fails (returns null), respond 400 with `{ error: "secret_decrypt_failed", tenant, workflow: <name>, envName }`.

The handler SHALL NOT persist the plaintext; decryption results are discarded after verification. The handler SHALL NOT write the bundle to storage or register it until all secrets across all workflows in the upload have been verified.

Errors SHALL be reported for the first failing secret encountered; the handler MAY short-circuit on first failure.

#### Scenario: Upload with valid secrets succeeds

- **GIVEN** a manifest with `secrets: {TOKEN: <valid-ciphertext-for-primary-pk>}` and `secretsKeyId: <primary-keyId>`
- **WHEN** the upload is submitted
- **THEN** decrypt-verify SHALL succeed
- **AND** the upload SHALL proceed to the normal registration path
- **AND** the response SHALL be 204

#### Scenario: Upload with unknown keyId is rejected

- **GIVEN** a manifest with `secretsKeyId: "unknownkeyid12345"` (not in the runtime's keystore)
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400
- **AND** the body SHALL be `{ "error": "unknown_secret_key_id", "tenant": <t>, "workflow": <name>, "keyId": "unknownkeyid12345" }`

#### Scenario: Upload with corrupted ciphertext is rejected

- **GIVEN** a manifest with `secrets: {TOKEN: <invalid-b64-or-bad-ciphertext>}` and a valid `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400
- **AND** the body SHALL be `{ "error": "secret_decrypt_failed", "tenant": <t>, "workflow": <name>, "envName": "TOKEN" }`

#### Scenario: Upload with ciphertext sealed by a different (non-resident) public key is rejected

- **GIVEN** a manifest with a ciphertext sealed by an X25519 public key whose corresponding sk is not in the keystore, and `secretsKeyId` pointing to a resident key (mismatch)
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400 with `secret_decrypt_failed`

#### Scenario: Upload without secrets is unaffected

- **GIVEN** a manifest without `secrets` or `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the decrypt-verify pass SHALL be skipped
- **AND** the upload proceeds per existing behavior

#### Scenario: Upload with secrets but missing secretsKeyId is rejected at manifest validation

- **GIVEN** a manifest with `secrets: {...}` but no `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 422 at the existing ManifestSchema validation pass (before decrypt-verify runs)

#### Scenario: Plaintext is not persisted

- **GIVEN** a successful decrypt-verify pass
- **WHEN** the handler completes
- **THEN** no file on disk, state key, or log entry SHALL contain the plaintext bytes
- **AND** the decrypted bytes SHALL be zero-cleared or dropped out of scope before handler return

### Requirement: Upload handler emits system.upload per workflow with sha-based dedup

After `WorkflowRegistry.registerOwner()` succeeds for an upload, the upload handler SHALL emit one `system.upload` event per workflow in the bundle, subject to sha-based dedup: an event SHALL be emitted for a given `(owner, repo, workflow.name, workflow.sha)` ONLY if no `system.upload` event with that exact tuple already exists in the EventStore.

For each workflow the handler SHALL:

1. Query the EventStore for `kind = 'system.upload' AND owner = ? AND repo = ? AND workflow = ? AND workflowSha = ?`. If a row exists, skip the workflow.
2. Otherwise emit an `InvocationEvent` with `kind: "system.upload"`, `name: <workflow.name>`, fresh `id` matching `^evt_[A-Za-z0-9_-]{8,}$` (also serving as `invocationId`), `seq: 0`, `ref: 0`, `ts: 0`, `at: new Date().toISOString()`, `owner`, `repo`, `workflow: workflow.name`, `workflowSha: workflow.sha`, `input: <per-workflow manifest sub-snapshot>`, `meta.dispatch: {source: "upload", user: <authenticated user from request context>}`.

The handler SHALL emit events sequentially in manifest order. Emission failures (bus consumer rejection on a strict consumer) follow the same crash-on-durability-failure semantics as any other strict-consumer emission per the bus contract; no per-workflow rollback is required.

The handler SHALL NOT emit `system.upload` events on `415` (invalid archive) or `422` (manifest validation failure) responses — events are emitted only after a successful registration.

#### Scenario: First upload of a (workflow, sha) emits a system.upload event per workflow

- **GIVEN** a successful upload to `(owner: "acme", repo: "billing")` containing two workflows: `demo @ sha abc123` and `report @ sha def456`, neither previously seen
- **WHEN** the handler completes registration successfully
- **THEN** the EventStore SHALL gain exactly two new `system.upload` events
- **AND** one event SHALL have `name: "demo"`, `workflowSha: "abc123"`
- **AND** the other SHALL have `name: "report"`, `workflowSha: "def456"`
- **AND** both events SHALL carry `meta.dispatch = {source: "upload", user: <session user>}`

#### Scenario: Re-upload of identical bytes emits no events

- **GIVEN** a previously-recorded `system.upload` event for `(acme, billing, demo, abc123)` and `(acme, billing, report, def456)`
- **WHEN** the same user re-uploads the same bundle
- **THEN** the EventStore SHALL gain ZERO new `system.upload` events

#### Scenario: Mixed re-upload emits only changed workflows

- **GIVEN** a previously-recorded `system.upload` event for `(acme, billing, demo, abc123)` only
- **WHEN** a re-upload arrives where `demo` is unchanged at `abc123` and `report` is newly present at `def456`
- **THEN** the EventStore SHALL gain exactly one new event with `name: "report"`, `workflowSha: "def456"`
- **AND** SHALL NOT gain a new event for `demo`

#### Scenario: Failed upload emits no system.upload event

- **GIVEN** a request whose archive is invalid gzip
- **WHEN** the handler returns `415`
- **THEN** the EventStore SHALL gain ZERO `system.upload` events

#### Scenario: Manifest validation failure emits no system.upload event

- **GIVEN** a request whose manifest fails `ManifestSchema` validation
- **WHEN** the handler returns `422`
- **THEN** the EventStore SHALL gain ZERO `system.upload` events
