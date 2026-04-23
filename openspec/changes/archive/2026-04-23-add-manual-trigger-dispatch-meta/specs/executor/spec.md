## MODIFIED Requirements

### Requirement: Executor is called only from fire closures

The `Executor.invoke(tenant, workflow, descriptor, input, options)` method SHALL be called exclusively from the `fire` closures constructed by `WorkflowRegistry.buildFire`. No `TriggerSource` implementation SHALL import or call the executor directly.

The `options` argument SHALL be a bag of the form `{ bundleSource: string, dispatch?: DispatchMeta }` where `DispatchMeta` is `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. When `dispatch` is omitted the executor SHALL default to `{ source: "trigger" }`.

This rule makes the backend plugin contract cleanly decoupled: backends see only `TriggerEntry.fire(input, dispatch?)`, a callback, with no knowledge of tenants, workflows, bundle sources, or the executor itself. Identity is captured inside the closure at construction time. The `dispatch` argument is forwarded as-is from the fire call to the executor — backends never construct it directly.

#### Scenario: No backend imports executor

- **GIVEN** the set of `packages/runtime/src/triggers/*.ts` files
- **WHEN** their import graph is inspected
- **THEN** no file SHALL import from `packages/runtime/src/executor/`

#### Scenario: Executor invocation observable via fire

- **GIVEN** a fire closure built by `buildFire`
- **WHEN** the closure is invoked with valid input and no dispatch argument
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, { bundleSource })` exactly once
- **AND** the closure's resolution SHALL equal the executor's returned `InvokeResult`

#### Scenario: Dispatch argument forwarded through fire

- **GIVEN** a fire closure built by `buildFire` and a caller that passes `dispatch = { source: "manual", user: { name: "Jane", mail: "jane@example.com" } }`
- **WHEN** the closure is invoked with valid input and that dispatch
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, { bundleSource, dispatch })` forwarding the dispatch blob unchanged

### Requirement: Runtime stamps runtime-engine metadata in onEvent

The executor SHALL wire `sb.onEvent(cb)` on every sandbox it drives. The callback SHALL stamp the current run's `tenant`, `workflow`, `workflowSha`, and `invocationId` onto every event received from the sandbox before forwarding to `bus.emit`. The executor SHALL track the "current run" metadata in a variable populated before `sandbox.run()` is called and cleared after it returns.

The run-metadata record SHALL additionally carry the `dispatch` blob forwarded from `Executor.invoke`. The executor callback SHALL stamp `meta: { dispatch }` onto the widened event **only when** `event.kind === "trigger.request"`. For every other event kind the callback SHALL NOT attach a `meta` field (or SHALL attach a `meta` that does not include `dispatch`).

```ts
// Wiring in runtime/executor:
sb.onEvent((event) => {
  const widened = {
    ...event,
    tenant: currentRun.tenant,
    workflow: currentRun.workflow,
    workflowSha: currentRun.workflowSha,
    invocationId: currentRun.invocationId,
    ...(event.kind === "trigger.request"
      ? { meta: { dispatch: currentRun.dispatch } }
      : {}),
  };
  bus.emit(widened);
});

async function invoke(trigger, input, { bundleSource, dispatch }) {
  currentRun = { ...runMeta, dispatch: dispatch ?? { source: "trigger" } };
  try {
    return await sb.run(trigger, input);
  } finally {
    currentRun = null;
  }
}
```

The sandbox SHALL NOT know about tenant/workflow/dispatch/etc.; stamping all of these is the executor's responsibility. Sandbox code and plugin code SHALL NOT emit `meta` or any of its nested fields — `meta.dispatch` has no entry point from the guest side by design (SECURITY.md §2 parallel to R-8). Tenant isolation (§1 I-T2) is enforced at the runtime layer — the executor ensures `currentRun.tenant` matches the tenant that owns the cached sandbox, and scoped query APIs (`EventStore.query(tenant)`, `WorkflowRegistry` per tenant) enforce boundary at read time.

#### Scenario: Events arriving from sandbox get tenant stamped

- **GIVEN** an executor invoking sandbox.run for tenant "acme"
- **WHEN** the sandbox emits `action.request` with no tenant field
- **THEN** the executor's `sb.onEvent` callback SHALL add `tenant: "acme"` to the event
- **AND** forward the stamped event to `bus.emit`

#### Scenario: One run at a time per cached sandbox

- **GIVEN** a sandbox cached for `(tenant, sha)` with a run in flight
- **WHEN** a new invocation arrives for the same `(tenant, sha)`
- **THEN** the second invocation SHALL queue until the first completes
- **AND** `currentRun` metadata SHALL correctly correspond to the single active run at any time

#### Scenario: meta.dispatch stamped only on trigger.request

- **GIVEN** an executor driving an invocation with `dispatch = { source: "manual", user: { name: "Jane", mail: "jane@example.com" } }`
- **WHEN** the sandbox emits `trigger.request`, `action.request`, `action.response`, and `trigger.response` in that order
- **THEN** the widened `trigger.request` event SHALL carry `meta.dispatch = { source: "manual", user: { name: "Jane", mail: "jane@example.com" } }`
- **AND** the widened `action.request`, `action.response`, and `trigger.response` events SHALL NOT carry `meta.dispatch`

#### Scenario: Missing dispatch defaults to source=trigger

- **GIVEN** an executor driving an invocation where the caller omitted `dispatch` from the options bag
- **WHEN** the sandbox emits `trigger.request`
- **THEN** the widened event SHALL carry `meta.dispatch = { source: "trigger" }`
- **AND** the widened event SHALL NOT carry a `user` field inside `dispatch`
