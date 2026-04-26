# Triggers Specification

## Purpose

Define the abstract trigger umbrella type and the contract for concrete trigger implementations. Triggers receive external stimuli and drive invocation lifecycle via the executor.
## Requirements
### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. The union contains four members: `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, `imapTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes HttpTrigger, CronTrigger, ManualTrigger, and ImapTrigger

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger`
- **AND** existing `HttpTrigger`, `CronTrigger`, and `ManualTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a fifth trigger kind
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended by union-append
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

The runtime SHALL define `TriggerEntry<D>` as an immutable record carrying exactly three fields:

- `readonly descriptor: D` — the kind-specific descriptor from the tenant manifest.
- `readonly fire: (input: unknown, dispatch?: DispatchMeta) => Promise<InvokeResult<unknown>>` — a callback that, when invoked, runs the workflow handler and returns a discriminated result `{ ok: true, output: unknown } | { ok: false, error: { message: string, stack?: string } }`.
- `readonly exception: (params: { name: string, error: { message: string }, details?: Readonly<Record<string, unknown>> }) => Promise<void>` — a callback for *author-fixable pre-dispatch failures* that occur outside any handler run (e.g. IMAP misconfig, broken cron expression). Calling `exception` produces exactly one `trigger.exception` leaf event on the bus, fully stamped with the `TriggerEntry`'s identity. The callback's identity binding (`owner`, `repo`, `workflow`, `descriptor`) is captured at construction time, parallel to `fire`. Failure-category discriminator (`name`) and stage-specific payload (`details`) are call-time so a single source can surface multiple failure categories without re-binding.

