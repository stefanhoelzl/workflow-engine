## ADDED Requirements

### Requirement: QuickJS WASM sandbox execution

The system SHALL execute action source code inside a QuickJS WASM sandbox via `quickjs-emscripten` (sync variant, `RELEASE_SYNC`). The sandbox SHALL provide a hard isolation boundary where action code has no access to Node.js APIs, filesystem, network, or environment variables beyond what is explicitly exposed.

#### Scenario: Action code cannot access Node.js globals

- **GIVEN** action source code that references `process`, `require`, `fs`, or `globalThis.constructor`
- **WHEN** the action executes in the sandbox
- **THEN** a `ReferenceError` is thrown inside QuickJS
- **AND** the host process is unaffected

#### Scenario: Action code cannot access network directly

- **GIVEN** action source code that attempts to call `fetch("https://example.com")`
- **WHEN** the action executes in the sandbox
- **THEN** a `ReferenceError` is thrown (global `fetch` is not exposed)
- **AND** only `ctx.fetch()` is available for network access

### Requirement: Sandbox interface

The system SHALL provide a `Sandbox` interface with a `spawn` method:

```
spawn(source: string, ctx: ActionContext, signal?: AbortSignal): Promise<SandboxResult>
```

The `createSandbox()` factory SHALL instantiate the QuickJS WASM module once and return a `Sandbox` object. Each `spawn()` call SHALL create a fresh QuickJS context from the shared module.

#### Scenario: Sandbox created at startup

- **GIVEN** the runtime starting up
- **WHEN** `createSandbox()` is called
- **THEN** a `Sandbox` object is returned with a `spawn` method
- **AND** the QuickJS WASM module is instantiated once

#### Scenario: Spawn executes action in fresh context

- **GIVEN** a `Sandbox` instance
- **WHEN** `spawn(source, ctx)` is called twice with different sources
- **THEN** each invocation runs in its own QuickJS context
- **AND** no state leaks between invocations

### Requirement: SandboxResult discriminated union

The `spawn` method SHALL return a `Promise<SandboxResult>` where:

```
type SandboxResult =
  | { ok: true }
  | { ok: false; error: { message: string; stack: string } }
```

The system SHALL NOT throw exceptions for action errors. Errors SHALL be returned as values.

#### Scenario: Successful action execution

- **GIVEN** action source code that completes without error
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: true }`

#### Scenario: Action throws an error

- **GIVEN** action source code containing `throw new Error("something broke")`
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: false, error: { message: "something broke", stack: "at <eval>:..." } }`

#### Scenario: Action rejects a promise

