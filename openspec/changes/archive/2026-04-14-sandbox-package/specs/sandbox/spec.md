## ADDED Requirements

### Requirement: Sandbox package

The system SHALL provide a workspace package `@workflow-engine/sandbox` at `packages/sandbox`. The package SHALL ship TypeScript source directly (no build step), mirroring the conventions of `@workflow-engine/sdk` and `@workflow-engine/vite-plugin`. The package SHALL depend on `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync`; these dependencies SHALL NOT be direct dependencies of `@workflow-engine/runtime`.

#### Scenario: Package exists as a workspace member

- **GIVEN** the monorepo at `packages/`
- **WHEN** a developer runs `pnpm install`
- **THEN** `packages/sandbox` SHALL be discovered as a workspace package
- **AND** its `package.json` SHALL declare `name: "@workflow-engine/sandbox"`

#### Scenario: Runtime imports from the sandbox package

- **GIVEN** `packages/runtime` as a consumer
- **WHEN** inspecting `packages/runtime/package.json`
- **THEN** it SHALL declare `"@workflow-engine/sandbox": "workspace:*"` as a dependency
- **AND** runtime source files SHALL import via `@workflow-engine/sandbox`, not via relative paths into another package

### Requirement: Public API — sandbox() factory

The sandbox package SHALL export a `sandbox(source, methods, options?)` async factory that returns a `Sandbox` instance.

```ts
function sandbox(
  source: string,
  methods: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: { filename?: string }
): Promise<Sandbox>
```

The factory SHALL:
1. Instantiate the QuickJS WASM module (shared lazily across calls).
2. Create a fresh `QuickJSRuntime` and `QuickJSContext` for this sandbox instance.
3. Install the built-in host bridges (console, timers, performance, crypto, `__hostFetch`).
4. Install each entry in `methods` as a top-level global function in the QuickJS context.
5. Evaluate `source` as an ES module with filename `options.filename` (default `"action.js"`).
6. Return a `Sandbox` object with a `run()` method.

If source evaluation fails, the returned promise SHALL reject with the evaluation error.

#### Scenario: Construction evaluates source once

- **GIVEN** a valid ES-module source string
- **WHEN** `sandbox(source, {})` is called
- **THEN** the source SHALL be evaluated exactly once at construction time
- **AND** the returned `Sandbox` object SHALL expose a `run` method

#### Scenario: Construction rejects on source parse error

- **GIVEN** a source string with a syntax error
- **WHEN** `sandbox(source, {})` is called
- **THEN** the returned promise SHALL reject with an error describing the syntax failure

#### Scenario: Construction-time methods are installed as globals

- **GIVEN** `sandbox(source, { hello: async (n) => n * 2 })`
- **WHEN** source code inside the sandbox calls `hello(21)`
- **THEN** the guest call SHALL resolve to `42`

### Requirement: Public API — Sandbox.run()

The `Sandbox` interface SHALL provide a `run(name, ctx, extraMethods?)` method that invokes a named export from the source module with `ctx` as the single argument.

```ts
interface Sandbox {
  run(
    name: string,
    ctx: unknown,
    extraMethods?: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<RunResult>
  dispose(): void
}
```

The method SHALL:
1. Clear the run-local log buffer.
2. If `extraMethods` is provided, install each entry as a top-level global; collision with a construction-time method name SHALL throw before invocation.
3. Look up the export `name` from the source module's namespace.
4. Call the export with `ctx` (JSON-serialized and re-evaluated inside the VM).
5. Await the result (QuickJS-side promise pumping via `executePendingJobs`).
6. Return a `RunResult` containing either the JSON-serialized return value or an error; `logs` contains every log entry pushed during this run.

Between runs, `extraMethods` installed by a prior run SHALL be removed before the next run installs its own.

#### Scenario: Named export called with ctx

- **GIVEN** a source with `export async function onFoo(ctx) { return ctx.n * 2; }`
- **AND** a sandbox constructed from that source
- **WHEN** `sb.run("onFoo", { n: 21 })` is called
- **THEN** the returned `RunResult` SHALL be `{ ok: true, result: 42, logs: [] }`

#### Scenario: Missing export yields error result

- **GIVEN** a sandbox whose source has no `nonexistent` export
- **WHEN** `sb.run("nonexistent", {})` is called
- **THEN** the returned `RunResult` SHALL have `ok: false` with an error describing the missing export

#### Scenario: extraMethods extend construction-time methods