Where `DispatchMeta` is `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. When the caller omits `dispatch`, the `fire` closure SHALL treat the dispatch as `{ source: "trigger" }` and forward that default to the executor so that every invocation carries dispatch provenance (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent").

The `TriggerEntry` SHALL NOT carry `tenant`, `workflow`, or `bundleSource` fields. Identity for the backend's internal bookkeeping SHALL be derived from the `tenant` argument to `reconfigure` combined with `descriptor.name` (and additional kind-specific descriptor fields where applicable). Both the `fire` and `exception` callbacks SHALL capture all workflow-identity context inside their closures at construction time.

Trigger-source backends SHALL call `fire(input)` without a dispatch argument — they always represent non-manual dispatches. Only the kind-agnostic UI endpoint at `/trigger/*` SHALL pass a dispatch argument, and only with `source: "manual"` (see `trigger-ui` spec).

Trigger-source backends SHALL call `exception(params)` for any author-fixable pre-dispatch failure they want to surface to the dashboard. Backends SHALL NOT emit `trigger.exception` events directly via the `EventBus`, the executor, or any free-floating stamping helper — the `entry.exception` callable is the source's only outbound channel for failure events, mirroring the `entry.fire` callable for handler dispatch. Engine-bug failures (e.g. `entry.fire` itself throws) are out of scope and SHALL be reported via `Logger.error` only, with no event.

#### Scenario: Backend routes protocol event to fire

- **GIVEN** a TriggerSource holding a TriggerEntry for a given trigger
- **WHEN** a native protocol event arrives (HTTP request, cron tick, …)
- **THEN** the backend SHALL normalize the event into an `input: unknown` shape matching the descriptor's `inputSchema`
- **AND** the backend SHALL call `entry.fire(input)` without a dispatch argument and await the result
- **AND** the backend SHALL translate the result back into its native protocol response (HTTP response body/status, cron log, …)

#### Scenario: UI endpoint passes manual dispatch

- **GIVEN** the `/trigger/*` middleware handling an authenticated user's Submit click
- **WHEN** the middleware calls `entry.fire(input, { source: "manual", user: { name, mail } })`
- **THEN** the fire closure SHALL forward that dispatch to `executor.invoke` unchanged

#### Scenario: Backend never constructs fire itself

- **GIVEN** any TriggerSource implementation
- **WHEN** its source code is inspected
- **THEN** it SHALL NOT construct `fire` closures
- **AND** it SHALL NOT reference `executor.invoke`
- **AND** it SHALL NOT import from `packages/runtime/src/executor/`
- **AND** it SHALL NOT construct a `DispatchMeta` value with `source: "manual"`

#### Scenario: Omitted dispatch defaults to trigger

- **GIVEN** a fire closure built by `buildFire`
- **WHEN** the closure is invoked as `fire(validInput)` with no second argument
- **THEN** the closure SHALL call `executor.invoke(..., { bundleSource, dispatch: { source: "trigger" } })` or equivalently `executor.invoke(..., { bundleSource })` with the executor defaulting internally

#### Scenario: Backend surfaces pre-dispatch failure via entry.exception

- **GIVEN** a TriggerSource that detects an author-fixable pre-dispatch failure (e.g. IMAP `connect-failed`, search expression rejected) for a particular `TriggerEntry`
- **WHEN** the backend wants the failure to appear in the dashboard
- **THEN** the backend SHALL call `entry.exception({ name, error, details })` exactly once
- **AND** the call SHALL produce exactly one `trigger.exception` event on the bus, fully stamped with the entry's identity (`owner`, `repo`, `workflow`, `workflowSha`, a fresh `evt_*` invocationId)
- **AND** the backend SHALL NOT emit any other event for that failure

#### Scenario: Backend never constructs exception itself

- **GIVEN** any TriggerSource implementation
- **WHEN** its source code is inspected
- **THEN** it SHALL NOT construct `exception` closures
- **AND** it SHALL NOT reference `executor.fail`
- **AND** it SHALL NOT import the `EventBus` or any direct `trigger.exception` stamping helper
- **AND** the only outbound channel for trigger failures SHALL be `entry.exception(params)` on each `TriggerEntry`

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

### Requirement: createTriggerPlugin factory

The runtime package SHALL export a `createTriggerPlugin(): Plugin` factory. The plugin SHALL implement `onBeforeRunStarted(runInput)` to emit `ctx.emit("trigger.request", runInput.name, { input: runInput.input }, { createsFrame: true })` and return truthy (creating a parent frame that nested fetch/timer/action events inherit via their `ref`). The plugin SHALL implement `onRunFinished(result, runInput)` to emit either `trigger.response` (when `result.ok`) or `trigger.error` (when `!result.ok`) with `closesFrame: true`, carrying the original `input` plus `output` or `error` as appropriate.

#### Scenario: Run emits trigger.request / trigger.response pair

- **GIVEN** a sandbox with `createTriggerPlugin()` composed and a run whose guest export returns `{ status: "ok" }`
- **WHEN** `sandbox.run("doWork", { foo: "bar" })` is called
- **THEN** `trigger.request` SHALL be emitted before guest-export invocation with `createsFrame: true`, `name: "doWork"`, `input: { foo: "bar" }`
- **AND** `trigger.response` SHALL be emitted after guest-export completion with `closesFrame: true`, `input: { foo: "bar" }`, `output: { status: "ok" }`
- **AND** `trigger.response.ref` SHALL equal `trigger.request.seq`

#### Scenario: Guest throw emits trigger.error

- **GIVEN** a guest export that throws `new Error("fail")`
- **WHEN** the run executes
- **THEN** `trigger.request` SHALL fire first (createsFrame)
- **AND** `trigger.error` SHALL fire with `closesFrame: true` and a serialized representation of the thrown error
- **AND** `sandbox.run()` SHALL return `{ ok: false, error }` with the matching serialized error

#### Scenario: Nested events inherit trigger.request as parent ref

- **GIVEN** a run where the guest calls `await fetch(url)` during execution
- **WHEN** the fetch plugin emits `fetch.request`
- **THEN** `fetch.request.ref` SHALL equal `trigger.request.seq` (the frame preserved by trigger plugin's `onBeforeRunStarted` returning truthy)

### Requirement: Trigger plugin is optional

The sandbox core SHALL NOT require the trigger plugin to be composed. A composition without the trigger plugin SHALL execute runs normally but SHALL emit no `trigger.*` events. This is valid for tests and for use cases wanting silent runs.

#### Scenario: Composition without trigger plugin

- **GIVEN** a sandbox composed without `createTriggerPlugin()`
- **WHEN** `sandbox.run("doWork", input)` executes
- **THEN** no `trigger.*` events SHALL be emitted
- **AND** `sandbox.run()` SHALL still return a `RunResult`
- **AND** guest code SHALL execute normally

### Requirement: Reserved `trigger.` event-kind prefix

The `trigger.` event-kind prefix SHALL be reserved for the trigger plugin. Third-party plugins SHALL NOT emit events whose kind starts with `trigger.` (per `SECURITY.md §2 R-7`). Enforcement is plugin-author discipline; the sandbox core SHALL NOT reject such emissions at emit time.

#### Scenario: Only trigger plugin emits trigger.* events

- **GIVEN** a production sandbox composition including `createTriggerPlugin()`
- **WHEN** inspecting every other plugin's source (web-platform, fetch, timers, console, host-call-action, sdk-support, wasi-telemetry)
- **THEN** no other plugin SHALL invoke `ctx.emit("trigger.*", ...)` or `ctx.request("trigger", ...)`
- **AND** every `trigger.request` / `trigger.response` / `trigger.error` event in the stream SHALL originate from the trigger plugin's hooks

