# Triggers Specification

## Purpose

Define the abstract trigger umbrella type and the contract for concrete trigger implementations. Triggers receive external stimuli and drive invocation lifecycle via the executor.
## Requirements
### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. The union contains three members: `HttpTrigger | CronTrigger | ManualTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes HttpTrigger, CronTrigger, and ManualTrigger

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger`
- **AND** existing `HttpTrigger` and `CronTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a fourth trigger kind (e.g., `MailTrigger`)
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended to `HttpTrigger | CronTrigger | ManualTrigger | MailTrigger`
- **AND** existing consumers SHALL continue to compile without change

### Requirement: Trigger has exactly one handler

A trigger SHALL declare exactly one `handler` function. There are no subscribers, no fan-out, and no `emit()` from inside trigger handlers in v1. The handler's return value SHALL be the basis for the trigger source's response (HTTP response for `HttpTrigger`).

#### Scenario: Trigger declares one handler

- **GIVEN** any concrete trigger factory
- **WHEN** the trigger is created
- **THEN** the trigger SHALL carry exactly one `handler` function

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code. Concrete implementations bind to their own ingress mechanisms (HTTP server for `HttpTrigger`).

#### Scenario: Trigger source bound at startup

- **GIVEN** the runtime starts with one or more HTTP triggers configured
- **WHEN** the runtime initializes
- **THEN** the HTTP server SHALL bind its port and register routes for each HTTP trigger

### Requirement: TriggerSource interface

The runtime SHALL define a `TriggerSource<K extends string, D extends BaseTriggerDescriptor<K>>` interface at `packages/runtime/src/triggers/source.ts`. Each concrete trigger kind (HTTP, cron, future IMAP, …) SHALL ship exactly one `TriggerSource` implementation as a protocol adapter. The interface SHALL require the following members:

- `readonly kind: K` — the discriminator matching `descriptor.kind`.
- `start(): Promise<void>` — called once at server boot, before `registry.recover()`. Backend allocates infra-level resources (e.g., HTTP mounts its middleware, cron starts its scheduler, IMAP opens its connection pool). No entries are known yet.
- `stop(): Promise<void>` — called at server shutdown. Backend SHALL stop accepting new fires; in-flight invocations continue running via the executor's per-workflow runQueue (no cancellation, no draining).
- `reconfigure(tenant: string, entries: readonly TriggerEntry<D>[]): Promise<ReconfigureResult>` — see below.

The `TriggerSource` SHALL NOT receive, construct, or depend on the `Executor`. Invocation dispatch is delegated to `fire` closures carried on each `TriggerEntry`.

#### Scenario: Concrete backends implement the interface

- **GIVEN** the HTTP and cron backends
- **WHEN** their exported factories are inspected
- **THEN** each SHALL return a value implementing `TriggerSource<K, D>` for its kind
- **AND** neither SHALL import `Executor` or reference `executor.invoke` directly

#### Scenario: start and stop are orthogonal to reconfigure

- **GIVEN** a fresh `TriggerSource` instance
- **WHEN** `start()` is called before any `reconfigure()`
- **THEN** the backend SHALL allocate its infra without any knowledge of tenants or triggers
- **AND** subsequent `reconfigure(tenant, entries)` calls SHALL install per-tenant state on top of the already-running infra

### Requirement: TriggerEntry carries descriptor and fire callback

The runtime SHALL define `TriggerEntry<D>` as an immutable record carrying exactly two fields:

- `readonly descriptor: D` — the kind-specific descriptor from the tenant manifest.
- `readonly fire: (input: unknown) => Promise<InvokeResult<unknown>>` — a callback that, when invoked, runs the workflow handler and returns a discriminated result `{ ok: true, output: unknown } | { ok: false, error: { message: string, stack?: string } }`.

The `TriggerEntry` SHALL NOT carry `tenant`, `workflow`, or `bundleSource` fields. Identity for the backend's internal bookkeeping SHALL be derived from the `tenant` argument to `reconfigure` combined with `descriptor.name` (and additional kind-specific descriptor fields where applicable). The `fire` callback SHALL capture all workflow-identity context inside its closure at construction time.

#### Scenario: Backend routes protocol event to fire

- **GIVEN** a TriggerSource holding a TriggerEntry for a given trigger
- **WHEN** a native protocol event arrives (HTTP request, cron tick, …)
- **THEN** the backend SHALL normalize the event into an `input: unknown` shape matching the descriptor's `inputSchema`
- **AND** the backend SHALL call `entry.fire(input)` and await the result
- **AND** the backend SHALL translate the result back into its native protocol response (HTTP response body/status, cron log, …)

#### Scenario: Backend never constructs fire itself

- **GIVEN** any TriggerSource implementation
- **WHEN** its source code is inspected
- **THEN** it SHALL NOT construct `fire` closures
- **AND** it SHALL NOT reference `executor.invoke`
- **AND** it SHALL NOT import from `packages/runtime/src/executor/`

### Requirement: Reconfigure is per-tenant full-replace

`TriggerSource.reconfigure(tenant, entries)` SHALL atomically replace the backend's state for the given `tenant` with the provided `entries`. All previously-installed entries tagged with that tenant SHALL be discarded. An empty `entries` array SHALL remove the tenant's triggers for that kind.

The call SHALL be async and SHALL return `Promise<ReconfigureResult>` where:

