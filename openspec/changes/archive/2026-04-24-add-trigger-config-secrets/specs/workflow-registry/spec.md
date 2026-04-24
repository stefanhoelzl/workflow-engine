## ADDED Requirements

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