- **GIVEN** a sandbox constructed with `methods = { base: async () => "base" }`
- **WHEN** `sb.run("action", ctx, { extra: async () => "extra" })` is called
- **THEN** the guest SHALL see both `base` and `extra` as global functions

#### Scenario: extraMethods shadowing is rejected

- **GIVEN** a sandbox constructed with `methods = { emit: async () => {} }`
- **WHEN** `sb.run("action", ctx, { emit: async () => {} })` is called
- **THEN** the run SHALL throw a collision error before the export is invoked
- **AND** no log entries SHALL be recorded for this attempt

#### Scenario: extraMethods are cleared between runs

- **GIVEN** a sandbox where `sb.run("a", ctx, { extra: f1 })` has completed
- **WHEN** `sb.run("b", ctx)` is called without `extraMethods`
- **THEN** the guest SHALL NOT see `extra` as a global

### Requirement: RunResult discriminated union

The `run()` method SHALL return `Promise<RunResult>` where:

```ts
type RunResult =
  | { ok: true;  result: unknown;                       logs: LogEntry[] }
  | { ok: false; error: { message: string; stack: string }; logs: LogEntry[] }
```

The method SHALL NOT throw for errors raised inside the sandbox; errors SHALL be returned as values. The method MAY throw for host-side programming errors (e.g., invalid extraMethods collision, sandbox already disposed).

The `logs` array SHALL contain all bridge and console log entries pushed during this run, in chronological order. The `result` field on success SHALL be the JSON-serialized return value of the invoked export (`undefined` serializes to absent).

#### Scenario: Successful invocation

- **GIVEN** a sandbox whose export resolves to `{ status: "ok" }`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: true, result: { status: "ok" }, logs: [...] }`

#### Scenario: Thrown error

- **GIVEN** a sandbox whose export throws `new Error("boom")`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: false, error: { message: "boom", stack: "..." }, logs: [...] }`

#### Scenario: Rejected promise