```
type ReconfigureResult =
  | { ok: true }
  | { ok: false; errors: TriggerConfigError[] };
```

- `{ ok: true }` — the new entries are installed and active.
- `{ ok: false, errors }` — user-facing configuration errors detected during reconfiguration (e.g., invalid IMAP credentials, mailbox not found). The registry SHALL translate this to an HTTP `400` response from the upload API with the aggregated errors in the body.
- Thrown exception — backend-infrastructure failure (e.g., IMAP server unreachable, port bind failed). The registry SHALL translate this to an HTTP `500` response.

In-flight fires holding previously-captured closures SHALL continue running to completion. `reconfigure` SHALL NOT await them and SHALL NOT cancel them.

#### Scenario: Empty entries clears the tenant

- **GIVEN** a backend with entries installed for tenant `acme`
- **WHEN** `reconfigure("acme", [])` is called
- **THEN** the backend SHALL discard all of `acme`'s installed entries
- **AND** subsequent protocol events for `acme` SHALL NOT resolve to any `entry.fire` call

#### Scenario: Reconfigure is scoped by tenant

- **GIVEN** a backend with entries installed for tenants `acme` and `globex`
- **WHEN** `reconfigure("acme", newEntries)` is called
- **THEN** only `acme`'s entries SHALL be replaced
- **AND** `globex`'s entries SHALL be unaffected

#### Scenario: User-config error returns {ok: false}

- **GIVEN** a backend that detects an invalid configuration during reconfigure (e.g., IMAP credentials rejected by the provider with a 401)
- **WHEN** `reconfigure(tenant, entries)` is called with the offending entries
- **THEN** the backend SHALL return `{ ok: false, errors: [TriggerConfigError, …] }`
- **AND** the error entries SHALL include enough context to identify which trigger(s) failed (e.g., `descriptor.name`) and a human-readable `message`

#### Scenario: Backend-infra error throws

- **GIVEN** a backend whose infrastructure is unreachable (e.g., IMAP server returns a connection reset)
- **WHEN** `reconfigure(tenant, entries)` is called
- **THEN** the backend SHALL throw an error
- **AND** the registry SHALL map the throw to an HTTP `500` response (see `action-upload` spec)

#### Scenario: In-flight fires survive reconfigure

- **GIVEN** a backend is processing an in-flight fire call (its fire closure captured at time `t0`)
- **WHEN** `reconfigure(tenant, newEntries)` is called at time `t1 > t0` with a different entry set
- **THEN** the in-flight call SHALL complete against its originally-captured `fire` closure
- **AND** `reconfigure` SHALL NOT await the in-flight call
- **AND** new protocol events arriving after `t1` SHALL route against `newEntries`

### Requirement: TriggerConfigError shape

The runtime SHALL define `TriggerConfigError` as a record with the following fields:

- `backend: string` — the `kind` of the backend that produced the error (e.g., `"imap"`, `"cron"`).
- `trigger: string` — the `descriptor.name` of the offending trigger (or `"*"` if the error is not attributable to a single trigger).
- `message: string` — a human-readable description suitable for inclusion in the upload API response body.

`TriggerConfigError` SHALL NOT include stack traces, credentials, or any other potentially sensitive field that could leak into the upload API response.

#### Scenario: Error shape is minimal and safe

- **GIVEN** a TriggerConfigError returned from reconfigure
- **WHEN** it is serialized into the upload API response body
- **THEN** the serialized form SHALL contain exactly `{backend, trigger, message}` with no additional fields

### Requirement: Manual kind registered with a backend

The runtime's backend set SHALL include a `TriggerSource<"manual">` registered alongside the HTTP and cron backends. `reconfigureBackends` SHALL partition manifest trigger entries by `kind` and dispatch manual entries to the registered manual backend. If the manual backend is absent at runtime, `reconfigureBackends` SHALL classify the failure the same way it classifies an unknown kind (per the existing `action-upload` contract: `422` with a manifest-rejection error).

The manual backend's `reconfigure(tenant, entries)` SHALL always return `{ ok: true }` and SHALL NOT retain the entries, because the manual-fire path resolves entries directly from the workflow registry (`registry.getEntry`) rather than from any backend-held index.

#### Scenario: reconfigureBackends dispatches manual entries to the manual backend

- **GIVEN** a tenant manifest containing one http, one cron, and one manual trigger
- **WHEN** `reconfigureBackends(tenant, state)` is called
- **THEN** the http entry SHALL be dispatched to the HTTP backend
- **AND** the cron entry SHALL be dispatched to the cron backend
- **AND** the manual entry SHALL be dispatched to the manual backend
- **AND** each backend SHALL return `{ ok: true }` (the manual backend unconditionally so)

#### Scenario: Manual backend participates in ReconfigureResult aggregation

- **GIVEN** an upload that triggers `reconfigureBackends` for three kinds
- **WHEN** all backends resolve to `{ ok: true }`
- **THEN** the aggregated result SHALL be `{ ok: true }`
- **AND** the tarball SHALL be persisted

#### Scenario: Manual backend state survives reconfigure calls without allocation

- **GIVEN** a manual backend that has been `reconfigure`d many times across many tenants
- **WHEN** the backend is inspected
- **THEN** the backend SHALL hold no per-tenant map or index
- **AND** the backend SHALL hold no timer or middleware registration

