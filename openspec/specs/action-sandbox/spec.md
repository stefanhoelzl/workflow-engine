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
  | { ok: true; logs: LogEntry[] }
  | { ok: false; error: { message: string; stack: string }; logs: LogEntry[] }
```

The `logs` field SHALL contain all bridge and console log entries from the action execution, in chronological order. The system SHALL NOT throw exceptions for action errors. Errors SHALL be returned as values.

#### Scenario: Successful action execution

- **GIVEN** action source code that completes without error
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: true, logs: [...] }`
- **AND** `logs` contains entries for all bridge calls made during execution

#### Scenario: Action throws an error

- **GIVEN** action source code containing `throw new Error("something broke")`
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: false, error: { message: "something broke", stack: "at <eval>:..." }, logs: [...] }`
- **AND** `logs` contains entries for all bridge calls made before the error

#### Scenario: Action rejects a promise

- **GIVEN** action source code that returns a rejected promise
- **WHEN** `spawn(source, ctx)` resolves
- **THEN** the result is `{ ok: false, error: { message, stack }, logs: [...] }` with the rejection reason

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
- `console.log(...args): void` — captures arguments to logs
- `console.info(...args): void` — captures arguments to logs
- `console.warn(...args): void` — captures arguments to logs
- `console.error(...args): void` — captures arguments to logs
- `console.debug(...args): void` — captures arguments to logs

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

#### Scenario: console.log captures to logs

- **GIVEN** action code that calls `console.log("hello", 42)`
- **WHEN** the action executes
- **THEN** `SandboxResult.logs` contains an entry with `method: "console.log"` and `args: ["hello", 42]`

#### Scenario: console.warn captures to logs

- **GIVEN** action code that calls `console.warn("slow query")`
- **WHEN** the action executes
- **THEN** `SandboxResult.logs` contains an entry with `method: "console.warn"` and `args: ["slow query"]`

#### Scenario: console.error captures to logs

- **GIVEN** action code that calls `console.error("failed:", { code: 500 })`
- **WHEN** the action executes
- **THEN** `SandboxResult.logs` contains an entry with `method: "console.error"` and `args: ["failed:", { code: 500 }]`

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

### Requirement: Bridge factory creation

The system SHALL provide a `createBridge(vm, runtime)` factory that returns a `Bridge` object scoped to a single QuickJS context. The factory SHALL create an internal `LogEntry[]` array and expose it as a readonly `logs` property.

#### Scenario: Factory creates bridge for a context

- **GIVEN** a QuickJS context `vm` and runtime `runtime`
- **WHEN** `createBridge(vm, runtime)` is called
- **THEN** a `Bridge` object is returned
- **AND** `b.vm` references the context
- **AND** `b.runtime` references the runtime
- **AND** `b.logs` is an empty array

### Requirement: Sync bridge registration

The `Bridge` SHALL provide a `sync(target, name, opts)` method that registers a synchronous bridge function on the target handle. The method SHALL:
1. Create a `vm.newFunction` with the given name
2. Extract args from QuickJS handles using the `opts.args` extractors
3. Call `opts.impl` with the extracted args
4. Marshal the return value via `opts.marshal`
5. Return the marshaled handle from the function callback (VM takes ownership)
6. Set the function on the target via `vm.setProp` and dispose the function handle
7. Push a `LogEntry` with timing, args, result, and status

#### Scenario: Register a sync bridge

- **GIVEN** a bridge instance `b` and a target handle
- **WHEN** `b.sync(target, "btoa", { args: [b.arg.string], marshal: b.marshal.string, impl: (str) => btoa(str) })` is called
- **THEN** a `btoa` function is set on the target
- **AND** calling `btoa("hello")` from guest code returns `"aGVsbG8="`

#### Scenario: Sync bridge error handling

- **GIVEN** a sync bridge whose impl throws an error
- **WHEN** the bridge function is called from guest code
- **THEN** a QuickJS error is thrown in the guest with the error message
- **AND** a LogEntry is pushed with `status: "failed"` and the `error` field set

### Requirement: Async bridge registration

The `Bridge` SHALL provide an `async(target, name, opts)` method that registers an asynchronous bridge function on the target handle. The method SHALL:
1. Create a `vm.newFunction` with the given name
2. Extract args from QuickJS handles using the `opts.args` extractors
3. Create a `vm.newPromise()` deferred
4. Return `deferred.handle` from the function callback (VM takes ownership)
5. Call `opts.impl` with the extracted args
6. On success: marshal the result, `deferred.resolve(handle)`, dispose the handle, call `runtime.executePendingJobs()`
7. On error: create `vm.newError`, `deferred.reject(errHandle)`, dispose, call `runtime.executePendingJobs()`
8. Push a `LogEntry` with timing, args, result/error, and status

#### Scenario: Register an async bridge

- **GIVEN** a bridge instance `b` and a target handle
- **WHEN** `b.async(target, "fetch", { args: [b.arg.string], marshal: b.marshal.json, impl: async (url) => fetchData(url) })` is called
- **THEN** a `fetch` function is set on the target
- **AND** calling `await fetch(url)` from guest code returns the marshaled result

#### Scenario: Async bridge error propagation

- **GIVEN** an async bridge whose impl rejects
- **WHEN** the bridge function is called from guest code
- **THEN** the QuickJS promise rejects with an error containing the rejection message
- **AND** `runtime.executePendingJobs()` is called
- **AND** a LogEntry is pushed with `status: "failed"` and the `error` field set

### Requirement: Typed arg extractors

The `Bridge` SHALL provide typed arg extractors under `b.arg` that extract values from QuickJS handles with compile-time type inference:

- `b.arg.string` — extracts via `vm.getString`, typed as `string`
- `b.arg.number` — extracts via `vm.getNumber`, typed as `number`
- `b.arg.json` — extracts via `vm.dump`, typed as `unknown`
- `b.arg.boolean` — extracts via `vm.dump`, typed as `unknown`

Each extractor SHALL support two modifiers:
- `.optional` — returns `T | undefined` when the handle is absent
- `.rest` — collects all remaining handles (must be the last arg)

The `impl` function parameter types SHALL be inferred from the `args` extractor tuple.

#### Scenario: String arg extraction

- **GIVEN** a sync bridge with `args: [b.arg.string]`
- **WHEN** guest code calls the bridge with `"hello"`
- **THEN** the impl receives `"hello"` as a `string`

#### Scenario: Optional arg is undefined when omitted

- **GIVEN** an async bridge with `args: [b.arg.string, b.arg.json.optional]`
- **WHEN** guest code calls the bridge with only one argument
- **THEN** the impl receives `(url, undefined)` where the second arg is `undefined`

#### Scenario: Rest arg collects remaining handles

- **GIVEN** a sync bridge with `args: [b.arg.json.rest]`
- **WHEN** guest code calls the bridge with three arguments
- **THEN** the impl receives all three values as an `unknown[]` array

### Requirement: Marshal helpers

The `Bridge` SHALL provide marshal helpers under `b.marshal` that convert host values to QuickJS handles:

- `b.marshal.string` — `vm.newString(value)`
- `b.marshal.number` — `vm.newNumber(value)`
- `b.marshal.json` — `vm.evalCode(JSON.stringify(value))` with error handling
- `b.marshal.boolean` — `vm.true` or `vm.false`
- `b.marshal.void` — `vm.undefined`

Custom marshal functions SHALL also be accepted: `marshal: (result) => QuickJSHandle`.

#### Scenario: String marshaling

- **GIVEN** a sync bridge with `marshal: b.marshal.string`
- **WHEN** the impl returns `"hello"`
- **THEN** the guest receives the string `"hello"`

#### Scenario: JSON marshaling

- **GIVEN** a sync bridge with `marshal: b.marshal.json`
- **WHEN** the impl returns `{ key: "value" }`
- **THEN** the guest receives the object `{ key: "value" }`

#### Scenario: Custom marshal function

- **GIVEN** an async bridge with `marshal: (response) => marshalResponse(b, response)`
- **WHEN** the impl returns a Response object
- **THEN** the custom marshal function is called with the Response
- **AND** the returned QuickJS handle is used to resolve the deferred promise

### Requirement: Method name override

The `sync` and `async` methods SHALL accept an optional `method` field in opts. When present, the LogEntry `method` field SHALL use this value instead of the `name` parameter. When absent, the LogEntry `method` field SHALL default to `name`.

#### Scenario: Default method name

- **GIVEN** `b.sync(target, "btoa", { ... })` with no `method` field
- **WHEN** the bridge is called
- **THEN** the LogEntry has `method: "btoa"`

#### Scenario: Overridden method name

- **GIVEN** `b.async(ctxHandle, "fetch", { method: "ctx.fetch", ... })`
- **WHEN** the bridge is called
- **THEN** the LogEntry has `method: "ctx.fetch"`

### Requirement: LogEntry structure

Each bridge invocation SHALL produce a `LogEntry` with:

```
type LogEntry = {
  method: string;
  args: unknown[];
  status: "ok" | "failed";
  result?: unknown;
  error?: string;
  ts: number;
  durationMs?: number | undefined;
};
```

- `method`: fully qualified call path (e.g., `"btoa"`, `"ctx.fetch"`, `"console.log"`)
- `args`: raw extracted argument values from the guest call
- `status`: `"ok"` on success, `"failed"` on error
- `result`: the host impl return value (undefined for void, present on success)
- `error`: the error message string (present on failure)
- `ts`: `Date.now()` timestamp at start of call
- `durationMs`: elapsed time from `performance.now()` measurements

#### Scenario: Successful bridge produces log entry

- **GIVEN** a sync bridge `btoa` called with `"hello"`
- **WHEN** the bridge succeeds and returns `"aGVsbG8="`
- **THEN** a LogEntry is pushed with `method: "btoa"`, `args: ["hello"]`, `status: "ok"`, `result: "aGVsbG8="`, `ts` and `durationMs` populated

#### Scenario: Failed bridge produces log entry

- **GIVEN** an async bridge `ctx.fetch` called with an unreachable URL
- **WHEN** the bridge fails with "Network error"
- **THEN** a LogEntry is pushed with `method: "ctx.fetch"`, `status: "failed"`, `error: "Network error"`, `ts` and `durationMs` populated

### Requirement: pushLog for non-factory bridges

The `Bridge` SHALL expose a `pushLog(entry: LogEntry)` method that appends to the shared logs array. This allows bridges that cannot use the factory (e.g., timers) to write log entries.

#### Scenario: Timer writes log entry via pushLog

- **GIVEN** a bridge instance `b` with a logs array
- **WHEN** `b.pushLog({ method: "setTimeout", args: [100], status: "ok", ts: Date.now() })` is called
- **THEN** the entry appears in `b.logs`