- **GIVEN** action source code that returns a rejected promise
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: false, error: { message, stack } }` with the rejection reason

### Requirement: AbortSignal support

The `spawn` method SHALL accept an optional `AbortSignal`. In the initial implementation, the signal SHALL be accepted but not acted upon.

#### Scenario: Signal parameter accepted but ignored

- **GIVEN** a `Sandbox` instance
- **WHEN** `spawn(source, ctx, signal)` is called with an `AbortSignal`
- **THEN** the action executes normally regardless of signal state

### Requirement: Ctx bridging via deferred promises

The system SHALL bridge `ctx.emit()` and `ctx.fetch()` into the QuickJS sandbox using the deferred promise pattern: create a QuickJS promise via `vm.newPromise()`, perform the real async operation on the host, resolve the deferred when done, and call `vm.runtime.executePendingJobs()` to resume QuickJS execution.

#### Scenario: ctx.emit bridges to host

- **GIVEN** action source code that calls `await ctx.emit("order.processed", { id: "123" })`
- **WHEN** the action executes in the sandbox
- **THEN** the host-side `ActionContext.emit()` is called with `("order.processed", { id: "123" })`
- **AND** the QuickJS promise resolves after the host emit completes

#### Scenario: ctx.fetch bridges to host

- **GIVEN** action source code that calls `await ctx.fetch("https://api.example.com", { method: "POST" })`
- **WHEN** the action executes in the sandbox
- **THEN** the host-side `ActionContext.fetch()` is called with the URL and init
- **AND** the QuickJS promise resolves with a Response proxy

#### Scenario: Concurrent async operations work

- **GIVEN** action source code that calls `await Promise.all([ctx.fetch(url1), ctx.fetch(url2)])`
- **WHEN** the action executes in the sandbox
- **THEN** both fetches run concurrently on the host
- **AND** `Promise.all` resolves when both complete

### Requirement: ctx.event and ctx.env as serialized data

The system SHALL serialize `ctx.event` and `ctx.env` as JSON and inject them as read-only data into the QuickJS context.

#### Scenario: Action reads event payload

- **GIVEN** an event with payload `{ orderId: "123", total: 42 }`
- **WHEN** the action accesses `ctx.event.payload.orderId`
- **THEN** the value is `"123"`

#### Scenario: Action reads env variable

- **GIVEN** an action with env `{ API_KEY: "secret" }`
- **WHEN** the action accesses `ctx.env.API_KEY`
- **THEN** the value is `"secret"`

### Requirement: Fetch Response proxy

The `ctx.fetch()` method inside the sandbox SHALL return a Response proxy object with:
- `status` (number), `statusText` (string), `ok` (boolean), `url` (string) as properties
- `headers` as a QuickJS `Map` with lowercase-normalized keys
- `json()` as an async method that bridges to the host to read and parse the response body
- `text()` as an async method that bridges to the host to read the response body as text

#### Scenario: Action reads response status

- **GIVEN** action code that calls `const res = await ctx.fetch(url)`
- **WHEN** the host fetch returns status 200
- **THEN** `res.status` is `200`, `res.ok` is `true`

#### Scenario: Action reads response headers via Map

- **GIVEN** a response with header `Content-Type: application/json`
- **WHEN** the action accesses `res.headers.get("content-type")`
- **THEN** the value is `"application/json"`

#### Scenario: Action parses JSON response

- **GIVEN** a response with body `{"key": "value"}`
- **WHEN** the action calls `await res.json()`
- **THEN** the result is `{ key: "value" }` inside QuickJS

#### Scenario: Action reads text response

- **GIVEN** a response with body `"hello world"`
- **WHEN** the action calls `await res.text()`
- **THEN** the result is `"hello world"` inside QuickJS

### Requirement: Safe globals

The sandbox SHALL expose the following globals and no others:
- `btoa(string): string`
- `atob(string): string`
- `setTimeout(callback, delay): number` — delegates to Node.js `setTimeout`, returns the real timer ID
- `clearTimeout(id): void` — delegates to Node.js `clearTimeout`
- `setInterval(callback, delay): number` — delegates to Node.js `setInterval`, returns the real timer ID
- `clearInterval(id): void` — delegates to Node.js `clearInterval`

Timer callbacks SHALL trigger `vm.runtime.executePendingJobs()` after execution to pump any pending QuickJS promises.

#### Scenario: btoa/atob encoding

- **GIVEN** action code that calls `btoa("hello")`
- **WHEN** the action executes
- **THEN** the result is `"aGVsbG8="`

#### Scenario: setTimeout with real timer ID

- **GIVEN** action code that calls `const id = setTimeout(() => {}, 1000)`
- **WHEN** the action executes
- **THEN** `id` is a number (the real Node.js timer ID)
- **AND** `clearTimeout(id)` cancels the timer

#### Scenario: setTimeout callback pumps promises

- **GIVEN** action code `await new Promise(resolve => setTimeout(resolve, 100))`
- **WHEN** the timer fires
- **THEN** the callback executes inside QuickJS
- **AND** `executePendingJobs()` is called
- **AND** the promise resolves and the action continues

### Requirement: Context disposal

The system SHALL dispose the QuickJS context after every action execution, regardless of success or failure. All QuickJS handles created during the invocation SHALL be disposed.

#### Scenario: Context disposed after success

- **GIVEN** an action that completes successfully
- **WHEN** `spawn()` returns
- **THEN** the QuickJS context and all handles are disposed

#### Scenario: Context disposed after error

- **GIVEN** an action that throws an error
- **WHEN** `spawn()` returns
- **THEN** the QuickJS context and all handles are disposed
- **AND** no memory is leaked

### Requirement: Action source as default export module

The sandbox SHALL evaluate action source code that uses `export default async (ctx) => { ... }` format. The sandbox SHALL extract the default export and call it with the bridged ctx object.

#### Scenario: Default export handler called

- **GIVEN** source code `export default async (ctx) => { await ctx.emit("done", {}) }`
- **WHEN** `spawn(source, ctx)` is called
- **THEN** the default export function is called with the QuickJS ctx handle
- **AND** `ctx.emit("done", {})` bridges to the host
