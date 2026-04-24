## MODIFIED Requirements

### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with an optional `StorageBackend` and a `Logger`. It SHALL own manifest validation, persistence, and in-memory metadata for all registered workflows across all `(owner, repo)` pairs. It SHALL NOT own sandboxes, `WorkflowRunner` objects, or any execution-side state; sandbox lifecycle is owned by the `SandboxStore` (see the `sandbox-store` capability), and invocation dispatch is owned by the `Executor`.

#### Scenario: Register a repo from a file map

- **WHEN** `registerOwner(owner, repo, files)` is called with a `Map<string, string>` containing `manifest.json` and the bundled workflow module files
- **THEN** the registry SHALL validate the manifest against `ManifestSchema`, verify each workflow's bundle file exists in the file map, persist the tarball to the storage backend (if configured and requested), and replace the in-memory metadata for `(owner, repo)` with the newly registered workflows
- **AND** it SHALL rebuild the derived HTTP trigger index scoped to `(owner, repo)`
- **AND** it SHALL return a `RegisterResult` with `ok: true` on success and `ok: false` with an error message on failure

#### Scenario: Register returns a failure result on validation error

- **WHEN** `registerOwner(owner, repo, files)` is called with an invalid or incomplete file map
- **THEN** the registry SHALL return `{ ok: false, error }` and SHALL log the reason
- **AND** the in-memory metadata for `(owner, repo)` SHALL remain unchanged

#### Scenario: Register replaces all workflows for the repo, not siblings

- **WHEN** `registerOwner(owner, repo, files)` is called with a new manifest
- **THEN** all existing workflow metadata for `(owner, repo)` SHALL be discarded and replaced
- **AND** metadata for other repos under the same `owner` SHALL remain unchanged
- **AND** the HTTP trigger index for `(owner, repo)` SHALL be rebuilt
- **AND** sandboxes held by the `SandboxStore` for `(owner, repo, oldSha)` keys SHALL NOT be disposed (see `sandbox-store`)

### Requirement: WorkflowRegistry exposes metadata lookup

The runtime SHALL provide a `WorkflowRegistry.lookup(owner, repo, method, path)` method that returns `{ workflow, triggerName, validator }` when a matching HTTP trigger exists for `(owner, repo, method, path)`, or `undefined` otherwise. The returned `workflow` SHALL be the parsed `WorkflowManifest`. The registry SHALL NOT expose a `WorkflowRunner` type, a `runners[]` array, or a `sandbox` reference on any returned value.

#### Scenario: Lookup returns the matching workflow and trigger

- **GIVEN** a repo with two workflows, one of which declares an HTTP trigger on `POST /orders`
- **WHEN** `registry.lookup(owner, repo, "POST", "/orders")` is called
- **THEN** the registry SHALL return `{ workflow, triggerName: "ordersWebhook", validator }`
- **AND** `workflow` SHALL be the `WorkflowManifest` that declared the trigger

#### Scenario: Lookup returns undefined on no match

- **WHEN** `registry.lookup(owner, repo, method, path)` is called with values that do not match any registered trigger for that `(owner, repo)`
- **THEN** the registry SHALL return `undefined`

#### Scenario: Lookup is scoped to (owner, repo)

- **GIVEN** repo `A` under owner `X` and repo `B` under owner `X` both register a workflow with an HTTP trigger on the same path
- **WHEN** `registry.lookup("X", "A", method, path)` is called
- **THEN** the registry SHALL return `A`'s workflow manifest, not `B`'s

#### Scenario: Lookup isolates across owners

- **GIVEN** repo `R` registered under both owner `X` and owner `Y` with different workflows at the same path
- **WHEN** `registry.lookup("X", "R", method, path)` is called
- **THEN** the registry SHALL return owner `X`'s workflow, not owner `Y`'s

### Requirement: Persist before rebuild

