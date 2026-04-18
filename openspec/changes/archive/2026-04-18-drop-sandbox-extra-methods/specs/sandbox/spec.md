## MODIFIED Requirements

### Requirement: Public API — Sandbox.run()

The `Sandbox` interface SHALL provide a `run(name, ctx, options)` method that invokes a named export from the source module with `ctx` as the single argument.

```ts
interface RunOptions {
  readonly invocationId: string
  readonly workflow: string
  readonly workflowSha: string
}

interface Sandbox {
  run(name: string, ctx: unknown, options: RunOptions): Promise<RunResult>
  dispose(): void
  onDied(cb: (err: Error) => void): void
}
```

The method SHALL:

1. Clear the run-local log buffer (performed inside the worker as part of handling the `run` message).
2. Attach the `RunOptions` fields (`invocationId`, `workflow`, `workflowSha`) to the run-local bridge context so they can stamp every `InvocationEvent` emitted during the run.
3. Post a `run` message to the worker containing `exportName: name` and `ctx` (structured-cloned).
4. Service incoming `request` messages by dispatching to the construction-time `methods` registered at `sandbox(source, methods, options)` construction and replying with `response` messages. No per-run method installation or uninstallation SHALL occur.
5. On `done`, resolve with the `RunResult` payload carried in the message.

All host methods the guest can call SHALL have been installed once at init time from the `methods` parameter of `sandbox(...)`; the set of callable host methods SHALL NOT vary across `run()` invocations of the same sandbox.

Concurrent `run()` invocations on the same `Sandbox` are documented undefined behavior; the implementation is not required to detect or serialize them.

#### Scenario: Named export called with ctx

- **GIVEN** a source with `export async function onFoo(ctx) { return ctx.n * 2; }`
- **AND** a sandbox constructed from that source
- **WHEN** `sb.run("onFoo", { n: 21 }, { invocationId: "i1", workflow: "w", workflowSha: "s" })` is called
- **THEN** the returned `RunResult` SHALL be `{ ok: true, result: 42 }`

#### Scenario: Missing export yields error result

- **GIVEN** a sandbox whose source has no `nonexistent` export
- **WHEN** `sb.run("nonexistent", {}, opts)` is called
- **THEN** the returned `RunResult` SHALL have `ok: false` with an error describing the missing export
- **AND** the worker SHALL remain alive and usable for subsequent runs

#### Scenario: Construction-time methods persist across runs

- **GIVEN** a sandbox constructed with `methods = { tally: async (n) => n + 1 }`
- **WHEN** guest code inside two successive `sb.run(...)` invocations both call `tally(41)`
- **THEN** each call SHALL resolve to `42` via the construction-time `tally` implementation

#### Scenario: Concurrent host-method requests correlate via requestId

- **GIVEN** a sandbox constructed with `methods = { echo: async (x) => x }`
- **AND** guest code that invokes `await Promise.all([echo("a"), echo("b")])`
- **WHEN** the worker posts two `request` messages with distinct `requestId` values
- **THEN** the main side SHALL reply to each with a matching `response` carrying the same `requestId`
- **AND** the worker SHALL resolve each pending guest promise against the correct `requestId`

### Requirement: RunResult discriminated union

The `run()` method SHALL return `Promise<RunResult>` where:

```ts
type RunResult =
  | { ok: true;  result: unknown;                       logs: LogEntry[] }
  | { ok: false; error: { message: string; stack: string }; logs: LogEntry[] }
```

The method SHALL NOT throw for errors raised inside the sandbox; errors SHALL be returned as values. The method MAY throw for host-side programming errors (e.g., sandbox already disposed).

The `logs` array SHALL contain all bridge and console log entries pushed during this run, in chronological order. The `result` field on success SHALL be the JSON-serialized return value of the invoked export (`undefined` serializes to absent).

#### Scenario: Successful invocation

- **GIVEN** a sandbox whose export resolves to `{ status: "ok" }`
- **WHEN** `sb.run("action", ctx, opts)` resolves
- **THEN** the result SHALL be `{ ok: true, result: { status: "ok" }, logs: [...] }`

