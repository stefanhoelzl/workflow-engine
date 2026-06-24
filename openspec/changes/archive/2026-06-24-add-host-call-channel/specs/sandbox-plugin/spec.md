## ADDED Requirements

### Requirement: Plugin context host-call method

The plugin context passed to a plugin's `worker()` SHALL expose `callHost(method, args): Promise<unknown>` that issues a `host-call-request` and resolves or rejects with the corresponding `host-call-response`. The context type SHALL be generic over a `HostApi` describing the methods a plugin may call, defaulting to no host calls (an untyped transport) for plugins that do not use it.

`callHost` SHALL be available only to plugin worker-side code. It SHALL NOT be installed on the guest `globalThis` or otherwise be reachable from guest code; guest code reaches the host only through a plugin's guest-facing function, never `callHost` directly.

#### Scenario: Plugin calls a host method and awaits the result

- **GIVEN** a plugin whose `worker()` handler calls `ctx.callHost("echo", ["hi"])`
- **WHEN** the registered main-side handler returns `"hi"`
- **THEN** the awaited call SHALL resolve to `"hi"`

#### Scenario: Calling an unregistered method rejects

- **GIVEN** a plugin that calls `ctx.callHost("nope", [])` with no `"nope"` handler registered
- **WHEN** the call is issued
- **THEN** the returned promise SHALL reject with an error naming `"nope"`

#### Scenario: Guest code cannot reach callHost

- **GIVEN** a constructed sandbox
- **WHEN** guest code inspects `globalThis` for a host-call primitive
- **THEN** no `callHost` (or equivalent) SHALL be present on the guest global scope

### Requirement: Host-call typing and validation convention

A host-backed capability SHALL declare its methods in a contract module of Zod `{ args, result }` schemas; the `HostApi` type SHALL be derived from that module via `z.infer`. The worker side SHALL consume only the type (`import type`) so that no contract or Zod values enter the worker bundle.

The main side SHALL validate a host-call's `args` against the contract before invoking the handler, and SHALL validate (and MAY coerce, e.g. for non-JSON types) the handler's result before posting the response. A `defineHostMethod(name, contract, handler)` helper SHALL wrap a handler with this validation and contribute it to the `hostHandlers` map.

#### Scenario: Args failing validation reject before the handler runs

- **GIVEN** a host method whose contract requires a string first argument
- **WHEN** a host-call arrives with a numeric first argument
- **THEN** validation SHALL fail on the main side and the handler body SHALL NOT run
- **AND** the worker's awaited call SHALL reject

#### Scenario: Result coercion applied before crossing back

- **GIVEN** a contract whose result schema transforms a non-JSON value into a JSON-safe one
- **WHEN** the handler returns the non-JSON value
- **THEN** the coerced JSON-safe value SHALL be what crosses back to the worker

#### Scenario: Worker bundle carries no contract values

- **GIVEN** a plugin that types `callHost` from a contract module via `import type`
- **WHEN** the plugin's `workerSource` is built
- **THEN** the bundle SHALL NOT contain the contract module's Zod values
