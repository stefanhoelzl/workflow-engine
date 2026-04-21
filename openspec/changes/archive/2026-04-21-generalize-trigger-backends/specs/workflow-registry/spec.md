## ADDED Requirements

### Requirement: Registry knows its backends and rejects unknown kinds

The `WorkflowRegistry` SHALL be constructed with a `backends: readonly TriggerSource[]` list. The registry SHALL compute the set `allowedKinds = new Set(backends.map(b => b.kind))` at construction time. When parsing a tenant manifest during `registerTenant`, the registry SHALL reject any trigger whose `type` is not in `allowedKinds` as a manifest validation failure (422 from the upload API, see `action-upload` spec).

#### Scenario: Manifest referencing an unknown kind is rejected

- **GIVEN** a registry constructed with backends `[httpSource, cronSource]`
- **WHEN** a tenant uploads a manifest containing a trigger with `type: "imap"`
- **THEN** the registry SHALL reject the manifest with a validation error naming the unsupported kind
- **AND** no backend's `reconfigure` SHALL be invoked
- **AND** the existing tenant state (if any) SHALL NOT be modified

#### Scenario: Allowed kinds reflects registered backends

- **GIVEN** a registry constructed with `[httpSource, cronSource, imapSource]`
- **WHEN** a manifest with `type: "imap"` is registered
- **THEN** the manifest SHALL be accepted (per normal Zod validation)
- **AND** the IMAP source's `reconfigure` SHALL be invoked with the manifest's imap triggers

### Requirement: Registry constructs fire closures via buildFire

On every successful `registerTenant` call, the registry SHALL partition the tenant's triggers by `descriptor.kind` and SHALL construct one `TriggerEntry` per descriptor. Each entry's `fire` callback SHALL be produced by a non-generic helper:

```
buildFire(
  executor: Executor,
  tenant: string,
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
3. On validation success, SHALL call `executor.invoke(tenant, workflow, descriptor, value, bundleSource)` and return its result.

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
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, bundleSource)` exactly once
- **AND** the closure's resolution SHALL match the executor's returned `InvokeResult`

### Requirement: Registry reconfigures backends per-tenant in parallel

On every successful `registerTenant(tenant, files)` call, the registry SHALL invoke `reconfigure(tenant, entries)` on every registered backend in parallel using `Promise.allSettled`. The registry SHALL construct per-backend entry lists by filtering the tenant's descriptors where `descriptor.kind === backend.kind`. Backends whose `kind` is not used by the tenant SHALL receive an empty entries array, ensuring the tenant is cleared from every backend on every upload.

The registry SHALL aggregate the settled results:

- If any backend threw, the registry SHALL report a backend-infrastructure failure carrying every thrown error.
- Otherwise, if any backend returned `{ok: false, errors}`, the registry SHALL report a user-config failure carrying the flattened error list.
- Otherwise, the registry SHALL report success.

The registry SHALL NOT roll back backends that succeeded when another backend failed. Partial state is explicitly accepted.

#### Scenario: All backends reconfigured in parallel on upload

- **GIVEN** a registry constructed with `[httpSource, cronSource]`
- **WHEN** a tenant uploads a manifest with both HTTP and cron triggers
- **THEN** the registry SHALL call `httpSource.reconfigure(tenant, [httpEntries])` and `cronSource.reconfigure(tenant, [cronEntries])` concurrently
- **AND** both calls SHALL be initiated before either resolves

#### Scenario: Empty partition still reconfigures the backend

- **GIVEN** a tenant uploading a manifest with only HTTP triggers
- **WHEN** the registry reconfigures backends
- **THEN** the cron backend SHALL receive `reconfigure(tenant, [])`
- **AND** the cron backend SHALL clear any previous cron entries for this tenant

#### Scenario: Partial failure leaves successful backends at new state

- **GIVEN** a registry with HTTP and cron backends
- **WHEN** a tenant uploads a manifest and the cron backend returns `{ok: false}` while HTTP returns `{ok: true}`
- **THEN** the HTTP backend SHALL retain the new entries
- **AND** the cron backend's state SHALL be whatever `reconfigure` left it in (not rolled back)
- **AND** the registry SHALL NOT call `reconfigure` again to restore either backend

### Requirement: Persist-on-full-success

The registry SHALL persist the tenant tarball to the storage backend (`workflows/<tenant>.tar.gz`) ONLY after every backend's `reconfigure` returns `{ok: true}`. If any backend fails (user-config or infra), the tarball SHALL NOT be written. Live backend state may then diverge from storage; this is an explicit non-guarantee documented in `CLAUDE.md`.

The registry SHALL NOT stage the tarball to a temporary key before reconfigure. The only storage key used for tenant bundles SHALL be `workflows/<tenant>.tar.gz`.

#### Scenario: Successful upload persists tarball

- **GIVEN** a successful reconfigure across all backends
- **WHEN** the registry finishes aggregating results
- **THEN** the registry SHALL call `backend.writeBytes("workflows/<tenant>.tar.gz", bytes)` exactly once
- **AND** the upload API SHALL return 204

#### Scenario: Failed upload does not persist tarball

- **GIVEN** a reconfigure where at least one backend returned `{ok: false}` or threw
- **WHEN** the registry finishes aggregating results
- **THEN** the registry SHALL NOT call `writeBytes` for this tenant
- **AND** the previous tarball (if any) SHALL remain unchanged on the storage backend

#### Scenario: Crash between reconfigure success and writeBytes

- **GIVEN** a reconfigure that succeeded across all backends
- **AND** the process crashes after reconfigure returns but before `writeBytes` completes
- **WHEN** the runtime restarts
- **THEN** `recover()` SHALL read the previous tarball (if any) and reconfigure backends against it
- **AND** the tenant SHALL re-upload to achieve the desired state
- **AND** no partial bundle SHALL be recoverable from storage
