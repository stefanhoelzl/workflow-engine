# Workflow Registry Specification

## Purpose

Own the per-tenant workflow metadata, validate tenant manifests, persist tenant bundles, and act as the plugin host for `TriggerSource` backends. The registry is metadata-only — it does not own sandboxes (that's `sandbox-store`) and does not perform protocol routing (each backend owns its own).
## Requirements
### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with an optional `StorageBackend` and a `Logger`. It SHALL own manifest validation, persistence, and in-memory metadata for all registered workflows across all tenants. It SHALL NOT own sandboxes, `WorkflowRunner` objects, or any execution-side state; sandbox lifecycle is owned by the `SandboxStore` (see the `sandbox-store` capability), and invocation dispatch is owned by the `Executor`.

#### Scenario: Register a tenant from a file map

- **WHEN** `registerTenant(tenant, files)` is called with a `Map<string, string>` containing `manifest.json` and the bundled workflow module files
- **THEN** the registry SHALL validate the manifest against `ManifestSchema`, verify each workflow's bundle file exists in the file map, persist the tarball to the storage backend (if configured and requested), and replace the in-memory metadata for `tenant` with the newly registered workflows
- **AND** it SHALL rebuild the derived HTTP trigger index scoped to `tenant`
- **AND** it SHALL return a `RegisterResult` with `ok: true` on success and `ok: false` with an error message on failure

#### Scenario: Register returns a failure result on validation error

- **WHEN** `registerTenant(tenant, files)` is called with an invalid or incomplete file map
- **THEN** the registry SHALL return `{ ok: false, error }` and SHALL log the reason
- **AND** the in-memory metadata for `tenant` SHALL remain unchanged

#### Scenario: Register replaces all workflows for the tenant

- **WHEN** `registerTenant(tenant, files)` is called with a new manifest
- **THEN** all existing workflow metadata for `tenant` SHALL be discarded and replaced
- **AND** the HTTP trigger index for `tenant` SHALL be rebuilt
- **AND** sandboxes held by the `SandboxStore` for `(tenant, oldSha)` keys SHALL NOT be disposed (see `sandbox-store`)

### Requirement: WorkflowRegistry exposes metadata accessors

The runtime SHALL expose `list(tenant?)`, `tenants()`, and `getEntry(tenant, workflowName, triggerName)` on the `WorkflowRegistry` for presentation (dashboard / trigger UI) and manual-fire. The registry SHALL NOT expose a `WorkflowRunner` type, a `runners[]` array, or a `sandbox` reference on any returned value. Protocol routing (e.g., URL-based HTTP dispatch) is owned by each `TriggerSource` backend (see `http-trigger` spec), NOT the registry.

#### Scenario: getEntry returns the pre-built TriggerEntry

- **GIVEN** tenant `acme` has workflow `demo` with trigger `onPing`
- **WHEN** `registry.getEntry("acme", "demo", "onPing")` is called
- **THEN** the registry SHALL return the `TriggerEntry { descriptor, fire }` pre-built during registration

#### Scenario: getEntry is tenant-scoped

- **GIVEN** tenant `A` and tenant `B` both register a workflow `demo` with trigger `onPing`
- **WHEN** `registry.getEntry("A", "demo", "onPing")` is called
- **THEN** the registry SHALL return `A`'s entry, not `B`'s

#### Scenario: getEntry returns undefined on no match

- **WHEN** `registry.getEntry(tenant, workflowName, triggerName)` is called with values that do not match any registered trigger for that tenant
- **THEN** the registry SHALL return `undefined`

### Requirement: Persist before in-memory update

When a storage backend is configured, `registerTenant()` SHALL persist the tenant tarball to the storage backend before updating the registry's in-memory tenant state map. If persistence fails, the in-memory tenant state SHALL NOT be updated. Note: backend `reconfigure()` happens before persistence (see "Persist-on-full-success"); "rebuild" here refers to the registry's own in-memory `tenantStates` map, not the trigger sources' per-kind indexes.

#### Scenario: Successful persistence

- **WHEN** `registerTenant(tenant, files, { tarballBytes })` is called and the storage backend write succeeds
- **THEN** the tarball SHALL be written to `workflows/<tenant>.tar.gz` in the storage backend
- **AND** the in-memory workflow state SHALL be updated

#### Scenario: No storage backend

- **WHEN** `registerTenant(tenant, files)` is called and no storage backend is configured
- **THEN** the workflow SHALL exist only in memory
- **AND** it SHALL be lost on restart

### Requirement: Recover workflows from storage backend

The registry SHALL provide a `recover()` method that loads all tenant tarballs from the storage backend's `workflows/` prefix at startup and invokes `registerTenant` for each. Recovery SHALL use the same validation logic as `registerTenant`.

#### Scenario: Recover loads persisted tenant tarballs

- **GIVEN** the storage backend contains `workflows/acme.tar.gz` and `workflows/globex.tar.gz`
- **WHEN** `recover()` is called
- **THEN** both tenants' metadata SHALL be registered from their tarballs
- **AND** the derived HTTP trigger indexes SHALL be populated

#### Scenario: Recover with empty storage

- **WHEN** `recover()` is called and no keys exist under `workflows/`
- **THEN** the registry SHALL remain empty

#### Scenario: Recover without storage backend

- **GIVEN** no storage backend is configured
- **WHEN** `recover()` is called
- **THEN** `recover()` SHALL be a no-op

#### Scenario: Recover skips invalid tenants

- **GIVEN** the storage backend contains a tenant tarball with an invalid manifest
- **WHEN** `recover()` is called
- **THEN** the invalid tenant SHALL be skipped
- **AND** the error SHALL be logged
- **AND** other valid tenants SHALL still be registered

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain a per-tenant map of `TriggerEntry` objects (keyed by `${workflowName}/${triggerName}`) that is rebuilt eagerly on every `registerTenant` call. Each entry SHALL carry the `TriggerDescriptor` (with its `inputSchema`) and the pre-wired `fire` closure. Tenant-scoped: a trigger registered for tenant `A` SHALL NOT be reachable via `getEntry` for tenant `B`. The registry SHALL also push the rebuilt per-kind entry lists to every registered `TriggerSource` via `reconfigure(tenant, entries)` (see "Registry reconfigures backends per-tenant in parallel").

#### Scenario: Rebuild after re-registration

- **GIVEN** a tenant with workflow `v1` registered
- **WHEN** the tenant re-registers with workflow `v2` (different triggers)
- **THEN** `v1`'s triggers SHALL no longer appear in `getEntry` / `list` results
- **AND** `v2`'s triggers SHALL be reachable
- **AND** every registered backend SHALL have received `reconfigure(tenant, <v2-entries-of-its-kind>)`

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

The registry SHALL persist the tenant tarball to the storage backend (`workflows/<tenant>.tar.gz`) ONLY after every backend's `reconfigure` returns `{ok: true}`. If any backend fails (user-config or infra), the tarball SHALL NOT be written. Live backend state may then diverge from storage; this partial-state outcome is an explicit non-guarantee (see "Registry reconfigures backends per-tenant in parallel": the registry does not roll back successful backends when another backend fails).

The registry SHALL write the tarball directly to `workflows/<tenant>.tar.gz`. `StorageBackend.writeBytes` is contractually atomic (see `storage-backend/spec.md`: FS uses tmp+rename, S3 uses PutObject), so no staging key is used.

The HTTP response contract (e.g., `204 No Content` on successful upload) is owned by the upload handler; see `action-upload/spec.md`.

#### Scenario: Successful upload persists tarball

- **GIVEN** a successful reconfigure across all backends
- **WHEN** the registry finishes aggregating results
- **THEN** the registry SHALL call `backend.writeBytes("workflows/<tenant>.tar.gz", bytes)` exactly once
- **AND** SHALL NOT write to any other key (no staging / temp key)

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

### Requirement: Workflow loading instantiates one sandbox per `(tenant, sha)`

Workflow loading SHALL instantiate exactly one cached sandbox per `(tenant, sha)` via the SandboxStore (see `sandbox` "SandboxStore provides per-`(tenant, sha)` sandbox access"). The sandbox source SHALL be the workflow bundle produced by the vite plugin WITHOUT any runtime-side source appending. The runtime SHALL NOT concatenate `action-dispatcher.js` or any other dispatcher shim to the source before passing it to `sandbox({ source, plugins })`. Dispatcher logic lives in `createSdkSupportPlugin` (see `sdk` capability), which the runtime composes into the plugin list.

After sandbox initialization completes, the plugin-installed globals SHALL be present on `globalThis` per their descriptors' `public` flags: public descriptors (fetch, setTimeout, console.*) survive Phase 3; private descriptors (`__sdkDispatchAction`, `__reportErrorHost`, `$fetch/do`, `__wptReport` in tests) are auto-deleted by Phase 3 after being captured in Phase-2 IIFE closures. The `__sdk` global SHALL be present (locked, frozen) for action dispatch.

User source — including SDK-bundled `action()` callables — SHALL run in Phase 4 and SHALL see only the public globals, the VM-level globals from quickjs-wasi extensions, and `__sdk`. SDK `action()` callables invoke `globalThis.__sdk.dispatchAction(name, input, handler)`, which routes through the sdk-support plugin's host handler.

#### Scenario: No source appending

- **GIVEN** a tenant workflow bundle loaded by the runtime
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({ source: <bundle>, plugins: [...] })` SHALL be invoked with `source` exactly equal to the bundle
- **AND** no runtime source SHALL be concatenated, prepended, or appended

#### Scenario: Stale tenant bundles require re-upload

- **GIVEN** a pre-existing tenant bundle produced by an older SDK that called `globalThis.__dispatchAction`
- **WHEN** loaded by the new runtime
- **THEN** the bundle SHALL fail because `globalThis.__dispatchAction` no longer exists
- **AND** operators SHALL re-upload every tenant via `wfe upload --tenant <name>`
- **AND** newly-built bundles SHALL call `globalThis.__sdk.dispatchAction` and succeed

#### Scenario: Private bindings invisible in Phase 4

- **GIVEN** a sandbox post-init for any tenant workflow
- **WHEN** user source evaluates `typeof __sdkDispatchAction`, `typeof __reportErrorHost`, `typeof $fetch/do`
- **THEN** each SHALL be `"undefined"`
- **AND** `typeof __sdk` SHALL be `"object"`
- **AND** `typeof fetch`, `typeof setTimeout`, `typeof console` SHALL all be `"function"` (or `"object"` for console)

### Requirement: Manifest `env` resolution at build time

The runtime SHALL apply the workflow's manifest `env` map to the loaded workflow object. The `env` resolution (reading `process.env`, applying defaults) happens AT BUILD TIME inside the vite plugin; the runtime merely reads resolved values from the manifest. The runtime SHALL NOT re-read `process.env` at load time.

#### Scenario: env values match manifest

- **GIVEN** a manifest with `env: { URL: "https://..." }`
- **WHEN** the workflow is loaded
- **THEN** the workflow's `env.URL` (referenced by handlers as `workflow.env.URL`) SHALL equal `"https://..."`


### Requirement: Registry resolves secret sentinels before reconfiguring backends

On every successful `registerTenant(tenant, files)` call, and during `recover()` replay, the registry SHALL, after constructing the in-memory workflow entries from the manifest and BEFORE dispatching to any `TriggerSource.reconfigure`, perform a sentinel-resolution pass on each workflow's trigger descriptors.

The registry SHALL:

1. Decrypt `manifest.secrets` exactly once per workflow load via `decryptWorkflowSecrets(manifest, keyStore)` (same function used at sandbox spawn), producing a `plaintextStore: Record<string, string>`.
2. Invoke a shared deep-walk resolver (implemented in `packages/runtime/src/triggers/resolve-secret-sentinels.ts`) over each trigger descriptor, substituting every match of `SENTINEL_SUBSTRING_RE` with the corresponding `plaintextStore` value. Unknown sentinel names SHALL be accumulated into a `missing: Set<string>` and left in place.
3. If `missing` is non-empty for a workflow, that workflow's registration SHALL fail with `WorkflowRegistrationError({ code: "secret_ref_unresolved", workflow, missing: [...] })`. The registry SHALL NOT invoke `reconfigure` on any backend for the failed workflow. At upload, the surface SHALL be HTTP `400` with JSON body `{ error: "secret_ref_unresolved", workflow: <name>, missing: [...] }`. At recovery, the failure SHALL be logged per-workflow and the registry SHALL continue with the remaining workflows.
4. Otherwise, the resolved descriptors (containing no sentinel bytes) SHALL replace the raw descriptors in the per-backend entry lists passed to `reconfigure`.

No cache of `plaintextStore` SHALL be introduced by this change. `decryptWorkflowSecrets` runs once here and again when a sandbox spawns for an invocation; the duplication is accepted.

The sentinel-resolution pass SHALL run even for workflows with no declared secrets — in that case the pass is a no-op (no sentinels to replace, no missing names to collect) and adds only the cost of a descriptor walk.

#### Scenario: Upload with resolvable sentinels reconfigures backends with plaintext

- **GIVEN** a manifest whose cron trigger has `schedule: "\x00secret:S\x00"` and `secrets` containing ciphertext for `S` decryptable to `"*/5 * * * *"`
- **WHEN** `registerTenant` processes the upload
- **THEN** the registry SHALL call `cronTriggerSource.reconfigure(tenant, [entry])` where `entry.descriptor.schedule === "*/5 * * * *"`
- **AND** `entry.descriptor.schedule` SHALL NOT contain the byte sequence `\x00secret:`

#### Scenario: Upload with unresolvable sentinel returns 400 and does not reconfigure

- **GIVEN** a manifest with a trigger-config sentinel `"\x00secret:MISSING\x00"` and `secrets` lacking a `MISSING` entry
- **WHEN** `registerTenant` processes the upload
- **THEN** the registry SHALL throw `WorkflowRegistrationError { code: "secret_ref_unresolved", workflow, missing: ["MISSING"] }`
- **AND** SHALL NOT invoke `reconfigure` on any backend for this workflow
- **AND** the upload HTTP response SHALL be `400` with body `{ error: "secret_ref_unresolved", workflow: <name>, missing: ["MISSING"] }`
- **AND** no workflow tarball SHALL be persisted (the existing persist-on-full-success requirement already implies this, since reconfigure never ran)

#### Scenario: Recovery isolates per-workflow resolution failures

- **GIVEN** a persistence replay set containing workflow A (valid sentinels) and workflow B (an unresolved sentinel)
- **WHEN** the registry calls `recover()`
- **THEN** workflow A SHALL be registered and its backends reconfigured with resolved descriptors
- **AND** workflow B SHALL be absent from the registry
- **AND** an error SHALL be logged identifying workflow B and its missing sentinel names
- **AND** the recovery process SHALL complete without throwing

#### Scenario: Workflow with no secrets flows through unchanged

- **GIVEN** a manifest with no `secretBindings` / `secrets` and no sentinel strings in any trigger descriptor
- **WHEN** `registerTenant` processes the upload
- **THEN** the sentinel-resolution pass SHALL produce descriptors byte-identical to the manifest descriptors
- **AND** `reconfigure` SHALL be called as it is today
