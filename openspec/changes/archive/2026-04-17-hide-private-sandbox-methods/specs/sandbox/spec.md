## MODIFIED Requirements

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals to guest code after initialization completes: the host methods registered via `methods` / `extraMethods` (each installed on `globalThis` for the duration of its scope, subject to the capture-and-delete rules in the `__hostFetch bridge`, `__reportError host bridge`, `__emitEvent init-time bridge`, and `__hostCallAction bridge global` requirements), the built-in host-bridged globals that remain guest-visible (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`), the guest-side shims (`fetch`, `reportError`, `self`, `navigator`), the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`), and the locked runtime-appended dispatcher global (`__dispatchAction`). The names `__hostFetch`, `__emitEvent`, `__hostCallAction`, and `__reportError` SHALL NOT be present on `globalThis` by the time workflow source evaluation begins, or at any later point in the sandbox's lifetime, unless a per-run `extraMethod` deliberately reinstalls one of these names for the duration of that run (honored as the host's explicit choice, independent of the sandbox's default hiding).

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

### Requirement: Safe globals — reportError

The sandbox SHALL expose `globalThis.reportError(error)` as a guest-side shim that serializes the provided error into a JSON payload `{ name, message, stack?, cause? }` and invokes the `__reportError` host-bridge method (if one was provided via construction-time `methods`). The shim SHALL capture its reference to `__reportError` at initialization time into the shim's IIFE closure. After the shim installs `reportError` on `globalThis`, it SHALL delete `globalThis.__reportError` so guest code cannot read or overwrite the underlying bridge. The shim SHALL tolerate the absence of a construction-time `__reportError` (its captured reference is `undefined`); when guest code calls `reportError(...)` in this case, the serialization and captured-call path SHALL be wrapped in a `try/catch` and the outer `reportError` SHALL complete silently without propagating an error into guest code.

The shim SHALL NOT dispatch a local `ErrorEvent` (EventTarget is not yet shipped). The `cause` field SHALL be recursively serialized using the same schema when present.

This is a partial implementation of the WinterCG Minimum Common API `reportError` requirement; when EventTarget is shipped in a future round, the shim SHALL evolve to also `dispatchEvent(new ErrorEvent(...))` without breaking the bridge contract.

#### Scenario: reportError forwards serialized error to host

- **GIVEN** a sandbox constructed with `methods: { __reportError: (p) => captured.push(p) }` whose host-side implementation captures calls
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the host implementation SHALL receive a payload with `name: "Error"`, `message: "oops"`, and a `stack` string

#### Scenario: reportError accepts non-Error values

- **GIVEN** a sandbox constructed with a `__reportError` capture
- **WHEN** guest code calls `reportError("a string")`
- **THEN** the host implementation SHALL receive `{ name: "Error", message: "a string" }` (no stack)

#### Scenario: reportError is a no-op when no host bridge was provided

- **GIVEN** a sandbox constructed without a `__reportError` entry in `methods`
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the call SHALL complete without throwing
- **AND** no host-side capture SHALL occur

### Requirement: __hostFetch bridge

The sandbox SHALL install `globalThis.__hostFetch(method, url, headers, body)` at initialization time as an async host-bridged function that performs an HTTP request using the worker's `globalThis.fetch` (or the implementation passed via `options.fetch` at construction). The response SHALL be a JSON object `{ status, statusText, headers, body }` where `body` is the response text.

`__hostFetch` is the target of the sandbox's in-worker `fetch` shim, which builds a WHATWG-compatible `fetch` on top of the bridge. The worker SHALL install `__hostFetch` **before** evaluating the `fetch` shim IIFE. The `fetch` shim IIFE SHALL capture a reference to `globalThis.__hostFetch` into its closure at evaluation time, install the guest-facing `fetch` global via `Object.defineProperty` with `writable: false, configurable: false`, and then `delete globalThis.__hostFetch` so that by the time workflow source evaluation begins, the bridge name is not present on `globalThis`. The captured reference inside the `fetch` shim closure SHALL be used for all subsequent `fetch()` calls.

