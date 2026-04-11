### Requirement: QuickJS WASM sandbox execution

The system SHALL execute action source code inside a QuickJS WASM sandbox via `quickjs-emscripten` (sync variant, `RELEASE_SYNC`). The sandbox SHALL provide a hard isolation boundary where action code has no access to Node.js APIs, filesystem, network, or environment variables beyond what is explicitly exposed.

#### Scenario: Action code cannot access Node.js globals

- **GIVEN** action source code that references `process`, `require`, `fs`, or `globalThis.constructor`
- **WHEN** the action executes in the sandbox
- **THEN** a `ReferenceError` is thrown inside QuickJS
- **AND** the host process is unaffected

### Requirement: Sandbox interface

The system SHALL provide a `Sandbox` interface with a `spawn` method:

```
spawn(source: string, ctx: ActionContext, options?: SpawnOptions): Promise<SandboxResult>
```

Where `SpawnOptions` includes:
- `signal?: AbortSignal` — accepted but not acted upon
- `filename?: string` — filename for error stack traces (defaults to `"action.js"`)
- `exportName?: string` — the named export to extract from the module (defaults to `"default"`)

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

The system SHALL bridge `ctx.emit()` into the QuickJS sandbox using the deferred promise pattern: create a QuickJS promise via `vm.newPromise()`, perform the real async operation on the host, resolve the deferred when done, and call `vm.runtime.executePendingJobs()` to resume QuickJS execution.

Network access SHALL be provided by the global `fetch` polyfill (backed by the `__hostFetch` bridge), not by `ctx.fetch()`.

#### Scenario: ctx.emit bridges to host

- **GIVEN** action source code that calls `await ctx.emit("order.processed", { id: "123" })`
- **WHEN** the action executes in the sandbox
- **THEN** the host-side `ActionContext.emit()` is called with `("order.processed", { id: "123" })`
- **AND** the QuickJS promise resolves after the host emit completes

#### Scenario: fetch uses global polyfill

- **GIVEN** action source code that calls `await fetch("https://api.example.com", { method: "POST" })`
- **WHEN** the action executes in the sandbox
- **THEN** the whatwg-fetch polyfill creates an XHR which calls `__hostFetch`
- **AND** the action receives a spec-compliant Response with Headers, .json(), .text()

#### Scenario: Concurrent async operations work

- **GIVEN** action source code that calls `await Promise.all([fetch(url1), fetch(url2)])`
- **WHEN** the action executes in the sandbox
- **THEN** both requests run concurrently on the host
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

### Requirement: Safe globals

The sandbox SHALL expose the following globals and no others:
- `setTimeout(callback, delay): number` — delegates to Node.js `setTimeout`, returns the real timer ID
- `clearTimeout(id): void` — delegates to Node.js `clearTimeout`
- `setInterval(callback, delay): number` — delegates to Node.js `setInterval`, returns the real timer ID
- `clearInterval(id): void` — delegates to Node.js `clearInterval`
- `console.log(...args): void` — captures arguments to logs
- `console.info(...args): void` — captures arguments to logs
- `console.warn(...args): void` — captures arguments to logs
- `console.error(...args): void` — captures arguments to logs
- `console.debug(...args): void` — captures arguments to logs
- `crypto.randomUUID(): string`
- `crypto.getRandomValues(typedArray): number[]`
- `crypto.subtle.digest(algorithm, data): Promise<number[]>`
- `crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages): Promise<CryptoKeyHandle>`
- `crypto.subtle.exportKey(format, key): Promise<number[] | object>`
- `crypto.subtle.sign(algorithm, key, data): Promise<number[]>`
- `crypto.subtle.verify(algorithm, key, signature, data): Promise<boolean>`
- `crypto.subtle.encrypt(algorithm, key, data): Promise<number[]>`
- `crypto.subtle.decrypt(algorithm, key, data): Promise<number[]>`
- `crypto.subtle.generateKey(algorithm, extractable, keyUsages): Promise<CryptoKeyHandle | CryptoKeyPairHandle>`
- `crypto.subtle.deriveBits(algorithm, baseKey, length): Promise<number[]>`
- `crypto.subtle.deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages): Promise<CryptoKeyHandle>`
- `crypto.subtle.wrapKey(format, key, wrappingKey, wrapAlgo): Promise<number[]>`
- `crypto.subtle.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, keyUsages): Promise<CryptoKeyHandle>`
- `performance.now(): number`
- `__hostFetch(method, url, headers, body): Promise<{status, statusText, headers, body}>` — internal bridge for XHR polyfill

