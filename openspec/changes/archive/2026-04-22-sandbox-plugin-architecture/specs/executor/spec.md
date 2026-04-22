## ADDED Requirements

### Requirement: Runtime stamps runtime-engine metadata in onEvent

The executor SHALL wire `sb.onEvent(cb)` on every sandbox it drives. The callback SHALL stamp the current run's `tenant`, `workflow`, `workflowSha`, and `invocationId` onto every event received from the sandbox before forwarding to `bus.emit`. The executor SHALL track the "current run" metadata in a variable populated before `sandbox.run()` is called and cleared after it returns.

```ts
// Wiring in runtime/executor:
sb.onEvent((event) => {
  bus.emit({
    ...event,
    tenant: currentRun.tenant,
    workflow: currentRun.workflow,
    workflowSha: currentRun.workflowSha,
    invocationId: currentRun.invocationId,
  });
});

async function invoke(trigger, input, runMeta) {
  currentRun = runMeta;
  try {
    return await sb.run(trigger, input);
  } finally {
    currentRun = null;
  }
}
```

The sandbox SHALL NOT know about tenant/workflow/etc.; stamping is the executor's responsibility. Tenant isolation (§1 I-T2) is enforced at the runtime layer — the executor ensures `currentRun.tenant` matches the tenant that owns the cached sandbox, and scoped query APIs (`EventStore.query(tenant)`, `WorkflowRegistry` per tenant) enforce boundary at read time.

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

### Requirement: Executor composes trigger plugin

The executor SHALL include `createTriggerPlugin()` in the plugin list for every production sandbox. Tests MAY compose sandboxes without the trigger plugin for silent runs.

#### Scenario: Production composition includes trigger plugin

- **GIVEN** an executor building a sandbox for a tenant workflow
- **WHEN** the plugin array is assembled
- **THEN** `createTriggerPlugin()` SHALL be present
- **AND** every production run SHALL produce `trigger.request` and `trigger.response`/`trigger.error` events

## MODIFIED Requirements

### Requirement: Lifecycle events emitted via bus

The executor SHALL forward all events received from the sandbox to the bus via `bus.emit` after stamping `tenant`, `workflow`, `workflowSha`, and `invocationId` onto each event. The executor SHALL NOT emit synthesized trigger/action events outside of this forwarding path — all events originate in plugins, flow through `sb.onEvent`, get stamped, and hit the bus.

#### Scenario: Every sandbox-emitted event reaches the bus

- **GIVEN** a run during which the sandbox emits N events
- **WHEN** the executor's `sb.onEvent` callback fires
- **THEN** the bus SHALL receive exactly N events
- **AND** each bus event SHALL carry the run's tenant/workflow/workflowSha/invocationId
- **AND** no event SHALL be lost between sandbox emission and bus emission
