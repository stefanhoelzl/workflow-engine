## MODIFIED Requirements

### Requirement: Runtime stamps runtime-engine metadata in onEvent

The executor SHALL wire `sb.onEvent(cb)` on every sandbox it drives. The callback SHALL stamp the current run's `owner`, `repo`, `workflow`, `workflowSha`, and `invocationId` onto every event received from the sandbox before forwarding to `bus.emit`. The executor SHALL track the "current run" metadata in a variable populated before `sandbox.run()` is called and cleared after it returns.

The run-metadata record SHALL additionally carry the `dispatch` blob forwarded from `Executor.invoke`. The executor callback SHALL stamp `meta: { dispatch }` onto the widened event **only when** `event.kind === "trigger.request"`. For every other event kind the callback SHALL NOT attach a `meta` field (or SHALL attach a `meta` that does not include `dispatch`).

```ts
// Wiring in runtime/executor:
sb.onEvent((event) => {
  const widened = {
    ...event,
    owner: currentRun.owner,
    repo: currentRun.repo,
    workflow: currentRun.workflow,
    workflowSha: currentRun.workflowSha,
    invocationId: currentRun.invocationId,
    ...(event.kind === "trigger.request"
      ? { meta: { dispatch: currentRun.dispatch } }
      : {}),
  };
  bus.emit(widened);
});

async function invoke(owner, repo, workflow, descriptor, input, bundleSource, { dispatch }) {
  currentRun = { owner, repo, workflow, ...runMeta, dispatch: dispatch ?? { source: "trigger" } };
  try {
    return await sb.run(descriptor, input);
  } finally {
    currentRun = null;
  }
}
```

The sandbox SHALL NOT know about `owner`, `repo`, `workflow`, `dispatch`, etc.; stamping all of these is the executor's responsibility. Sandbox code and plugin code SHALL NOT emit `owner`, `repo`, or `meta` or any nested fields of those — they have no entry point from the guest side by design (SECURITY.md §2 R-8).

Owner/repo isolation (§1 I-T2, renamed) is enforced at the runtime layer — the executor ensures `currentRun.owner` and `currentRun.repo` match the scope that owns the cached sandbox, and scoped query APIs (`EventStore.query(scopes)`, `WorkflowRegistry` per `(owner, repo)`) enforce boundaries at read time.

#### Scenario: Events arriving from sandbox get owner and repo stamped

- **GIVEN** an executor invoking sandbox.run for `(owner="acme", repo="foo")`
- **WHEN** the sandbox emits `action.request` with no `owner` or `repo` field
- **THEN** the executor's `sb.onEvent` callback SHALL add `owner: "acme"` and `repo: "foo"` to the event
- **AND** forward the stamped event to `bus.emit`

#### Scenario: One run at a time per cached sandbox

- **GIVEN** a sandbox cached for `(owner, repo, sha)` with a run in flight
- **WHEN** a new invocation arrives for the same `(owner, repo, sha)`
- **THEN** the second invocation SHALL queue until the first completes
- **AND** `currentRun` metadata SHALL correctly correspond to the single active run at any time

#### Scenario: meta.dispatch stamped only on trigger.request

- **GIVEN** an executor driving an invocation with `dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`
- **WHEN** the sandbox emits `trigger.request`, `action.request`, `action.response`, and `trigger.response` in that order
- **THEN** the widened `trigger.request` event SHALL carry `meta.dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`
- **AND** the widened `action.request`, `action.response`, and `trigger.response` events SHALL NOT carry `meta.dispatch`
- **AND** every widened event regardless of kind SHALL carry `owner` and `repo`

#### Scenario: Missing dispatch defaults to source=trigger

- **GIVEN** an executor driving an invocation where the caller omitted `dispatch` from the options bag
- **WHEN** the sandbox emits `trigger.request`
- **THEN** the widened event SHALL carry `meta.dispatch = { source: "trigger" }`
- **AND** the widened event SHALL NOT carry a `user` field inside `dispatch`
- **AND** the widened event SHALL still carry `owner` and `repo`

### Requirement: Executor is called only from fire closures

The executor's `invoke(owner, repo, workflow, descriptor, input, bundleSource, options?)` entry point SHALL be called only from `fire` closures constructed by the registry's `buildFire` helper. Trigger sources (HTTP, cron, manual) SHALL NOT call `executor.invoke` directly — they hold `TriggerEntry` objects whose `fire` callback was pre-built by the registry.

The `fire` closure is responsible for input validation via Ajv; the executor assumes input is already validated and does not re-validate.

The executor SHALL accept `owner` and `repo` as required positional arguments. There SHALL NOT be a code path where `invoke` is called without both values.

#### Scenario: Executor rejects missing owner or repo

- **WHEN** `executor.invoke` is called with `owner` or `repo` undefined
- **THEN** the executor SHALL throw a precondition error
- **AND** SHALL NOT attempt to drive the sandbox