The following globals SHALL be provided by build-time polyfills (not runtime bridges):
- `btoa`, `atob`, `fetch`, `Headers`, `Request`, `Response`, `FormData`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `AbortController`, `Blob`, `structuredClone`, `ReadableStream`, `WritableStream`, `TransformStream`, `XMLHttpRequest`, `queueMicrotask`

Timer callbacks SHALL trigger `vm.runtime.executePendingJobs()` after execution to pump any pending QuickJS promises.

#### Scenario: btoa/atob encoding (via polyfill)

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

#### Scenario: crypto globals are available

- **GIVEN** action code that accesses `crypto.subtle` and `performance`
- **WHEN** the action executes
- **THEN** both are defined objects (not `undefined`)

#### Scenario: performance.now is available

- **GIVEN** action code that calls `performance.now()`
- **WHEN** the action executes
- **THEN** the result is a number >= 0

#### Scenario: fetch is a global (not ctx.fetch)

- **GIVEN** action code that calls `await fetch("https://api.example.com")`
- **WHEN** the action executes
- **THEN** the request is performed via the XHR polyfill → `__hostFetch` bridge
- **AND** the action receives a spec-compliant Response object

#### Scenario: Action code cannot access Node.js globals

- **GIVEN** action source code that references `process`, `require`, `fs`, or `globalThis.constructor`
- **WHEN** the action executes in the sandbox
- **THEN** a `ReferenceError` is thrown inside QuickJS
- **AND** the host process is unaffected

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

### Requirement: Action source as ES module

The sandbox SHALL evaluate action source code as an ES module using `vm.evalCode(source, filename, { type: "module" })`. The sandbox SHALL extract the handler function from the module namespace using `vm.getProp(moduleNamespace, exportName)` where `exportName` comes from `SpawnOptions` (defaulting to `"default"`). The handler SHALL be called with the bridged ctx object.

#### Scenario: Named export handler called

- **GIVEN** source code containing `var sendMessage = async (ctx) => { await ctx.emit("done", {}) }; export { sendMessage };`
- **AND** `options.exportName` is `"sendMessage"`
- **WHEN** `spawn(source, ctx, options)` is called
- **THEN** the `sendMessage` export is extracted from the module namespace and called with the QuickJS ctx handle
- **AND** `ctx.emit("done", {})` bridges to the host

#### Scenario: Default export handler called (backward compatibility)

- **GIVEN** source code `export default async (ctx) => { await ctx.emit("done", {}) }`
- **AND** no `exportName` is specified in options
- **WHEN** `spawn(source, ctx)` is called
- **THEN** the default export function is extracted and called with the QuickJS ctx handle
- **AND** `ctx.emit("done", {})` bridges to the host

#### Scenario: Module with bundled dependencies

- **GIVEN** source code that includes inlined npm library code and a named export handler that uses it
- **WHEN** `spawn(source, ctx, { exportName: "myAction" })` is called
- **THEN** the module evaluates successfully including the inlined library code
- **AND** the named export handler executes correctly using the library functions

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

### Requirement: crypto.randomUUID sync bridge

The sandbox SHALL expose `crypto.randomUUID()` as a sync bridge that delegates to Node.js `crypto.randomUUID()`. The return value SHALL be a string in UUID v4 format.

#### Scenario: Generate a UUID