#### Scenario: Thrown error

- **GIVEN** a sandbox whose export throws `new Error("boom")`
- **WHEN** `sb.run("action", ctx, opts)` resolves
- **THEN** the result SHALL be `{ ok: false, error: { message: "boom", stack: "..." }, logs: [...] }`

#### Scenario: Rejected promise

- **GIVEN** a sandbox whose export returns a promise that rejects with `new Error("fail")`
- **WHEN** `sb.run("action", ctx, opts)` resolves
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

Every host-bridged method call (construction-time method, `__hostFetch`, crypto operation) SHALL push an entry before returning. Console calls (`console.log`, `.info`, `.warn`, `.error`, `.debug`) SHALL push entries with `method: "console.<level>"`. The log buffer SHALL be cleared at the start of each `run()` call and SHALL NOT persist across runs.

#### Scenario: Log buffer is per-run

- **GIVEN** a sandbox where `sb.run("a", ...)` produced 3 log entries
- **WHEN** `sb.run("b", ...)` is called
- **THEN** the `b` run's `RunResult.logs` SHALL NOT contain any entries from the `a` run

### Requirement: JSON-only host/sandbox boundary

All arguments and return values crossing the host/sandbox boundary via consumer-provided `methods` SHALL be JSON-serializable. The sandbox SHALL serialize host values to JSON when passing into the VM and SHALL deserialize VM values into host-native JSON values when returning.

The sandbox SHALL NOT expose host object references, closures, proxies, or any host-identity-carrying value to consumer methods.

#### Scenario: Consumer methods receive JSON args

- **GIVEN** a consumer method `f: async (x) => ...`
- **AND** guest code calls `f({ a: 1, b: [2, 3] })`
- **THEN** `f` SHALL receive `{ a: 1, b: [2, 3] }` as a plain JSON value (not a QuickJSHandle)

#### Scenario: Consumer methods return JSON results

- **GIVEN** a consumer method that returns `{ status: 200 }`
- **WHEN** guest code calls it
- **THEN** guest code SHALL observe the return value as a plain object with a numeric `status` field

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals to guest code after initialization completes: the host methods registered via `methods` (each installed on `globalThis` at init time, subject to the capture-and-delete rules in the `__hostFetch bridge`, `__reportError host bridge`, `__emitEvent init-time bridge`, and `__hostCallAction bridge global` requirements), the built-in host-bridged globals that remain guest-visible (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`), the guest-side shims (`fetch`, `reportError`, `self`, `navigator`), the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`), and the locked runtime-appended dispatcher global (`__dispatchAction`). The names `__hostFetch`, `__emitEvent`, `__hostCallAction`, and `__reportError` SHALL NOT be present on `globalThis` by the time workflow source evaluation begins, or at any later point in the sandbox's lifetime.

Any addition to this allowlist SHALL be made in the same change proposal that amends `/SECURITY.md §2`, with a written rationale and threat assessment per surface added.

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

#### Scenario: WASM extension globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `structuredClone`
- **THEN** each SHALL be a defined global provided by the WASM extensions

#### Scenario: MCA shim globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `self`, `navigator.userAgent`, `reportError`
- **THEN** each SHALL be a defined global provided by the sandbox init sequence

#### Scenario: Underscore-prefixed bridge names absent post-init