In-flight `__hostFetch` requests initiated by the guest during a `run()` SHALL be threaded with an `AbortSignal` scoped to that run. When the exported function resolves or throws, the worker SHALL abort the signal before posting `done`. Outstanding requests SHALL reject inside the guest with an `AbortError`; the guest's `done` report SHALL still be delivered.

#### Scenario: __hostFetch is not guest-visible post-init

- **GIVEN** a sandbox whose initialization has completed
- **WHEN** guest code evaluates `typeof globalThis.__hostFetch`
- **THEN** the result SHALL be `"undefined"`
- **AND** guest assignment `globalThis.__hostFetch = myFn` SHALL NOT affect the behavior of subsequent `fetch(...)` calls

#### Scenario: fetch routes through captured bridge

- **GIVEN** guest code that calls `fetch("https://example.com/data")`
- **WHEN** the `fetch` shim resolves the call via its captured `__hostFetch` reference
- **THEN** the underlying HTTP request SHALL be performed by the worker's fetch implementation
- **AND** the response SHALL be returned to guest code as a WHATWG `Response`-shaped object

#### Scenario: In-flight fetch is aborted on run end

- **GIVEN** guest code that calls `fetch("https://slow.example")` without awaiting it
- **WHEN** the exported function returns before the response arrives
- **THEN** the worker SHALL abort the per-run `AbortSignal` before posting `done`
- **AND** the underlying network request SHALL be cancelled

### Requirement: __reportError host bridge

The sandbox SHALL accept a `__reportError(payload)` host method via the construction-time `methods` parameter. When provided, the sandbox SHALL install it as a host-bridged global at initialization time so that the `REPORT_ERROR_SHIM` IIFE can capture its reference. The method SHALL be write-only: the host implementation SHALL return nothing (or `undefined`) and no host state SHALL flow back to the guest through this bridge. The risk class is equivalent to the existing `console.log` channel.

The `REPORT_ERROR_SHIM` IIFE SHALL capture `globalThis.__reportError` into its closure at evaluation time, install the guest-facing `reportError` global, and then `delete globalThis.__reportError` so that the bridge is not reachable from guest code for the remainder of the sandbox's lifetime.

Per-run `extraMethods.__reportError` SHALL NOT override the construction-time binding. The `REPORT_ERROR_SHIM` captures its reference once at initialization; subsequent per-run installations of the `__reportError` name are honored as separate host-provided methods (see the `Isolation — no Node.js surface` requirement), but do not flow through the `reportError()` shim path.

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

### Requirement: __hostCallAction bridge global

The sandbox SHALL install a host-bridge global `__hostCallAction(actionName, input)` at initialization time, before evaluating the runtime-appended dispatcher shim. The global SHALL accept the action's name (string) and its input (JSON-serializable value). The host SHALL: validate `input` against the action's declared input JSON Schema (from the manifest); on success, emit an audit-log entry and return `undefined`. The host SHALL NOT dispatch the action's handler --- the runtime-appended dispatcher in the guest context is the sole handler dispatcher, via a direct JS function call in the same QuickJS context. On input-validation failure, the host SHALL throw a serializable error back into the calling guest context.

The runtime-appended dispatcher shim (see the `Action call host wiring` requirement) SHALL capture `globalThis.__hostCallAction` into its IIFE closure and `delete globalThis.__hostCallAction` after installing the locked `__dispatchAction` global. From guest code's perspective, `__hostCallAction` SHALL NOT be readable or writable at any point after the dispatcher shim returns.

The name SHALL be installed alongside the other host-bridged names (`console`, timers, `performance`, `crypto`, `__emitEvent`) at sandbox construction time. It SHALL count as one additional surface in the host-bridge JSON-marshaled boundary documented in `/SECURITY.md §2`.

#### Scenario: Action dispatched in same sandbox via dispatcher

- **GIVEN** a workflow with two actions `a` and `b` loaded into one sandbox
- **AND** `a`'s handler calls `await b(input)` (the SDK callable)
- **WHEN** `a` is running
- **THEN** the SDK callable SHALL reach `globalThis.__dispatchAction(name, input, handler, outputSchema)` via the core `dispatchAction` helper
- **AND** the dispatcher SHALL call its captured `__hostCallAction("b", input)` reference, through which the host validates input and audit-logs
- **AND** the dispatcher SHALL invoke `b`'s handler via a direct JS function call in the same QuickJS context
- **AND** the dispatcher SHALL validate the handler's return value against `b`'s output Zod schema using the bundled Zod
- **AND** the validated result SHALL be returned to `a`'s caller