- **GIVEN** a sandbox whose export returns a promise that rejects with `new Error("fail")`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: false, error: { message: "fail", stack: "..." }, logs: [...] }`

### Requirement: LogEntry structure

The sandbox SHALL define `LogEntry`:

```ts
interface LogEntry {
  method: string
  args: unknown[]
  status: "ok" | "failed"
  result?: unknown
  error?: string
  ts: number
  durationMs?: number
}
```

Every host-bridged method call (construction-time method, per-run extraMethod, `__hostFetch`, crypto operation) SHALL push an entry before returning. Console calls (`console.log`, `.info`, `.warn`, `.error`, `.debug`) SHALL push entries with `method: "console.<level>"`. The log buffer SHALL be cleared at the start of each `run()` call and SHALL NOT persist across runs.

#### Scenario: Log buffer is per-run

- **GIVEN** a sandbox where `sb.run("a", ...)` produced 3 log entries
- **WHEN** `sb.run("b", ...)` is called
- **THEN** the `b` run's `RunResult.logs` SHALL NOT contain any entries from the `a` run

#### Scenario: Failed bridge logs a failed entry

- **GIVEN** a host method that throws
- **WHEN** the sandbox invokes it
- **THEN** a `LogEntry` with `status: "failed"` and a populated `error` SHALL be pushed

### Requirement: JSON-only host/sandbox boundary

All arguments and return values crossing the host/sandbox boundary via consumer-provided `methods` or `extraMethods` SHALL be JSON-serializable. The sandbox SHALL serialize host values to JSON when passing into the VM and SHALL deserialize VM values into host-native JSON values when returning.

The sandbox SHALL NOT expose host object references, closures, proxies, or any host-identity-carrying value to consumer methods.

Sandbox built-in bridges (crypto) MAY use an internal opaque-reference store to model host-resident resources (e.g., `CryptoKey`). Opaque references SHALL appear to guest code as frozen JSON objects of the form `{ __opaqueId: number, ...metadata }`; the id SHALL have no meaning outside the originating sandbox instance. The opaque-reference store SHALL NOT be exposed via the public API — consumers using `methods` and `extraMethods` cannot create, read, or dereference opaque refs.

#### Scenario: Consumer methods receive JSON args

- **GIVEN** a consumer method `f: async (x) => ...`
- **AND** guest code calls `f({ a: 1, b: [2, 3] })`
- **THEN** `f` SHALL receive `{ a: 1, b: [2, 3] }` as a plain JSON value (not a QuickJSHandle)

#### Scenario: Consumer methods return JSON results

- **GIVEN** a consumer method that returns `{ status: 200 }`
- **WHEN** guest code calls it
- **THEN** guest code SHALL observe the return value as a plain object with a numeric `status` field

#### Scenario: Opaque refs are not reachable via consumer methods

- **GIVEN** any consumer method signature
- **WHEN** reviewing the sandbox public API
- **THEN** there SHALL be no way to call `storeOpaque` / `derefOpaque` / `opaqueRef` from outside the sandbox package

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals: the host methods registered via `methods` / `extraMethods`, the built-in host-bridged globals (`console`, `performance.now`, `crypto`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `__hostFetch`), and the identifiers the workflow bundle's own polyfills install via `@workflow-engine/sandbox-globals` (fetch, Headers, Request, Response, URL, Blob, File, TextEncoder, TextDecoder, AbortController, atob, btoa, ReadableStream, etc.).

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

### Requirement: Source evaluated as ES module

The sandbox SHALL evaluate `source` as an ES module using `vm.evalCode(source, filename, { type: "module" })`. Named exports SHALL be extractable from the module namespace via `vm.getProp(moduleNamespace, name)`.

#### Scenario: Named export handler

- **GIVEN** a source exporting `export async function sendMessage(ctx) { ... }`
- **WHEN** `sb.run("sendMessage", ctx)` is called
- **THEN** the `sendMessage` function SHALL be extracted and called

#### Scenario: Module with bundled dependencies

- **GIVEN** a workflow bundle that imports from npm packages resolved by vite-plugin
- **WHEN** the sandbox evaluates the bundled module
- **THEN** evaluation SHALL succeed and named exports SHALL be callable

### Requirement: Workflow-scoped VM lifecycle

The sandbox SHALL hold a single `QuickJSRuntime` and `QuickJSContext` for its lifetime. The context SHALL NOT be disposed between `run()` calls. Module-level state, the internal opaque-reference store, and installed globals SHALL persist across `run()`s within the same sandbox instance.

The sandbox SHALL expose `dispose()` which disposes the QuickJS context, runtime, and opaque-reference store. After `dispose()`, subsequent `run()` calls SHALL throw.

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on workflow reload/unload.

#### Scenario: State persists across runs within a workflow

- **GIVEN** a sandbox whose source has `let count = 0; export function tick(ctx) { return ++count; }`
- **WHEN** `sb.run("tick", {})` is called three times
- **THEN** the three `result` values SHALL be 1, 2, 3

#### Scenario: Dispose releases QuickJS resources

- **GIVEN** a sandbox instance
- **WHEN** `sb.dispose()` is called
- **THEN** the QuickJS context and runtime SHALL be disposed
- **AND** subsequent `sb.run(...)` calls SHALL throw

#### Scenario: Cross-sandbox isolation preserved

- **GIVEN** two sandbox instances constructed from different sources
- **WHEN** both execute concurrently
- **THEN** module-level state in one sandbox SHALL NOT be observable from the other
- **AND** opaque-reference ids from one sandbox SHALL NOT dereference in the other

### Requirement: Safe globals — console

The sandbox SHALL expose a `console` global with methods `log`, `info`, `warn`, `error`, `debug`. Calls SHALL push a `LogEntry` with `method: "console.<level>"`, `args: [...args]`, `status: "ok"` into the run's log buffer.

#### Scenario: console.log captures

- **GIVEN** guest code `console.log("hello", 42)`
- **WHEN** the run completes
- **THEN** `RunResult.logs` SHALL contain an entry with `method: "console.log"` and `args: ["hello", 42]`

### Requirement: Safe globals — timers

The sandbox SHALL expose `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` that schedule callbacks on the host event loop. Timer callbacks SHALL be invoked inside the QuickJS context with `executePendingJobs` pumped after each callback.

#### Scenario: setTimeout callback fires

- **GIVEN** guest code `setTimeout(() => resolve(42), 0)`
- **WHEN** the run completes
- **THEN** the callback SHALL have executed inside QuickJS
- **AND** the resulting promise SHALL resolve with `42`

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` returning a monotonically non-decreasing number representing milliseconds since some origin fixed at sandbox construction time.

#### Scenario: performance.now returns valid value

- **GIVEN** a sandbox
- **WHEN** guest code calls `performance.now()` twice
- **THEN** the second value SHALL be >= the first value

### Requirement: WebCrypto surface

