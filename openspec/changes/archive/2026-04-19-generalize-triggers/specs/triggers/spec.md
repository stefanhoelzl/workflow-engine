## MODIFIED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. In v1 the union contains exactly one member: `HttpTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`), its own brand symbol, and its own concrete type.

Every concrete trigger type SHALL conform to the shape `{ inputSchema: z.ZodType, outputSchema: z.ZodType, handler: (input) => Promise<output> }` in addition to its kind-specific config fields. `inputSchema` SHALL fully describe the handler's input; `outputSchema` SHALL fully describe the handler's return value. The host-side shared validator uses `inputSchema` to validate raw input from the source; the SDK derives both schemas automatically from the factory config (e.g., `httpTrigger` synthesises the composite `{ body, headers, url, method, params, query }` schema).

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing `cronTrigger`
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended to `HttpTrigger | CronTrigger`
- **AND** existing `HttpTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger carries inputSchema and outputSchema

- **GIVEN** any concrete trigger factory returning a branded trigger
- **WHEN** the trigger is inspected
- **THEN** the trigger SHALL expose `inputSchema` and `outputSchema` as Zod schemas describing its handler's input and return value

### Requirement: Trigger has exactly one handler

A trigger SHALL declare exactly one `handler` function with signature `(input: z.infer<inputSchema>) => Promise<z.infer<outputSchema>>`. There are no subscribers, no fan-out, and no `emit()` from inside trigger handlers. The handler's return value SHALL be the basis for the trigger source's response (the HTTP response for `HttpTrigger`, logging only for hypothetical `CronTrigger`, etc.).

#### Scenario: Trigger declares one handler

- **GIVEN** any concrete trigger factory
- **WHEN** the trigger is created
- **THEN** the trigger SHALL carry exactly one `handler` function taking `input` conforming to `inputSchema` and returning a value conforming to `outputSchema`

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code. Every trigger kind SHALL have exactly one `TriggerSource` implementation in the runtime that binds to the kind's native ingress mechanism (HTTP server for `HttpTrigger`; scheduler for future `CronTrigger`; IMAP/SMTP listener for future `MailTrigger`).

#### Scenario: Trigger source bound at startup

- **GIVEN** the runtime starts with one or more HTTP triggers configured
- **WHEN** the runtime initializes
- **THEN** the HTTP `TriggerSource` SHALL be started before the HTTP server binds its port, and its middleware SHALL be mounted in the Hono chain

## ADDED Requirements

### Requirement: TriggerDescriptor is the parsed manifest instance type

The runtime SHALL define `TriggerDescriptor<K extends string>` as the discriminated-union type produced by parsing a manifest trigger entry. Every descriptor SHALL carry `{ kind: K, name: string, inputSchema: JSONSchema, outputSchema: JSONSchema }` plus kind-specific fields. `TriggerDescriptor` instances SHALL be what `WorkflowRegistry` exposes via its `TriggerSource` views and what `executor.invoke` receives as its second argument.

#### Scenario: HTTP descriptor carries kind and schemas

- **GIVEN** a workflow with one HTTP trigger named `submitForm`
- **WHEN** the manifest is parsed
- **THEN** the registry SHALL expose a `TriggerDescriptor<"http">` with `kind: "http"`, `name: "submitForm"`, `inputSchema`, `outputSchema`, and HTTP-specific fields (`path`, `method`, `body`, `params`, `query?`)

#### Scenario: Descriptor round-trips through executor

- **GIVEN** a `TriggerDescriptor<"http">` produced by the registry
- **WHEN** the HTTP source calls `executor.invoke(workflow, descriptor, input)`
- **THEN** the executor SHALL use `descriptor.kind` and `descriptor.name` when emitting `started`/`completed`/`failed` lifecycle events

### Requirement: TriggerSource interface

The runtime SHALL define a `TriggerSource<K extends string>` interface that every concrete trigger kind implements. The interface SHALL expose four members:

- `kind: K` — the trigger kind discriminator (e.g., `"http"`).
- `start(): Promise<void>` — invoked once during runtime startup before any workflows are served; for kinds with background work (schedulers, long-lived connections) this starts the loop. For passive kinds it MAY be a no-op.
- `stop(): Promise<void>` — invoked once during runtime shutdown; sources SHALL release all resources.
- `reconfigure(view: ReadonlyArray<TriggerViewEntry<K>>): void` — invoked by `WorkflowRegistry` on every workflow state change with the pre-filtered list of descriptors of kind `K`. Sources SHALL replace their internal index atomically.

`TriggerViewEntry<K>` SHALL carry `{ workflow: WorkflowRunner, descriptor: TriggerDescriptor<K> }`.

Sources SHALL NOT retain references to prior views after `reconfigure` returns.

#### Scenario: Source lifecycle is called in order

- **GIVEN** a runtime configured with one registered `TriggerSource`
- **WHEN** the runtime boots
- **THEN** `source.start()` SHALL be awaited before the HTTP server binds its port
- **WHEN** the runtime shuts down
- **THEN** `source.stop()` SHALL be awaited before the process exits

#### Scenario: Registry pushes reconfigure synchronously on tenant change

- **GIVEN** a registered `TriggerSource` of kind `"http"`
- **WHEN** a tenant manifest containing two HTTP triggers is uploaded via `WorkflowRegistry.register(...)`
- **THEN** `source.reconfigure(view)` SHALL be called synchronously as part of `register` with exactly those two entries

#### Scenario: View is pre-filtered by kind

- **GIVEN** a runtime with two registered sources of kinds `"http"` and `"cron"` and a tenant containing one HTTP trigger and one cron trigger
- **WHEN** the tenant is registered
- **THEN** the HTTP source's `reconfigure` view SHALL contain only the HTTP descriptor
- **AND** the cron source's `reconfigure` view SHALL contain only the cron descriptor

### Requirement: WorkflowRegistry is the plugin host for trigger sources

`WorkflowRegistry` SHALL accept a `sources: ReadonlyArray<TriggerSource>` field at construction. On every mutation of registry state (`register`, `remove`, `recover`, tenant replacement), the registry SHALL rebuild its internal descriptor view and invoke `source.reconfigure(viewForKind)` on every registered source before returning control to the caller. The registry SHALL NOT call `source.start` or `source.stop`; lifecycle remains the caller's responsibility.

#### Scenario: Reconfigure fires on register

- **WHEN** `registry.register(files)` succeeds
- **THEN** every registered source's `reconfigure` SHALL be invoked with the updated kind-filtered view

#### Scenario: Reconfigure fires on remove

- **WHEN** `registry.remove("foo")` is called
- **THEN** every registered source's `reconfigure` SHALL be invoked with a view that no longer contains "foo"'s triggers

#### Scenario: Reconfigure fires once on recover

- **GIVEN** the storage backend contains two tenant tarballs
- **WHEN** `registry.recover()` completes
- **THEN** every registered source SHALL have received at least one `reconfigure` call reflecting the fully recovered state

### Requirement: Sources call the shared executor

Every `TriggerSource` SHALL dispatch an incoming protocol event by calling `executor.invoke(workflow, descriptor, input)` on the shared `Executor` instance. Sources SHALL NOT bypass the executor or create parallel invocation paths.

#### Scenario: HTTP source dispatches via executor

- **GIVEN** an HTTP `TriggerSource` with a matched descriptor
- **WHEN** a request arrives for that descriptor
- **THEN** the source SHALL call `executor.invoke(workflow, descriptor, validatedInput)` exactly once for that request

#### Scenario: Sources share the per-workflow run queue

- **GIVEN** two hypothetical sources of different kinds both dispatching for workflow `w1` at the same time
- **WHEN** both sources call `executor.invoke(w1, ...)` concurrently
- **THEN** the executor's per-workflow run queue SHALL serialize the two invocations

### Requirement: Source failure isolation

A thrown exception inside a `TriggerSource` (other than inside `executor.invoke`) SHALL NOT propagate out of the runtime. Sources SHALL catch their own protocol-level errors and either return an appropriate protocol response or log-and-drop. Crashing a source SHALL NOT crash the runtime.

#### Scenario: HTTP source handler exception produces 500

- **GIVEN** an HTTP source whose middleware throws while serialising output
- **WHEN** a request arrives
- **THEN** the response SHALL be a `500` with an error body
- **AND** the runtime SHALL remain available for subsequent requests

#### Scenario: Async source loop recovers

- **GIVEN** a hypothetical cron-like source whose scheduler tick throws
- **WHEN** the tick fails
- **THEN** the source SHALL log the error and continue scheduling subsequent ticks

### Requirement: Trigger kinds are registered statically

Trigger kinds SHALL be wired into the runtime statically by `main.ts` constructing one `TriggerSource` per kind and passing the list to `createWorkflowRegistry({ sources, ... })`. The runtime SHALL NOT support dynamic plugin loading in v1; adding a new kind is a compile-time change.

#### Scenario: main.ts names every source

- **WHEN** the runtime boots
- **THEN** every registered `TriggerSource` SHALL be explicitly constructed in `main.ts` and passed into the registry via the `sources` field