#### Scenario: __hostCallAction is not guest-visible post-init

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code evaluates `typeof globalThis.__hostCallAction`
- **THEN** the result SHALL be `"undefined"`
- **AND** guest assignment `globalThis.__hostCallAction = myFn` SHALL NOT affect the behavior of subsequent action calls

#### Scenario: Input validation failure throws into caller; handler does not run

- **GIVEN** action `b` with `input: z.object({ x: z.number() })`
- **WHEN** the dispatcher invokes its captured `__hostCallAction("b", { x: "not a number" })` reference
- **THEN** the host SHALL throw a validation error across the bridge
- **AND** `b`'s handler SHALL NOT execute
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Output validation failure throws into caller

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** the SDK callable invokes `b(validInput)`
- **THEN** the dispatcher's captured `__hostCallAction` call SHALL succeed (input is valid)
- **AND** the handler SHALL execute and return `42`
- **AND** the dispatcher SHALL call the output schema's `.parse(42)` which throws
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Action handler exception propagates as rejection

- **GIVEN** action `b` whose handler throws `new Error("boom")`
- **WHEN** the SDK callable invokes `b(validInput)`
- **THEN** the dispatcher's captured `__hostCallAction` call SHALL succeed
- **AND** the handler SHALL throw inside the sandbox
- **AND** the dispatcher SHALL emit an `action.error` event via its captured `__emitEvent` reference
- **AND** the dispatcher SHALL let the rejection propagate to the caller

#### Scenario: Bridge is JSON-marshaled

- **GIVEN** an action input crossing the bridge
- **WHEN** input crosses the host/sandbox boundary
- **THEN** values SHALL be JSON-serializable (objects, arrays, primitives, `null`)
- **AND** non-serializable values (functions, symbols, classes) SHALL produce a serialization error

### Requirement: Action call host wiring

The runtime SHALL register `__hostCallAction` per-workflow at sandbox construction time by passing it in `methods` to `sandbox(source, methods, options)`. The host implementation SHALL look up the called action by name in the workflow's manifest, validate the input against the JSON Schema from the manifest, audit-log the invocation, and return. The host SHALL NOT invoke the handler --- dispatch is performed by the runtime-appended dispatcher shim inside the sandbox.

The runtime SHALL append JS source to the workflow bundle (evaluated after the bundle IIFE) that runs as an IIFE and performs the following operations in order:

1. Capture `globalThis.__hostCallAction` into a closure-local variable.
2. Capture `globalThis.__emitEvent` into a closure-local variable.
3. Install `globalThis.__dispatchAction` via `Object.defineProperty` with `value: dispatch`, `writable: false`, `configurable: false`, where `dispatch(name, input, handler, outputSchema)` uses only the closure-captured references to emit `action.*` events, validate input via the captured host bridge, invoke the handler in-sandbox, and validate the handler's return via the output schema.
4. `delete globalThis.__hostCallAction` and `delete globalThis.__emitEvent`.

After this IIFE completes, guest code SHALL NOT be able to read, reassign, or delete `globalThis.__dispatchAction` — the only legal use is to call it.

#### Scenario: Unknown action name throws

- **GIVEN** a workflow whose manifest does not contain an action named `"missing"`
- **WHEN** the dispatcher's captured `__hostCallAction("missing", input)` reference is invoked
- **THEN** the host SHALL throw an error indicating the action is not declared in the manifest

#### Scenario: Dispatcher cannot be replaced by guest

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `globalThis.__dispatchAction = myFn`
- **THEN** the assignment SHALL be rejected (TypeError in strict mode, silent no-op in sloppy mode)
- **AND** subsequent action calls SHALL continue to route through the original dispatcher

#### Scenario: Dispatcher cannot be deleted by guest

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `delete globalThis.__dispatchAction`
- **THEN** the delete SHALL be rejected (TypeError in strict mode, `false` in sloppy mode)
- **AND** subsequent action calls SHALL continue to route through the original dispatcher

