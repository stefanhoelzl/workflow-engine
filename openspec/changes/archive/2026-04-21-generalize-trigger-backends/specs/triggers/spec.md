## ADDED Requirements

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