When a storage backend is configured, `register()` SHALL persist the workflow files to the storage backend before updating in-memory state. If persistence fails, the in-memory state SHALL NOT be updated.

#### Scenario: Successful persistence

- **WHEN** `register(files)` is called and the storage backend write succeeds
- **THEN** the files SHALL be written to `workflows/<owner>/<repo>.tar.gz` in the storage backend
- **AND** the in-memory workflow state SHALL be updated

#### Scenario: No storage backend

- **WHEN** `register(files)` is called and no storage backend is configured
- **THEN** the workflow SHALL exist only in memory
- **AND** it SHALL be lost on restart

### Requirement: Recover workflows from storage backend

The registry SHALL provide a `recover()` method that loads all `(owner, repo)` tarballs from the storage backend's `workflows/` prefix at startup and invokes `registerOwner` for each. Recovery SHALL scan keys matching `workflows/<owner>/<repo>.tar.gz` (two path segments after the `workflows/` prefix) and parse `owner` and `repo` from the key. Recovery SHALL use the same validation logic as `registerOwner`.

#### Scenario: Recover loads persisted repo tarballs

- **GIVEN** the storage backend contains `workflows/acme/foo.tar.gz` and `workflows/acme/bar.tar.gz` and `workflows/alice/utils.tar.gz`
- **WHEN** `recover()` is called
- **THEN** all three `(owner, repo)` pairs SHALL be registered from their tarballs
- **AND** the derived HTTP trigger indexes SHALL be populated

#### Scenario: Recover with empty storage

- **WHEN** `recover()` is called and no keys exist under `workflows/`
- **THEN** the registry SHALL remain empty

#### Scenario: Recover without storage backend

- **GIVEN** no storage backend is configured
- **WHEN** `recover()` is called
- **THEN** `recover()` SHALL be a no-op

#### Scenario: Recover skips invalid repos

- **GIVEN** the storage backend contains a repo tarball with an invalid manifest
- **WHEN** `recover()` is called
- **THEN** the invalid `(owner, repo)` SHALL be skipped
- **AND** the error SHALL be logged
- **AND** other valid `(owner, repo)` pairs SHALL still be registered

#### Scenario: Recover ignores keys outside the two-segment shape

- **GIVEN** the storage backend contains a legacy key `workflows/acme.tar.gz` (one segment after the prefix)
- **WHEN** `recover()` is called
- **THEN** the key SHALL be ignored and logged as unrecognized
- **AND** recovery SHALL NOT create a synthetic `owner` or `repo` from it

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain a per-`(owner, repo)` HTTP trigger index that is rebuilt eagerly on every `registerOwner` call. The index SHALL map `(owner, repo, method, path)` tuples to `{ workflow, triggerName, validator }`. Scoped: a trigger registered for `(X, A)` SHALL NOT be reachable via a lookup for `(X, B)` or `(Y, A)`.

#### Scenario: Rebuild after re-registration

- **GIVEN** `(owner, repo)` with workflow `v1` registered
- **WHEN** the repo re-registers with workflow `v2` (different trigger paths)
- **THEN** `v1`'s triggers SHALL no longer appear in lookup results
- **AND** `v2`'s triggers SHALL be reachable
- **AND** sibling repos under the same owner SHALL be unaffected

### Requirement: Registry knows its backends and rejects unknown kinds

The `WorkflowRegistry` SHALL be constructed with a `backends: readonly TriggerSource[]` list. The registry SHALL compute the set `allowedKinds = new Set(backends.map(b => b.kind))` at construction time. When parsing a manifest during `registerOwner`, the registry SHALL reject any trigger whose `type` is not in `allowedKinds` as a manifest validation failure (422 from the upload API, see `action-upload` spec).

#### Scenario: Manifest referencing an unknown kind is rejected

