# Executor Specification

## Purpose

Own the lifecycle of trigger invocations end-to-end, including per-workflow serialization and kind-agnostic return shaping. The executor does NOT synthesize lifecycle events and does NOT construct HTTP-specific response envelopes — lifecycle events originate in the trigger plugin (see `Requirement: Lifecycle events emitted via bus` below and `invocations/spec.md §2`), and protocol-specific response shaping happens in the calling `TriggerSource` (see `http-trigger/spec.md`).

## Requirements

### Requirement: Per-workflow serialization via runQueue

The executor SHALL maintain one runQueue per `(tenant, workflow.sha)` pair. The runQueue SHALL ensure that at most one trigger invocation runs at a time against a given sandbox. The runQueue SHALL be a Promise-chain serializer that does not lose subsequent invocations on prior failure (failures unblock the queue).

#### Scenario: Two invocations of the same workflow serialize

- **GIVEN** tenant `t1`, workflow `w1`, with two triggers `ta` and `tb`
- **WHEN** `executor.invoke(t1, w1, ta, pa)` and `executor.invoke(t1, w1, tb, pb)` are called concurrently
- **THEN** the second invocation's handler SHALL not begin executing until the first completes (success or failure)

#### Scenario: Two workflows run in parallel

- **GIVEN** tenant `t1`, workflows `w1` and `w2` each with one trigger
- **WHEN** invocations on `w1` and `w2` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel (each in its own sandbox)

#### Scenario: Two tenants run in parallel

- **GIVEN** tenants `tA` and `tB` each with a registered workflow whose bundles hash to identical shas
- **WHEN** invocations on `tA` and `tB` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel, each against its tenant-scoped sandbox

#### Scenario: Failure unblocks the queue

- **GIVEN** tenant `t1`, workflow `w1`, whose invocation `i1` fails
- **WHEN** invocation `i2` is dispatched immediately after
- **THEN** `i2` SHALL begin executing rather than being blocked by `i1`'s failure

### Requirement: Lifecycle events emitted via bus

Invocation lifecycle events (`trigger.request`, `trigger.response`, `trigger.error`) SHALL be emitted by the trigger plugin running inside the sandbox (see `sandbox-plugin/spec.md` and `invocations/spec.md §2`), NOT synthesised by the executor. The executor's role is limited to forwarding every event it receives from the sandbox to the bus via `bus.emit`, after widening each event with the current run's `tenant`, `workflow`, `workflowSha`, and `invocationId` (and, on `trigger.request` only, `meta.dispatch` — see `Requirement: Runtime stamps runtime-engine metadata in onEvent`).

The executor SHALL NOT construct or emit any event outside of this forwarding path. All events originate in plugins, flow through `sb.onEvent`, get stamped by the executor's widener, and hit the bus as fully-widened `InvocationEvent` objects.

#### Scenario: Every sandbox-emitted event reaches the bus

- **GIVEN** a run during which the sandbox emits N events
- **WHEN** the executor's `sb.onEvent` callback fires
- **THEN** the bus SHALL receive exactly N events
- **AND** each bus event SHALL carry the run's tenant/workflow/workflowSha/invocationId
- **AND** no event SHALL be lost between sandbox emission and bus emission

### Requirement: Executor has no retry logic in v1

The v1 executor SHALL NOT implement retry. A handler throw SHALL transition the invocation to `failed` immediately, with no auto-retry and no operator-triggered retry available.

#### Scenario: Handler failure is terminal in v1

- **GIVEN** a handler that throws on every invocation
- **WHEN** the executor invokes the trigger
- **THEN** the invocation SHALL be marked `failed` once and the executor SHALL not re-attempt

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

### Requirement: Executor return shape is kind-agnostic

The `Executor.invoke(…)` method SHALL resolve to a discriminated `InvokeResult<unknown>`:

```
type InvokeResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: { message: string; stack?: string } };
```

The shape SHALL be identical for every trigger kind (HTTP, cron, future kinds). Protocol-specific response shaping (HTTP status/body/headers) SHALL be performed by the calling backend after receiving the `InvokeResult`, NOT by the executor.

`InvokeResult` SHALL NOT embed HTTP-specific fields (`status`, `body`, `headers`). Those are derived by the HTTP `TriggerSource` from the `output` field when `ok: true`, or from a standard `500 internal_error` shape when `ok: false`.

#### Scenario: Executor returns generic InvokeResult

- **GIVEN** a handler that returns `{status: 202, body: {ok: true}}`
- **WHEN** the executor invokes the trigger
- **THEN** `InvokeResult` SHALL be `{ok: true, output: {status: 202, body: {ok: true}}}`
- **AND** the HTTP response shaping (serializing `output` to an HTTP response) SHALL be the HTTP source's responsibility, not the executor's