- **GIVEN** a sandbox whose initialization has completed (workflow source evaluated, runtime-appended dispatcher shim evaluated)
- **WHEN** guest code evaluates `typeof globalThis.__hostFetch`, `typeof globalThis.__emitEvent`, `typeof globalThis.__hostCallAction`, and `typeof globalThis.__reportError`
- **THEN** each expression SHALL evaluate to `"undefined"`
- **AND** guest attempts to reinstall any of these names via plain assignment (e.g., `globalThis.__hostFetch = myFn`) SHALL NOT affect the behavior of the corresponding shim (the shim's captured reference from init time is invariant)

### Requirement: __reportError host bridge

The sandbox SHALL accept a `__reportError(payload)` host method via the construction-time `methods` parameter. When provided, the sandbox SHALL install it as a host-bridged global at initialization time so that the `REPORT_ERROR_SHIM` IIFE can capture its reference. The method SHALL be write-only: the host implementation SHALL return nothing (or `undefined`) and no host state SHALL flow back to the guest through this bridge. The risk class is equivalent to the existing `console.log` channel.

The `REPORT_ERROR_SHIM` IIFE SHALL capture `globalThis.__reportError` into its closure at evaluation time, install the guest-facing `reportError` global, and then `delete globalThis.__reportError` so that the bridge is not reachable from guest code for the remainder of the sandbox's lifetime.

#### Scenario: Construction-time __reportError receives calls from reportError shim

- **GIVEN** `sandbox(src, { __reportError: (p) => captured.push(p) })`
- **WHEN** the guest `reportError` shim calls the captured `__reportError` reference with a serialized payload
- **THEN** the construction-time implementation SHALL be invoked with the payload

#### Scenario: __reportError is not guest-visible post-init

- **GIVEN** a sandbox constructed with a `__reportError` entry in `methods`
- **WHEN** guest code evaluates `typeof globalThis.__reportError` after init
- **THEN** the result SHALL be `"undefined"`
- **AND** guest assignment `globalThis.__reportError = myFn` SHALL NOT affect the behavior of subsequent `reportError(...)` calls

#### Scenario: No host state returns to guest

- **GIVEN** a sandbox
- **WHEN** the captured `__reportError` reference is called with a payload
- **THEN** the return value observed by the `reportError` shim SHALL be `undefined`

### Requirement: Worker-thread isolation

The sandbox SHALL execute guest code inside a dedicated Node `worker_threads` Worker. The QuickJS runtime and context SHALL live in that worker. The main thread retains only the thin Sandbox proxy that routes `run()`, `dispose()`, and `onDied()` to the worker and services per-run RPC requests (`request` / `response`) from it.

Each `sandbox()` call SHALL spawn exactly one worker. Workers SHALL NOT be shared across sandbox instances. The worker entrypoint SHALL be a package-shipped file at `dist/worker.js` resolved by the main side via `new URL('./worker.js', import.meta.url)`.

The worker↔main message protocol SHALL define exactly these types:

- `init` (main → worker): carries `source`, construction-time `methodNames`, and `filename`.
- `ready` (worker → main): carries no payload; SHALL NOT be sent if initialization fails.
- `run` (main → worker): carries `exportName` and `ctx`. All host methods available to the guest during a run are the ones registered at init from `methodNames`; no per-run method list is carried.
- `request` (worker → main): carries `requestId`, `method`, `args` for a host method invocation.
- `response` (main → worker): carries `requestId`, `ok`, and either `result` or `error`.
- `done` (worker → main): carries the `RunResult` payload for a completed run.

`requestId` SHALL be unique per (worker, direction) to correlate concurrent in-flight host-method RPCs. All message payloads SHALL be structured-cloneable; non-cloneable values (functions, class instances, Promises) are disallowed by construction.

#### Scenario: Dedicated worker per sandbox

- **GIVEN** two sandbox instances constructed from the same source
- **WHEN** both are constructed
- **THEN** two distinct `worker_threads` Workers SHALL be spawned
- **AND** no state SHALL be shared between them at the worker level

#### Scenario: init/ready handshake

- **GIVEN** `sandbox(source, methods)` is called
- **WHEN** the worker spawns
- **THEN** the main side SHALL send exactly one `init` message with `source`, `Object.keys(methods)`, and optional `filename`
- **AND** the worker SHALL load QuickJS, install built-in and construction-time globals, evaluate `source`, and reply with a `ready` message
- **AND** `sandbox(...)` SHALL NOT resolve before `ready` arrives

#### Scenario: Non-cloneable RPC arg is rejected

- **GIVEN** a host method registered via `methods` whose caller passes a function as an argument (e.g., guest code calls `someMethod(() => {})`)
- **WHEN** the worker attempts to post a `request` message
- **THEN** the call SHALL fail inside the worker before `request` is posted
- **AND** the guest SHALL see a rejected promise carrying the serialization error