- **GIVEN** a registry constructed with backends `[httpSource, cronSource]`
- **WHEN** a repo uploads a manifest containing a trigger with `type: "imap"`
- **THEN** the registry SHALL reject the manifest with a validation error naming the unsupported kind
- **AND** no backend's `reconfigure` SHALL be invoked
- **AND** the existing `(owner, repo)` state (if any) SHALL NOT be modified

#### Scenario: Allowed kinds reflects registered backends

- **GIVEN** a registry constructed with `[httpSource, cronSource, imapSource]`
- **WHEN** a manifest with `type: "imap"` is registered
- **THEN** the manifest SHALL be accepted (per normal Zod validation)
- **AND** the IMAP source's `reconfigure` SHALL be invoked with the manifest's imap triggers

### Requirement: Registry constructs fire closures via buildFire

On every successful `registerOwner` call, the registry SHALL partition the repo's triggers by `descriptor.kind` and SHALL construct one `TriggerEntry` per descriptor. Each entry's `fire` callback SHALL be produced by a non-generic helper:

```
buildFire(
  executor: Executor,
  owner: string,
  repo: string,
  workflow: WorkflowManifest,
  descriptor: BaseTriggerDescriptor,
  bundleSource: string,
  validate: (schema: Record<string, unknown>, input: unknown) =>
    | { ok: true; value: unknown }
    | { ok: false; error: ValidationError },
): (input: unknown) => Promise<InvokeResult<unknown>>
```

The returned closure, when invoked with `input: unknown`:

1. Validates `input` against `descriptor.inputSchema` using the provided `validate` function (Ajv).
2. On validation failure, SHALL resolve to `{ ok: false, error: { message: <validation details> } }` WITHOUT calling the executor.
3. On validation success, SHALL call `executor.invoke(owner, repo, workflow, descriptor, value, bundleSource)` and return its result.

`buildFire` SHALL be the sole construction site for `fire` closures in the runtime. Backends SHALL NOT call `buildFire`; only the registry calls it.

#### Scenario: Fire validates input before invoking executor

- **GIVEN** a descriptor with `inputSchema` requiring `{ body: { name: string } }`
- **AND** a fire closure built from that descriptor
- **WHEN** `fire({ body: {} })` is called (missing `name`)
- **THEN** the closure SHALL return `{ ok: false, error: { message: <details mentioning "name"> } }`
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: Fire routes valid input to executor

- **GIVEN** a descriptor with `inputSchema` accepting `{ body: { name: string } }`
- **AND** a fire closure built from that descriptor
- **WHEN** `fire({ body: { name: "alice" } })` is called
- **THEN** the closure SHALL call `executor.invoke(owner, repo, workflow, descriptor, validatedInput, bundleSource)` exactly once
- **AND** the closure's resolution SHALL match the executor's returned `InvokeResult`

### Requirement: Registry reconfigures backends per-scope in parallel

On every successful `registerOwner(owner, repo, files)` call, the registry SHALL invoke `reconfigure(owner, repo, entries)` on every registered backend in parallel using `Promise.allSettled`. The registry SHALL construct per-backend entry lists by filtering the repo's descriptors where `descriptor.kind === backend.kind`. Backends whose `kind` is not used by the repo SHALL receive an empty entries array, ensuring the `(owner, repo)` scope is cleared from every backend on every upload.

The registry SHALL aggregate the settled results:

- If any backend threw, the registry SHALL report a backend-infrastructure failure carrying every thrown error.
- Otherwise, if any backend returned `{ok: false, errors}`, the registry SHALL report a user-config failure carrying the flattened error list.
- Otherwise, the registry SHALL report success.

The registry SHALL NOT roll back backends that succeeded when another backend failed. Partial state is explicitly accepted.

#### Scenario: All backends reconfigured in parallel on upload

- **GIVEN** a registry constructed with `[httpSource, cronSource]`
- **WHEN** a repo uploads a manifest with both HTTP and cron triggers
- **THEN** the registry SHALL call `httpSource.reconfigure(owner, repo, [httpEntries])` and `cronSource.reconfigure(owner, repo, [cronEntries])` concurrently
- **AND** both calls SHALL be initiated before either resolves

