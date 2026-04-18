## MODIFIED Requirements

### Requirement: Sandbox factory public API

The sandbox package SHALL export a `createSandboxFactory({ logger })` factory that returns a `SandboxFactory` instance.

```ts
interface SandboxFactory {
  create(source: string, options?: SandboxOptions): Promise<Sandbox>
  dispose(): Promise<void>
}

function createSandboxFactory(opts: { logger: Logger }): SandboxFactory
```

The `SandboxFactory` SHALL be a construction primitive: it SHALL create new `Sandbox` instances on every `create` call and SHALL NOT cache instances by source. Tenant-scoped sandbox reuse SHALL be provided by a runtime-owned `SandboxStore` (see the `sandbox-store` capability), not by the factory.

#### Scenario: Factory is exported from the sandbox package

- **GIVEN** the monorepo at `packages/sandbox`
- **WHEN** a consumer imports from `@workflow-engine/sandbox`
- **THEN** `createSandboxFactory` and the `SandboxFactory` type SHALL be exported as named exports

#### Scenario: Factory accepts a logger

- **GIVEN** a consumer with an injected logger compatible with the project's `Logger` interface
- **WHEN** `createSandboxFactory({ logger })` is called
- **THEN** the returned factory SHALL retain a reference to that logger for all operational log output

#### Scenario: Every create constructs a new Sandbox

- **GIVEN** a factory
- **WHEN** `factory.create(source)` is called twice with the same source
- **THEN** the factory SHALL invoke `sandbox(source, {}, options)` twice
- **AND** SHALL resolve to two distinct `Sandbox` instances

### Requirement: Factory-wide dispose

The factory SHALL expose a `dispose(): Promise<void>` method that disposes every `Sandbox` instance it has created (and not yet itself disposed) and clears its internal tracking set. After `dispose()`, calls to `create(source)` SHALL resume creating fresh sandboxes as normal.

#### Scenario: Dispose tears down all created sandboxes

- **GIVEN** a factory that has created `N` `Sandbox` instances, none of which have been individually disposed
- **WHEN** `factory.dispose()` is called
- **THEN** each tracked instance SHALL have `dispose()` invoked on it
- **AND** the internal tracking set SHALL be empty after the call resolves

#### Scenario: Create after dispose spawns fresh

- **GIVEN** a factory whose `dispose()` has resolved
- **WHEN** `factory.create(source)` is called for any source
- **THEN** the factory SHALL invoke `sandbox(source, {}, ...)` to construct a new instance

### Requirement: Factory operational logging

The factory SHALL emit operational log entries via its injected logger for the following lifecycle events:

- `info` when a new `Sandbox` is created: include a stable source identifier (e.g. a short hash) and the construction duration in milliseconds.
- `info` when a `Sandbox` is disposed: include the source identifier and the disposal trigger (`"factory.dispose"`).

Operational log entries SHALL NOT be merged into `RunResult.logs`; the per-run bridge log stream remains guest-only.

#### Scenario: Creation is logged

- **GIVEN** a factory with an injected logger spy
- **WHEN** `factory.create(source)` resolves
- **THEN** the logger SHALL receive a single `info` call carrying a source identifier and a `durationMs` field

#### Scenario: Factory-wide disposal is logged

- **GIVEN** a factory with tracked sandboxes and an injected logger spy
- **WHEN** `factory.dispose()` is called and resolves
- **THEN** the logger SHALL receive one `info` call per disposed sandbox carrying the source identifier and `reason: "factory.dispose"`

### Requirement: Consumer lifecycle ownership

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on process shutdown. Tenant-scoped sandbox reuse and the decision of when to build a new sandbox SHALL be owned by the runtime-level `SandboxStore` (see the `sandbox-store` capability); consumers SHOULD depend on `SandboxStore` rather than `SandboxFactory` directly.

#### Scenario: Store is the documented consumer

- **GIVEN** a runtime consumer that needs to dispatch trigger handlers
- **WHEN** it needs a `Sandbox` for a `(tenant, workflow)` pair
- **THEN** it SHALL obtain the sandbox via `SandboxStore.get(tenant, workflow, bundleSource)`
- **AND** it SHALL NOT call `SandboxFactory.create` directly

## REMOVED Requirements

### Requirement: Factory lazy-cached create

**Reason**: The source-keyed cache was never exercised by the runtime — per-workflow `__hostCallAction` closures prevent two workflows from sharing a sandbox even if they share a bundle source. Tenant-scoped caching now lives in the runtime's `SandboxStore` keyed by `(tenant, workflow.sha)`, which is the actual identity the runtime uses.

**Migration**: Callers needing cross-call sandbox reuse SHALL use `SandboxStore.get(tenant, workflow, bundleSource)` from the runtime package. Direct `factory.create(source)` now always constructs a new sandbox.

### Requirement: Factory death monitoring and eviction

**Reason**: The factory's `onDied`-triggered cache eviction existed solely to support the lazy-cached `create` above. With caching removed from the factory, there is nothing to evict. Each `Sandbox` still exposes `onDied(cb)` to its owner; the owner (currently the `SandboxStore`) MAY attach handlers if it wishes, but this is not required in the present change.

**Migration**: Code that previously relied on the factory to evict dead sandboxes SHALL attach its own `onDied` handler to each `Sandbox` returned by `factory.create`.

### Requirement: Factory eval-failure policy

**Reason**: Moved into the construction-only semantics of the new `Factory public API`. `factory.create(source)` propagates `sandbox(...)` construction errors as a rejected promise; retries are allowed and construct fresh each time because the factory no longer caches anything — cached or not makes no difference in the new shape.

**Migration**: Callers SHALL continue to treat `factory.create(source)` rejections as fatal for the calling request. No behavior change from the caller's perspective.
