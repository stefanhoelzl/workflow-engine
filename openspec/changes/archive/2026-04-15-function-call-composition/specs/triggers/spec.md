## ADDED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. In v1 the union contains exactly one member: `HttpTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing `cronTrigger`
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended to `HttpTrigger | CronTrigger`
- **AND** existing `HttpTrigger` consumers SHALL continue to compile without change

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

## REMOVED Requirements

### Requirement: HTTP trigger payload shape

**Reason**: HTTP-specific behavior moved to the new `http-trigger` capability spec. The `triggers` spec retains only the abstract umbrella concerns; concrete trigger types own their payload shape, factory, registry, and middleware.

**Migration**: See `http-trigger` capability spec for the unchanged payload shape (`body`, `headers`, `url`, `method`, `params`, `query`).

### Requirement: http() helper function

**Reason**: Replaced by the `httpTrigger({ path, method?, body?, query?, params?, handler })` factory in the SDK, defined under the `http-trigger` capability. The previous `http(config)` returned a `TriggerDef` to be passed to `WorkflowBuilder.trigger(name, def)`; the new `httpTrigger({...})` returns a complete branded `HttpTrigger` directly.

**Migration**: Replace `.trigger("name", http({ path, body }))` with `export const name = httpTrigger({ path, body, handler })`.

### Requirement: HttpTriggerDefinition is a pure data type

**Reason**: Moved to `http-trigger` capability spec.

**Migration**: See `http-trigger` capability spec.

### Requirement: HttpTriggerRegistry resolves defaults on registration

**Reason**: Static `response` config no longer exists; the handler's return value is the response. Method default (`POST`) is preserved. Moved to `http-trigger` capability spec.

**Migration**: See `http-trigger` capability spec for the simplified registry behavior.

### Requirement: HttpTriggerRegistry supports registration and lookup

**Reason**: Moved to `http-trigger` capability spec; behavior unchanged.

**Migration**: See `http-trigger` capability spec.

### Requirement: httpTriggerMiddleware matches requests under /webhooks/

**Reason**: Moved to `http-trigger` capability spec; behavior changes (middleware delegates to executor instead of `EventSource.create`; the trigger's handler return value becomes the response instead of a static configured response).

**Migration**: See `http-trigger` capability spec for the new middleware behavior.

### Requirement: Static paths take priority over parameterized paths

**Reason**: Moved to `http-trigger` capability spec; behavior unchanged.

**Migration**: See `http-trigger` capability spec.

### Requirement: Template literal type inference for path params

**Reason**: Moved to `http-trigger` capability spec; behavior unchanged.

**Migration**: See `http-trigger` capability spec.

### Requirement: Optional params Zod schema with key enforcement

**Reason**: Moved to `http-trigger` capability spec; behavior unchanged.

**Migration**: See `http-trigger` capability spec.

### Requirement: Build-time param name extraction

**Reason**: Moved to `workflow-manifest` capability; the manifest entry shape for triggers is documented there.

**Migration**: See `workflow-manifest` capability spec.

### Requirement: Security context

**Reason**: Moved to `http-trigger` capability spec because the threat model in `/SECURITY.md §3` is specifically about HTTP webhook ingress.

**Migration**: See `http-trigger` capability spec.