#### Scenario: Executor reports handler error uniformly

- **GIVEN** a handler that throws `new Error("boom")`
- **WHEN** the executor invokes the trigger
- **THEN** `InvokeResult` SHALL be `{ok: false, error: {message: "boom", stack: <stack>}}`
- **AND** the HTTP source SHALL map this to a 500 response with `{error: "internal_error"}` in its body
- **AND** the cron source SHALL log the failure (no protocol response) and arm the next tick

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

### Requirement: Executor composes trigger plugin

The executor SHALL include `createTriggerPlugin()` in the plugin list for every production sandbox. Tests MAY compose sandboxes without the trigger plugin for silent runs.

#### Scenario: Production composition includes trigger plugin

- **GIVEN** an executor building a sandbox for a tenant workflow
- **WHEN** the plugin array is assembled
- **THEN** `createTriggerPlugin()` SHALL be present
- **AND** every production run SHALL produce `trigger.request` and `trigger.response`/`trigger.error` events

### Requirement: Executor decrypts manifest.secrets per invocation

For every `Executor.invoke(…)` call whose workflow's manifest entry contains `secrets`, the executor SHALL decrypt each base64 ciphertext into a `plaintextStore: Record<string, string>` keyed by envName before invoking the sandbox. The decryption SHALL use `decryptSealed` against the primary/retained key looked up by `manifest.secretsKeyId`.

The executor SHALL pass `plaintextStore` through to the sandbox as part of the `run` message's ctx as `ctx.plaintextStore`. After the sandbox's `run()` promise settles (success, error, or rejection), the executor SHALL zero and clear `plaintextStore` in a `finally` block before returning to the caller. Zeroing means overwriting each value with an empty string (best-effort — JS does not guarantee memory clearing beyond drop).

If the manifest entry has no `secrets` field, the executor SHALL pass `ctx.plaintextStore = {}` (empty object) or omit it entirely. The sandbox-side consumer MUST accept both shapes.

The executor SHALL NOT log plaintext values at any severity level. Errors during decrypt SHALL be logged with `envName` but without the ciphertext or plaintext.

```ts
async function invoke(trigger, input, runMeta) {
  currentRun = runMeta;
  const plaintextStore: Record<string, string> = {};
  try {
    if (manifest.secrets && manifest.secretsKeyId) {
      for (const [envName, ct] of Object.entries(manifest.secrets)) {
        const pt = decryptSealed(ct, manifest.secretsKeyId, keyStore);
        plaintextStore[envName] = new TextDecoder().decode(pt);
      }
    }
    return await sb.run(trigger, input, { ...ctx, plaintextStore });
  } finally {
    for (const k of Object.keys(plaintextStore)) plaintextStore[k] = "";
    currentRun = null;
  }
}
```

#### Scenario: Invocation with secrets populates plaintextStore

- **GIVEN** a workflow manifest with `secrets: { TOKEN: <valid-ct> }` and `secretsKeyId: <primary>`
- **WHEN** `executor.invoke(...)` is called
- **THEN** the sandbox's `run` message SHALL receive `ctx.plaintextStore = { TOKEN: <decrypted-string> }`
- **AND** the decrypted string SHALL equal the original sealed plaintext

#### Scenario: Plaintext is wiped after run

- **GIVEN** an invocation that decrypted secrets successfully
- **WHEN** the sandbox's `run()` promise settles (either resolve or reject)
- **THEN** the executor's local `plaintextStore` reference SHALL have each value overwritten with `""` before returning
- **AND** no further code path SHALL retain the plaintext

#### Scenario: Decrypt failure propagates as executor error

- **GIVEN** a manifest whose `secretsKeyId` refers to a retired key
- **WHEN** `executor.invoke(...)` is called
- **THEN** decryption SHALL throw `UnknownKeyIdError` (from the key-store helper)
- **AND** the executor SHALL resolve `InvokeResult` to `{ ok: false, error: { message: <descriptive> } }`
- **AND** the event bus SHALL see a trigger-error event with the same message

#### Scenario: Invocation without secrets is unchanged

- **GIVEN** a workflow whose manifest has no `secrets` field
- **WHEN** `executor.invoke(...)` is called
- **THEN** `ctx.plaintextStore` SHALL be `{}` or omitted
- **AND** executor behavior SHALL otherwise be identical to pre-feature behavior

#### Scenario: Concurrent invocations do not share plaintextStore

- **GIVEN** two invocations against different workflows (different sandboxes) running concurrently
- **WHEN** each decrypts its own manifest.secrets
- **THEN** each invocation's `plaintextStore` SHALL be a distinct object
- **AND** cross-invocation plaintext contamination SHALL NOT be possible