## ADDED Requirements

### Requirement: __emitEvent init-time bridge

The sandbox SHALL install `globalThis.__emitEvent(event)` at initialization time as a write-only telemetry channel. The method SHALL accept a JSON object payload with a `kind` field constrained to the set `{ "action.request", "action.response", "action.error" }`; any other `kind` value SHALL throw a `TypeError` into the guest. The worker SHALL stamp the supplied event with `id`, `seq`, `ref`, `ts`, `workflow`, and `workflowSha` derived from the current run context before posting it to the main thread as a `{ type: "event" }` message. `__emitEvent` itself SHALL NOT appear in the system-request event stream (it is installed directly on `globalThis` via `vm.newFunction`, not through the bridge's `sync`/`async` wrappers).

The runtime-appended dispatcher shim (see the `Action call host wiring` requirement) SHALL capture `globalThis.__emitEvent` into its IIFE closure and `delete globalThis.__emitEvent` after installing the locked `__dispatchAction` global. From guest code's perspective, `__emitEvent` SHALL NOT be readable or writable at any point after the dispatcher shim returns.

The guest cannot read host state through this channel, cannot influence other events' metadata, and cannot post `trigger.*` or `system.*` events (those are emitted by the worker and bridge respectively, never by guest code).

#### Scenario: Dispatcher emits action events via captured reference

- **GIVEN** a workflow that calls an action `notify` via the SDK callable
- **WHEN** the dispatcher executes the action lifecycle
- **THEN** an `action.request` event SHALL be posted to the main thread with `name: "notify"` and the validated input
- **AND** on successful return an `action.response` event SHALL be posted with the validated output
- **AND** on thrown rejection an `action.error` event SHALL be posted with the error serialization

#### Scenario: __emitEvent is not guest-visible post-init

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code evaluates `typeof globalThis.__emitEvent`
- **THEN** the result SHALL be `"undefined"`
- **AND** guest assignment `globalThis.__emitEvent = myFn` SHALL NOT affect the events emitted by subsequent dispatcher invocations

#### Scenario: Disallowed event kinds rejected

- **GIVEN** a sandbox during initialization (before the capture-and-delete happens)
- **WHEN** code inside the sandbox would call `__emitEvent({ kind: "system.request", name: "x" })`
- **THEN** the call SHALL throw a `TypeError` identifying the invalid kind

### Requirement: __dispatchAction locked guest global

The sandbox SHALL permit the runtime-appended dispatcher shim to install `globalThis.__dispatchAction(name, input, handler, outputSchema)` as a guest-callable global via `Object.defineProperty` with `writable: false` and `configurable: false`. The locked property SHALL survive for the life of the VM, across all `run()` calls. Guest code MAY call the dispatcher; guest code SHALL NOT be able to overwrite, reassign, or delete it.

The dispatcher is installed exposed (rather than hidden by a shim-closure indirection) because the SDK's `core.dispatchAction()` helper reads `globalThis.__dispatchAction` on every action call, and the helper's lookup path is not being altered by this requirement. The exposure residual — guest code calling the live dispatcher with `(validActionName, realInput, fakeHandler, fakeSchema)` to emit `action.*` audit events that misrepresent which handler actually ran — is accepted and documented in `/SECURITY.md §2`.

#### Scenario: Guest can call __dispatchAction

- **GIVEN** a workflow that authentically invokes an action via the SDK callable
- **WHEN** the callable reaches `globalThis.__dispatchAction(name, input, handler, outputSchema)`
- **THEN** the dispatcher SHALL execute the captured action lifecycle (input validation, handler call, output validation, event emission)
- **AND** the action's result SHALL be returned to the caller

#### Scenario: Guest cannot replace __dispatchAction

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `globalThis.__dispatchAction = fakeDispatcher` in strict mode
- **THEN** a `TypeError` SHALL be thrown
- **AND** `globalThis.__dispatchAction` SHALL still reference the original dispatcher

#### Scenario: Guest cannot delete __dispatchAction

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `delete globalThis.__dispatchAction` in strict mode
- **THEN** a `TypeError` SHALL be thrown
- **AND** `globalThis.__dispatchAction` SHALL still reference the original dispatcher