- **GIVEN** action code that calls `crypto.randomUUID()`
- **WHEN** the action executes in the sandbox
- **THEN** the result is a string matching the pattern `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
- **AND** a LogEntry is pushed with `method: "randomUUID"` and `status: "ok"`

### Requirement: crypto.getRandomValues sync bridge

The sandbox SHALL expose `crypto.getRandomValues(typedArray)` as a sync bridge. The argument SHALL be a JSON number array representing the typed array. The bridge SHALL fill it with cryptographically secure random bytes via Node.js `crypto.getRandomValues()` and return the filled array as a JSON number array.

#### Scenario: Fill array with random bytes

- **GIVEN** action code that calls `crypto.getRandomValues(new Array(16).fill(0))`
- **WHEN** the action executes in the sandbox
- **THEN** the result is an array of 16 numbers
- **AND** the array is not all zeros (with overwhelming probability)
- **AND** a LogEntry is pushed with `method: "getRandomValues"` and `status: "ok"`

### Requirement: crypto.subtle.digest async bridge

The sandbox SHALL expose `crypto.subtle.digest(algorithm, data)` as an async bridge. The `algorithm` argument SHALL be a JSON object (e.g., `"SHA-256"` or `{ name: "SHA-256" }`). The `data` argument SHALL be a JSON number array representing bytes. The bridge SHALL delegate to Node.js `crypto.subtle.digest()` and return the hash as a JSON number array.

#### Scenario: Compute SHA-256 digest

- **GIVEN** action code that calls `await crypto.subtle.digest("SHA-256", [104, 101, 108, 108, 111])`
- **WHEN** the action executes in the sandbox
- **THEN** the result is a 32-element number array matching the SHA-256 hash of "hello"
- **AND** a LogEntry is pushed with `method: "crypto.subtle.digest"` and `status: "ok"`

#### Scenario: Digest with algorithm object

- **GIVEN** action code that calls `await crypto.subtle.digest({ name: "SHA-512" }, data)`
- **WHEN** the action executes
- **THEN** the result is a 64-element number array

### Requirement: crypto.subtle.importKey async bridge

The sandbox SHALL expose `crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages)` as an async bridge. For `"raw"`, `"pkcs8"`, and `"spki"` formats, `keyData` SHALL be a JSON number array converted to `Uint8Array`. For `"jwk"` format, `keyData` SHALL be a JSON object passed directly. The bridge SHALL delegate to Node.js `crypto.subtle.importKey()` and return a frozen CryptoKey handle object.

#### Scenario: Import raw HMAC key

- **GIVEN** action code that imports a raw key for HMAC-SHA256
- **WHEN** `await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])` resolves
- **THEN** the result is a frozen object with `type: "secret"`, `algorithm.name: "HMAC"`, `extractable: false`, `usages: ["sign", "verify"]`, and a numeric `__opaqueId`

#### Scenario: Import JWK key

- **GIVEN** action code that imports a JWK-format key
- **WHEN** `await crypto.subtle.importKey("jwk", jwkObject, algorithm, extractable, usages)` resolves
- **THEN** the result is a frozen CryptoKey handle object
- **AND** the JWK object is passed directly to Node.js without buffer conversion

### Requirement: crypto.subtle.sign async bridge

The sandbox SHALL expose `crypto.subtle.sign(algorithm, key, data)` as an async bridge. The `key` argument SHALL be a CryptoKey handle (object with `__opaqueId`). The bridge SHALL dereference the opaque handle to obtain the real CryptoKey, convert `data` from JSON number array to `Uint8Array`, delegate to Node.js `crypto.subtle.sign()`, and return the signature as a JSON number array.

#### Scenario: Sign data with HMAC key

- **GIVEN** an imported HMAC key handle and data bytes
- **WHEN** `await crypto.subtle.sign("HMAC", key, data)` resolves
- **THEN** the result is a number array containing the HMAC signature
- **AND** a LogEntry is pushed with `method: "crypto.subtle.sign"` and `status: "ok"`

#### Scenario: Sign with invalid key handle

- **GIVEN** action code that passes an invalid key reference to sign
- **WHEN** the bridge attempts to dereference the key
- **THEN** the promise rejects with an error
- **AND** a LogEntry is pushed with `status: "failed"`

### Requirement: crypto.subtle.verify async bridge

The sandbox SHALL expose `crypto.subtle.verify(algorithm, key, signature, data)` as an async bridge. The bridge SHALL dereference the key handle, convert `signature` and `data` from JSON number arrays to `Uint8Array`, delegate to Node.js `crypto.subtle.verify()`, and return a boolean.

#### Scenario: Verify valid signature

- **GIVEN** an HMAC key, data bytes, and a valid signature produced by `sign()`
- **WHEN** `await crypto.subtle.verify("HMAC", key, signature, data)` resolves
- **THEN** the result is `true`

#### Scenario: Verify tampered data

- **GIVEN** an HMAC key, a signature, and different data than what was signed
- **WHEN** `await crypto.subtle.verify("HMAC", key, signature, wrongData)` resolves
- **THEN** the result is `false`

### Requirement: crypto.subtle.encrypt and decrypt async bridges

The sandbox SHALL expose `crypto.subtle.encrypt(algorithm, key, data)` and `crypto.subtle.decrypt(algorithm, key, data)` as async bridges. The bridge SHALL dereference the key handle, resolve algorithm buffer fields (`iv`, `counter`, `additionalData`) from JSON number arrays to `Uint8Array`, convert `data`, delegate to Node.js, and return the result as a JSON number array.

#### Scenario: AES-GCM encrypt and decrypt round-trip

- **GIVEN** an AES-GCM key and plaintext bytes
- **WHEN** `await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, key, plaintext)` resolves
- **AND** `await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ciphertext)` resolves
- **THEN** the decrypted result matches the original plaintext

#### Scenario: Decrypt with wrong key fails

- **GIVEN** ciphertext encrypted with key A
- **WHEN** `await crypto.subtle.decrypt(algo, keyB, ciphertext)` is called
- **THEN** the promise rejects with an error
- **AND** a LogEntry is pushed with `status: "failed"`

### Requirement: crypto.subtle.generateKey async bridge

The sandbox SHALL expose `crypto.subtle.generateKey(algorithm, extractable, keyUsages)` as an async bridge. When the algorithm produces a single key (AES, HMAC), the bridge SHALL return a frozen CryptoKey handle. When the algorithm produces a key pair (RSA, EC), the bridge SHALL return a plain object with `publicKey` and `privateKey` fields, each a frozen CryptoKey handle.

#### Scenario: Generate AES-GCM key

- **GIVEN** action code that calls `await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])`
- **WHEN** the action executes
- **THEN** the result is a frozen CryptoKey handle with `type: "secret"` and a numeric `__opaqueId`

#### Scenario: Generate ECDSA key pair

- **GIVEN** action code that calls `await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])`
- **WHEN** the action executes
- **THEN** the result is `{ publicKey: { type: "public", ..., __opaqueId: N }, privateKey: { type: "private", ..., __opaqueId: M } }`
- **AND** both key objects are frozen

### Requirement: crypto.subtle.exportKey async bridge

The sandbox SHALL expose `crypto.subtle.exportKey(format, key)` as an async bridge. The bridge SHALL dereference the key handle and delegate to Node.js. For `"raw"`, `"pkcs8"`, `"spki"` formats, the result SHALL be a JSON number array. For `"jwk"` format, the result SHALL be a JSON object.

#### Scenario: Export raw key

- **GIVEN** an extractable AES key imported from raw bytes
- **WHEN** `await crypto.subtle.exportKey("raw", key)` resolves
- **THEN** the result is a number array matching the original key bytes

#### Scenario: Export as JWK

- **GIVEN** an extractable key
- **WHEN** `await crypto.subtle.exportKey("jwk", key)` resolves
- **THEN** the result is a JWK object with `kty`, `k`, and other fields

#### Scenario: Export non-extractable key fails

- **GIVEN** a key imported with `extractable: false`
- **WHEN** `await crypto.subtle.exportKey("raw", key)` is called
- **THEN** the promise rejects with an error

### Requirement: crypto.subtle.deriveBits and deriveKey async bridges

The sandbox SHALL expose `crypto.subtle.deriveBits(algorithm, baseKey, length)` and `crypto.subtle.deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages)` as async bridges. The bridge SHALL dereference the `baseKey` handle, resolve algorithm buffer fields (`salt`, `info`) and key fields (`public` for ECDH) via `resolveAlgo`, and delegate to Node.js. `deriveBits` SHALL return a JSON number array. `deriveKey` SHALL return a frozen CryptoKey handle.

#### Scenario: PBKDF2 deriveBits

- **GIVEN** a PBKDF2 base key, salt bytes, and iteration count
- **WHEN** `await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, baseKey, 256)` resolves
- **THEN** the result is a 32-element number array

#### Scenario: ECDH deriveKey with public key reference

- **GIVEN** an ECDH key pair where the algorithm references `{ name: "ECDH", public: otherPublicKey }`
- **WHEN** `deriveKey` is called with the algorithm containing an opaque key reference in the `public` field
- **THEN** the bridge dereferences the `public` field's opaque handle before calling Node.js

### Requirement: crypto.subtle.wrapKey and unwrapKey async bridges

The sandbox SHALL expose `crypto.subtle.wrapKey(format, key, wrappingKey, wrapAlgo)` and `crypto.subtle.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, keyUsages)` as async bridges. `wrapKey` SHALL dereference both `key` and `wrappingKey` handles and return the wrapped key as a JSON number array. `unwrapKey` SHALL dereference the `unwrappingKey` handle, convert `wrappedKey` from a JSON number array, and return a frozen CryptoKey handle.

#### Scenario: Wrap and unwrap key round-trip

- **GIVEN** a key to wrap and a wrapping key (AES-KW)
- **WHEN** `wrapKey("raw", keyToWrap, wrappingKey, "AES-KW")` resolves
- **AND** `unwrapKey("raw", wrappedBytes, wrappingKey, "AES-KW", { name: "AES-GCM", length: 256 }, true, ["encrypt"])` resolves
- **THEN** the unwrapped key is a valid CryptoKey handle

### Requirement: CryptoKey handle is a frozen metadata object

CryptoKey handles returned to the sandbox SHALL be frozen JavaScript objects containing:
- `type`: `"secret"`, `"public"`, or `"private"`
- `algorithm`: a snapshot of the key's algorithm parameters
- `extractable`: boolean
- `usages`: string array of key usages
- `__opaqueId`: numeric identifier referencing the real CryptoKey in the host opaque store

The object SHALL be created via `Object.freeze()` so that all properties are read-only. The actual CryptoKey material SHALL never enter QuickJS memory.

#### Scenario: Key handle properties are readable

- **GIVEN** an HMAC key imported with `extractable: true` and usages `["sign", "verify"]`
- **WHEN** the action inspects the key handle
- **THEN** `key.type` is `"secret"`, `key.extractable` is `true`, `key.usages` contains `"sign"` and `"verify"`, `key.algorithm.name` is `"HMAC"`

#### Scenario: Key handle is immutable

- **GIVEN** a CryptoKey handle in the sandbox
- **WHEN** the action attempts to set `key.__opaqueId = 999`
- **THEN** the assignment has no effect (object is frozen)
- **AND** subsequent use of the key still references the original CryptoKey

#### Scenario: Key material does not leak to guest

- **GIVEN** a non-extractable CryptoKey
- **WHEN** the action inspects all properties of the key handle
- **THEN** no raw key bytes are present — only `type`, `algorithm`, `extractable`, `usages`, and `__opaqueId`

### Requirement: performance.now sync bridge

The sandbox SHALL expose `performance.now()` as a sync bridge. The origin SHALL be captured at action setup time (when `setupPerformance()` is called inside `spawn()`). The return value SHALL be `performance.now() - origin` in milliseconds, representing elapsed time since the action started.

#### Scenario: performance.now returns elapsed time

- **GIVEN** action code that calls `performance.now()` at the start of the handler
- **WHEN** the action executes
- **THEN** the result is a number >= 0
- **AND** a LogEntry is pushed with `method: "performance.now"` and `status: "ok"`

#### Scenario: performance.now increases over time

- **GIVEN** action code that calls `performance.now()` before and after a `setTimeout(resolve, 50)`
- **WHEN** the action executes
- **THEN** the second call returns a value greater than the first

#### Scenario: performance.now origin is per-action

- **GIVEN** two separate `spawn()` calls
- **WHEN** each action calls `performance.now()` immediately
- **THEN** both return values near 0 (not accumulated from previous actions)

### Requirement: Bridge opaque reference store

The `Bridge` SHALL provide an opaque reference store for host objects that cannot be serialized into QuickJS. The store SHALL be scoped to a single bridge instance (one per `spawn()` call).

The `Bridge` interface SHALL expose:
- `storeOpaque(value: unknown): number` — stores a host object and returns a numeric ID
- `derefOpaque<T>(ref: unknown): T` — looks up a stored object by numeric ID or by an object with `__opaqueId` property; throws if the reference is invalid
- `opaqueRef: (value: unknown) => QuickJSHandle` — a marshal function that stores the value and returns `vm.newNumber(id)` (simple numeric handle)
- `dispose(): void` — clears the opaque store, releasing all stored references

#### Scenario: Store and retrieve an opaque reference

- **GIVEN** a bridge instance
- **WHEN** `b.storeOpaque(hostObject)` is called
- **THEN** a numeric ID is returned
- **AND** `b.derefOpaque(id)` returns the same `hostObject`

#### Scenario: Dereference from object with __opaqueId

- **GIVEN** a stored object with ID 1
- **WHEN** `b.derefOpaque({ __opaqueId: 1, type: "secret" })` is called
- **THEN** the stored object is returned

#### Scenario: Dereference invalid reference throws

- **GIVEN** a bridge instance with no stored objects
- **WHEN** `b.derefOpaque(999)` is called
- **THEN** an error is thrown with a message indicating the reference is invalid

#### Scenario: Dispose clears the opaque store

- **GIVEN** a bridge instance with stored objects
- **WHEN** `b.dispose()` is called
- **THEN** all stored references are released
- **AND** subsequent `derefOpaque` calls for those IDs throw

### Requirement: Bridge dispose in sandbox lifecycle

The sandbox `spawn()` method SHALL call `b.dispose()` in its finally block, after timer cleanup and before QuickJS context disposal. This ensures opaque host references are released even if the action fails.

#### Scenario: Dispose called after successful action

- **GIVEN** an action that creates CryptoKey handles
- **WHEN** the action completes successfully
- **THEN** `b.dispose()` is called in the finally block
- **AND** all opaque references are released

#### Scenario: Dispose called after failed action

- **GIVEN** an action that creates CryptoKey handles and then throws
- **WHEN** the action fails
- **THEN** `b.dispose()` is called in the finally block
- **AND** all opaque references are released

### Requirement: Polyfill virtual module

The vite plugin SHALL provide a virtual module `@workflow-engine/sandbox-globals` that, when imported, assigns Web API polyfills to `globalThis`. The module SHALL set up: `XMLHttpRequest` (via `mock-xmlhttprequest`), `fetch`/`Headers`/`Request`/`Response`/`FormData` (via `whatwg-fetch`), `URL`/`URLSearchParams` (via `url-polyfill`), `TextEncoder`/`TextDecoder` (via `fast-text-encoding`), `AbortController` (via `abort-controller`), `Blob` (via `blob-polyfill`), `btoa`/`atob` (via `abab`), `structuredClone` (via `@ungap/structured-clone`), `ReadableStream`/`WritableStream`/`TransformStream` (via `web-streams-polyfill`), and `queueMicrotask` (via `Promise.resolve().then(cb)`).

#### Scenario: All polyfilled globals are available in the sandbox

- **WHEN** an action executes in the sandbox after the virtual module has been bundled
- **THEN** `globalThis.URL`, `globalThis.TextEncoder`, `globalThis.TextDecoder`, `globalThis.Headers`, `globalThis.Request`, `globalThis.Response`, `globalThis.FormData`, `globalThis.AbortController`, `globalThis.Blob`, `globalThis.structuredClone`, `globalThis.ReadableStream`, `globalThis.btoa`, `globalThis.atob`, `globalThis.queueMicrotask` SHALL all be defined
- **AND** `globalThis.fetch` SHALL be a callable function

#### Scenario: URL polyfill works

- **WHEN** action code calls `new URL("https://example.com/path?q=1")`
- **THEN** `url.pathname` is `"/path"` and `url.searchParams.get("q")` is `"1"`

#### Scenario: TextEncoder/TextDecoder work

- **WHEN** action code calls `new TextEncoder().encode("hello")`
- **THEN** the result is a `Uint8Array` equivalent to `[104, 101, 108, 108, 111]`

#### Scenario: structuredClone works

- **WHEN** action code calls `structuredClone({ a: 1, b: [2, 3] })`
- **THEN** the result is a deep copy equal to `{ a: 1, b: [2, 3] }`

### Requirement: XHR onSend wired to __hostFetch

The virtual module SHALL configure `mock-xmlhttprequest`'s `onSend` hook to call the `__hostFetch` bridge function. The `onSend` handler SHALL extract `request.method`, `request.url`, `request.requestHeaders.getHash()`, and `request.body` and pass them to `__hostFetch`. When `__hostFetch` resolves, the handler SHALL call `request.respond(status, headers, body, statusText)` with the returned values.

#### Scenario: fetch calls __hostFetch via XHR

- **WHEN** action code calls `await fetch("https://api.example.com", { method: "POST", body: "data" })`
- **THEN** `__hostFetch` is called with method `"POST"`, url `"https://api.example.com"`, headers object, and body `"data"`
- **AND** the response from `__hostFetch` is used to call `request.respond()`
- **AND** the action receives a spec-compliant Response object with `.status`, `.headers.get()`, `.json()`, `.text()`

#### Scenario: fetch error propagates

- **WHEN** `__hostFetch` rejects with an error
- **THEN** the fetch promise in the action rejects with the error
- **AND** the action can catch it or let it propagate as a failed SandboxResult

### Requirement: Polyfill tree-shaking

The polyfill imports SHALL be bundled by Rollup as part of the workflow build. Unused polyfills SHALL be eliminated by tree-shaking. The polyfill module SHALL be injected into every workflow build regardless of whether the action uses the globals.

#### Scenario: Unused polyfills are eliminated

- **WHEN** a workflow action only uses `fetch` and `URL`
- **THEN** the bundled `actions.js` SHALL NOT contain the full `web-streams-polyfill` or `blob-polyfill` code
- **AND** the bundle size SHALL be proportional to the polyfills actually referenced

#### Scenario: Polyfills are injected even without explicit use

- **WHEN** a workflow action does not directly reference any polyfilled globals
- **THEN** the virtual module import SHALL still be present in the entry
- **AND** libraries imported by the action that reference globals SHALL find them on `globalThis`

### Requirement: __hostFetch async bridge

The sandbox SHALL expose a `__hostFetch(method, url, headers, body)` async bridge on `globalThis`. The bridge SHALL:
1. Perform a real HTTP request using Node.js `globalThis.fetch(url, { method, headers, body })`
2. Read the full response body as text
3. Collect response headers into a plain object
4. Return `{ status, statusText, headers, body }` as a JSON-marshalled result

#### Scenario: __hostFetch performs GET request

- **WHEN** the polyfill calls `__hostFetch("GET", "https://api.example.com/data", {}, null)`
- **THEN** Node.js `fetch` is called with `GET` method and the URL
- **AND** the result contains `status: 200`, `statusText: "OK"`, headers as an object, and body as a string

#### Scenario: __hostFetch performs POST with headers and body

- **WHEN** the polyfill calls `__hostFetch("POST", url, {"content-type": "application/json"}, '{"key":"value"}')`
- **THEN** Node.js `fetch` is called with `POST`, the headers, and the body
- **AND** the result reflects the server's response

#### Scenario: __hostFetch error logged

- **WHEN** Node.js `fetch` rejects (e.g., DNS failure)
- **THEN** the bridge promise rejects
- **AND** a LogEntry is pushed with `method: "xhr.send"`, `status: "failed"`, and the error message