The sandbox SHALL expose the W3C WebCrypto API: `crypto.randomUUID`, `crypto.getRandomValues`, and the full `crypto.subtle` surface (`digest`, `importKey`, `exportKey`, `sign`, `verify`, `encrypt`, `decrypt`, `generateKey`, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey`).

WebCrypto SHALL be implemented by bridging to the host's `globalThis.crypto`; the sandbox SHALL NOT implement cryptographic primitives directly.

#### Scenario: crypto globals available

- **GIVEN** a sandbox
- **WHEN** guest code invokes `crypto.randomUUID()`, `crypto.getRandomValues(new Uint8Array(16))`, and `await crypto.subtle.digest("SHA-256", data)`
- **THEN** each call SHALL return a result consistent with the W3C WebCrypto specification

### Requirement: Key material never crosses the boundary

`CryptoKey` references inside the sandbox SHALL be opaque handles carrying only metadata (`type`, `algorithm`, `extractable`, `usages`). The underlying key material SHALL remain on the host and SHALL NOT be serialized into or out of the sandbox.

The `crypto.subtle.exportKey` operation SHALL return raw bytes or a JWK object only when the key's `extractable` attribute is `true`; otherwise it SHALL reject with an error.

#### Scenario: CryptoKey metadata is readable

- **GIVEN** a CryptoKey generated inside the sandbox
- **WHEN** guest code reads `key.type`, `key.algorithm`, `key.extractable`, `key.usages`
- **THEN** the values SHALL match the generation parameters

#### Scenario: Non-extractable key cannot be exported

- **GIVEN** a CryptoKey with `extractable: false`
- **WHEN** guest code calls `crypto.subtle.exportKey(...)` on it
- **THEN** the operation SHALL reject

### Requirement: __hostFetch bridge

The sandbox SHALL install `globalThis.__hostFetch(method, url, headers, body)` as an async host-bridged function that performs an HTTP request using the host's `globalThis.fetch`. The response SHALL be a JSON object `{ status, statusText, headers, body }` where `body` is the response text.

`__hostFetch` is the target of the workflow bundle's `whatwg-fetch` + `MockXhr` polyfill chain (installed by vite-plugin into workflow source). The sandbox SHALL install `__hostFetch` before evaluating `source` so that module-level polyfill code can reference it.

#### Scenario: __hostFetch performs GET request

- **GIVEN** guest code calls `globalThis.__hostFetch("GET", "https://example.com/data", {}, null)`
- **WHEN** the host's `fetch` resolves with a 200 response
- **THEN** the call SHALL resolve to `{ status: 200, statusText: ..., headers: {...}, body: "..." }`

#### Scenario: __hostFetch error logged

- **GIVEN** guest code calls `globalThis.__hostFetch("GET", "https://bad.url", {}, null)`
- **AND** the host's `fetch` rejects
- **WHEN** the run completes
- **THEN** a `LogEntry` with `status: "failed"` SHALL be present for this call

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §2 Sandbox Boundary`. This capability is the single strongest isolation boundary in the system; any change to the public API, installed globals, host bridges, or VM lifecycle is a change to that boundary.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, change the VM lifecycle posture, alter what crosses the boundary, add a new global, or conflict with the rules in `/SECURITY.md §2` MUST update `/SECURITY.md §2` in the same change proposal.

All lifecycle and security guarantees about the sandbox — VM construction, disposal, isolation, allowlisted globals, key-material containment — SHALL be codified in this capability spec rather than in consumer specs. Consumer specs (scheduler, context, workflow-loading, sdk) SHALL describe only how they use the sandbox's public API, not the sandbox's internal guarantees.

#### Scenario: Change alters sandbox boundary

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects entry points, installed globals, mitigations, residual risks, or rules enumerated in `/SECURITY.md §2`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §2`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §2`
- **THEN** no update to `/SECURITY.md §2` is required
- **AND** the proposal SHALL note that threat-model alignment was checked

### Requirement: Residual risk — opaque store growth

The internal opaque-reference store SHALL grow as new opaque references are created (typically by crypto operations) and SHALL be cleared only when the sandbox is disposed. A workflow that generates a large number of `CryptoKey` instances without reloading will see its sandbox's opaque store grow monotonically until the sandbox is disposed. No automatic garbage collection is performed.

This is a known v1 limitation, tracked as residual risk R-S7 in `/SECURITY.md §2`. Production deployments SHALL monitor sandbox memory usage where crypto-heavy workflows are in use.

#### Scenario: Residual risk is documented

- **GIVEN** the sandbox spec
- **WHEN** reviewing residual risks
- **THEN** R-S7 "opaque store grows unboundedly per sandbox lifetime" SHALL be listed
