## MODIFIED Requirements

### Requirement: Registry constructs fire closures via buildFire

On every successful `registerTenant` call, the registry SHALL partition the tenant's triggers by `descriptor.kind` and SHALL construct one `TriggerEntry` per descriptor. The registry SHALL also rehydrate each descriptor's `inputSchema` and `outputSchema` JSON-Schema objects into schema validators ONCE at registration time, and SHALL attach the resulting validators to the registered-workflow record (or to a sibling structure keyed by descriptor identity). The same validator instances SHALL serve every invocation of the workflow until the workflow is unregistered or replaced; per-request validator construction is forbidden. Cache abstractions are permitted but not required.

Each entry's `fire` callback SHALL be produced by a non-generic helper:

```
buildFire(
  executor: Executor,
  tenant: string,
  workflow: WorkflowManifest,
  descriptor: BaseTriggerDescriptor,
  bundleSource: string,
  validate: (descriptor, input: unknown) =>
    | { ok: true; value: unknown }
    | { ok: false; error: ValidationError },
): (input: unknown) => Promise<InvokeResult<unknown>>
```

The returned closure, when invoked with `input: unknown`:

1. Validates `input` against the descriptor's pre-rehydrated input validator using the provided `validate` function.
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

#### Scenario: Validators are pre-rehydrated at registration time

- **GIVEN** a tenant registration with a workflow that declares N triggers
- **WHEN** `registerTenant` completes successfully
- **THEN** N input validators and N output validators SHALL have been rehydrated as a one-time cost of registration
- **AND** subsequent `fire` invocations SHALL reuse those validator instances without re-rehydrating

#### Scenario: Validator rehydration failure surfaces as registration failure

- **GIVEN** a tenant manifest containing a structurally-invalid JSON Schema in some trigger's `inputSchema`
- **WHEN** `registerTenant` is called
- **THEN** the registration SHALL fail with a tenant-visible error pointing at the offending trigger
- **AND** no `TriggerEntry` SHALL be exposed for the tenant (the registration is rejected atomically)