#### Scenario: Empty partition still reconfigures the backend

- **GIVEN** a repo uploading a manifest with only HTTP triggers
- **WHEN** the registry reconfigures backends
- **THEN** the cron backend SHALL receive `reconfigure(owner, repo, [])`
- **AND** the cron backend SHALL clear any previous cron entries for this `(owner, repo)`

#### Scenario: Sibling repo's entries are untouched

- **GIVEN** a registry with cron entries for both `acme/foo` and `acme/bar`
- **WHEN** `acme/foo` re-uploads
- **THEN** `reconfigure` SHALL only affect `acme/foo`'s cron entries
- **AND** `acme/bar`'s cron entries SHALL remain registered

#### Scenario: Partial failure leaves successful backends at new state

- **GIVEN** a registry with HTTP and cron backends
- **WHEN** a repo uploads a manifest and the cron backend returns `{ok: false}` while HTTP returns `{ok: true}`
- **THEN** the HTTP backend SHALL retain the new entries
- **AND** the cron backend's state SHALL be whatever `reconfigure` left it in (not rolled back)
- **AND** the registry SHALL NOT call `reconfigure` again to restore either backend

### Requirement: Persist-on-full-success

The registry SHALL persist the repo tarball to the storage backend (`workflows/<owner>/<repo>.tar.gz`) ONLY after every backend's `reconfigure` returns `{ok: true}`. If any backend fails (user-config or infra), the tarball SHALL NOT be written. Live backend state may then diverge from storage; this is an explicit non-guarantee documented in `CLAUDE.md`.

The registry SHALL NOT stage the tarball to a temporary key before reconfigure. The only storage key used for repo bundles SHALL be `workflows/<owner>/<repo>.tar.gz`.

#### Scenario: Successful upload persists tarball

- **GIVEN** a successful reconfigure across all backends
- **WHEN** the registry finishes aggregating results
- **THEN** the registry SHALL call `backend.writeBytes("workflows/<owner>/<repo>.tar.gz", bytes)` exactly once
- **AND** the upload API SHALL return 204

#### Scenario: Failed upload does not persist tarball

- **GIVEN** a reconfigure where at least one backend returned `{ok: false}` or threw
- **WHEN** the registry finishes aggregating results
- **THEN** the registry SHALL NOT call `writeBytes` for this `(owner, repo)`
- **AND** the previous tarball (if any) SHALL remain unchanged on the storage backend

#### Scenario: Crash between reconfigure success and writeBytes

- **GIVEN** a reconfigure that succeeded across all backends
- **AND** the process crashes after reconfigure returns but before `writeBytes` completes
- **WHEN** the runtime restarts
- **THEN** `recover()` SHALL read the previous tarball (if any) and reconfigure backends against it
- **AND** the repo SHALL re-upload to achieve the desired state
- **AND** no partial bundle SHALL be recoverable from storage

## ADDED Requirements

### Requirement: Workflow names are unique within (owner, repo)

Workflow names declared in a manifest SHALL be unique within a single `(owner, repo)` bundle. Two different `(owner, repo)` pairs MAY declare workflows with the same name without conflict.

#### Scenario: Same workflow name allowed across repos

- **GIVEN** `acme/foo` has registered a workflow named `deploy`
- **WHEN** `acme/bar` uploads a manifest also declaring a workflow named `deploy`
- **THEN** the registry SHALL accept the upload
- **AND** both workflows SHALL be addressable via their fully qualified identity `(owner, repo, workflow)`

#### Scenario: Duplicate workflow name within a repo is rejected

- **WHEN** a manifest declares two workflows with the same name inside a single `(owner, repo)` upload
- **THEN** the registry SHALL reject the manifest with a validation error naming the duplicate
