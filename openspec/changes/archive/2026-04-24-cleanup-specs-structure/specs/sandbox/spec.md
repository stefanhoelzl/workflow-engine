## REMOVED Requirements

### Requirement: Action call host wiring

**Reason**: Completely stale. Describes the pre-plugin-architecture host bridge (`sandbox(source, methods, options)` factory signature, `__hostCallAction` + `__emitEvent` globals, runtime-appended `__dispatchAction` shim, guest-supplied output schema) — all four of those mechanisms were torn out by `sandbox-plugin-architecture` and `sandbox-output-validation`. The current mechanism (SDK-side `__sdk.dispatchAction` installed by the sdk-support plugin; host-side Ajv input + output validation by the host-call-action plugin) is a complete replacement, not a refactor.

**Migration**: See `sdk` for the `__sdk.dispatchAction` locked global and the passthrough `action()` wrapper. See `actions` for the `createHostCallActionPlugin` factory that compiles Ajv validators and exposes `validateAction` + `validateActionOutput` via `deps["host-call-action"]`. See `workflow-registry` "Sandbox loading" for the no-runtime-source-appending invariant that this requirement's fourth paragraph described in its old form.

### Requirement: Safe globals — console

**Reason**: Provided by `sandbox-stdlib`'s console plugin, not by the sandbox core.

**Migration**: See `sandbox-stdlib` — same behaviour (`console.log/error/warn/info/debug`) installed via the `createConsolePlugin` factory's `__consoleHost` private descriptor.

### Requirement: Safe globals — timers

**Reason**: Provided by `sandbox-stdlib`'s timers plugin.

**Migration**: See `sandbox-stdlib` — `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` installed by `createTimersPlugin` as `public: true` descriptors (the only public descriptors across the entire codebase).

### Requirement: Safe globals — self

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`trivial.ts`).

**Migration**: See `sandbox-stdlib` — `self === globalThis` identity; `self instanceof EventTarget === true` via EventTarget prototype installation.

### Requirement: Safe globals — navigator

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`trivial.ts`).

**Migration**: See `sandbox-stdlib` — hardcoded `navigator.userAgent = "WorkflowEngine"` (no version suffix per `unify-sandbox-plugin-transform`).

### Requirement: Safe globals — reportError

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`report-error.ts`).

**Migration**: See `sandbox-stdlib` — `reportError` wraps the `__reportErrorHost` private descriptor which emits an `uncaught-error` leaf event on the main thread.

### Requirement: Safe globals — EventTarget

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`event-target.ts`, uses `event-target-shim`).

**Migration**: See `sandbox-stdlib` — EventTarget class + `globalThis` implements EventTarget; `addEventListener`/`removeEventListener`/`dispatchEvent` as non-enumerable own properties.

### Requirement: Safe globals — Event

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — Event constructor with `(type, init?)`; read-only `type`, `bubbles`, `cancelable`, `defaultPrevented`, `target`, `currentTarget`, `timeStamp`; `preventDefault()`, `stopPropagation()`, `stopImmediatePropagation()`.

### Requirement: Safe globals — ErrorEvent

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — ErrorEvent constructor with `(type, init?)` exposing `message`, `filename`, `lineno`, `colno`, `error` from init.

### Requirement: Safe globals — AbortController

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`event-target.ts`).

**Migration**: See `sandbox-stdlib` — AbortController with `.signal` and `abort(reason?)`.

### Requirement: Safe globals — AbortSignal

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — AbortSignal with `.aborted`, `.reason`, `.throwIfAborted()`, `addEventListener("abort", ...)`; static `abort(reason?)`, `timeout(ms)`, `any(signals)`.

### Requirement: Guest-side microtask exception routing

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`microtask.ts`).

**Migration**: See `sandbox-stdlib` — `queueMicrotask` is wrapped so uncaught exceptions from microtasks route to `reportError` (which dispatches an ErrorEvent on globalThis).

### Requirement: Safe globals — URLPattern

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (self-installing polyfill package).

**Migration**: See `sandbox-stdlib` — URLPattern from `urlpattern-polyfill`; self-installs if `!globalThis.URLPattern`.

### Requirement: Safe globals — fetch

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`fetch.ts`) wrapping the fetch plugin's `__hostFetch` private descriptor.

**Migration**: See `sandbox-stdlib` — WHATWG `fetch(input, init?)` hand-rolled shim that routes host-bridge calls through `__hostFetch`; accepts `RequestInfo | URL`; returns `Promise<Response>`.

### Requirement: Safe globals — Request

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`request.ts`).

**Migration**: See `sandbox-stdlib` — hand-rolled WHATWG Request class with Body mixin (`.text()`, `.json()`, `.arrayBuffer()`, `.blob()`, `.formData()`, `.bytes()`, `bodyUsed`, `body`); state in QuickJS heap, no host bridge.

### Requirement: Safe globals — Response

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`response.ts`).

**Migration**: See `sandbox-stdlib` — hand-rolled WHATWG Response with Body mixin; static `error()`, `redirect()`, `json()`; `status`, `statusText`, `ok`, `type`, `url`, `redirected`, `headers`; `.clone()`.

### Requirement: Safe globals — Blob

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`blob.ts`, from `fetch-blob@4` with TLA-stripped patch).

**Migration**: See `sandbox-stdlib` — Blob from `fetch-blob@4`; depends on streams; `fetch-blob` pnpm patch strips its module-level top-level-await.

### Requirement: Safe globals — File

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — File subclass of Blob from `fetch-blob`.

### Requirement: Safe globals — FormData

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`form-data.ts`).

**Migration**: See `sandbox-stdlib` — FormData from `formdata-polyfill@4`; depends on Blob/File via fetch-blob v3 transitive; v3's CJS Node prelude no-ops once `globalThis.ReadableStream` is present.

### Requirement: Safe globals — ReadableStream / WritableStream / TransformStream

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`streams.ts`).

**Migration**: See `sandbox-stdlib` — `web-streams-polyfill` ponyfill; ReadableStream/WritableStream/TransformStream.

### Requirement: Safe globals — Queuing strategies

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — `ByteLengthQueuingStrategy` and `CountQueuingStrategy` from `web-streams-polyfill`.

### Requirement: Safe globals — TextEncoderStream / TextDecoderStream

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin.

**Migration**: See `sandbox-stdlib` — hand-rolled TransformStream wrappers around the VM-native `TextEncoder`/`TextDecoder`. Note: `TextEncoder` and `TextDecoder` themselves come from the VM (see "VM-level web-platform surface via quickjs-wasi extensions" ADDED requirement below); the Stream variants are the stdlib addition.

### Requirement: Safe globals — CompressionStream / DecompressionStream

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`compression.ts`).

**Migration**: See `sandbox-stdlib` — pure-JS TransformStream wrappers around `fflate`'s streaming gzip/deflate/inflate classes.

### Requirement: Safe globals — Observable

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`observable.ts`).

**Migration**: See `sandbox-stdlib` — `observable-polyfill` providing Observable + Subscriber + `EventTarget.prototype.when`.

### Requirement: Safe globals — scheduler

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`scheduler.ts`).

**Migration**: See `sandbox-stdlib` — `scheduler-polyfill` providing `self.scheduler`, `TaskController`, `TaskSignal`, `TaskPriorityChangeEvent`.

### Requirement: Safe globals — structuredClone

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`structured-clone.ts`).

**Migration**: See `sandbox-stdlib` — `@ungap/structured-clone` override of the quickjs-wasi native `structuredClone` (which drops wrapper objects, sparse-array length, and non-index array properties).

### Requirement: Safe globals — queueMicrotask

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`microtask.ts` wraps the native `queueMicrotask` for exception routing to `reportError`).

**Migration**: See `sandbox-stdlib` — identical shape (`queueMicrotask(callback)`) with error routing added.

### Requirement: Safe globals — indexedDB

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`indexed-db.ts`).

**Migration**: See `sandbox-stdlib` — `fake-indexeddb` in-memory implementation; depends on structuredClone + DOMException (wrapped via idb-domexception-fix).

### Requirement: Safe globals — User Timing (performance.mark / measure)

**Reason**: Provided by `sandbox-stdlib`'s web-platform plugin (`user-timing.ts`).

**Migration**: See `sandbox-stdlib` — `performance.mark`, `performance.measure`, `clearMarks`, `clearMeasures`, `getEntries*` + `PerformanceEntry`/`PerformanceMark`/`PerformanceMeasure` classes. Built on top of the VM-native `performance.now`.

### Requirement: Hardened outbound fetch

**Reason**: Implemented by `sandbox-stdlib`'s fetch plugin (`createFetchPlugin`'s `hardenedFetch` default). The sandbox core exposes no fetch surface of its own.

**Migration**: See `sandbox-stdlib` — full hardenedFetch pipeline (scheme allowlist incl. `data:` short-circuit; DNS pinning + private-IP blocklist; zone-ID rejection; manual redirect handling with 5-hop cap + cross-origin auth strip; observability via `sandbox.fetch.blocked` warn logs; no new InvocationEvent kind). Referenced by SECURITY.md §2 R-3.

## MODIFIED Requirements

### Requirement: Isolation — no Node.js surface

The sandbox SHALL install no Node.js-specific globals. Node core modules (`fs`, `net`, `http`, `process`, etc.) SHALL NOT be reachable from guest code. The sandbox core SHALL install no plugin-style host descriptors on `globalThis` — every guest-visible global comes from one of two sources:

1. **VM-level extensions** loaded by `worker.ts` into the QuickJS runtime via `extensions: [base64Extension, cryptoExtension, encodingExtension, headersExtension, structuredCloneExtension, urlExtension]` (see "VM-level web-platform surface via quickjs-wasi extensions" requirement). These provide `atob`, `btoa`, `TextEncoder`, `TextDecoder`, `Headers`, `URL`, `URLSearchParams`, native `crypto.getRandomValues`, native `crypto.subtle`, and native `DOMException`.
2. **Plugin-installed globals** from `sandbox-stdlib` (web-platform, fetch, timers, console plugins) and from runtime/sdk plugins (sdk-support installs `__sdk`; trigger and host-call-action install no guest functions; wasi-telemetry installs none). Each comes with an explicit `GuestFunctionDescription` or an in-source IIFE that runs at Phase 2.

#### Scenario: Node.js core modules unreachable

- **GIVEN** a sandbox post-init
- **WHEN** guest code evaluates `typeof require`, `typeof process`, `typeof Buffer`, `typeof global`
- **THEN** each SHALL be `"undefined"`

#### Scenario: Sandbox-core install set is documented

- **GIVEN** a production sandbox composition
- **WHEN** auditing every global installed before Phase 2 plugin source evaluation
- **THEN** the set SHALL equal the union of the VM-level extensions listed in the "VM-level web-platform surface via quickjs-wasi extensions" requirement

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` via the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall with `clockId = CLOCK_MONOTONIC`. The worker's `CLOCK_MONOTONIC` override SHALL return `perfNowNs() − anchorNs` where `anchorNs` is the shared monotonic anchor (`wasiState.anchor.ns`). The anchor is seeded at worker init BEFORE `QuickJS.create` (so the cached reference that QuickJS takes for `performance.now()` starts near zero during VM init) and is re-anchored for each run by the plugin-lifecycle's `onBeforeRunStarted` hook on the trigger plugin. Guest `performance.now()` SHALL therefore start near zero at the beginning of each run and increase monotonically within that run.

#### Scenario: performance.now returns monotonically increasing values within a run

- **GIVEN** a sandbox in an active run
- **WHEN** guest code calls `performance.now()` twice in sequence
- **THEN** the second value SHALL be greater than or equal to the first

#### Scenario: performance.now starts near zero at the start of each run

- **GIVEN** a cached sandbox that has completed a prior run
- **WHEN** a new run begins and guest code calls `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`

### Requirement: Safe globals — DOMException

The sandbox SHALL expose `globalThis.DOMException` as the class installed by the quickjs-wasi `structuredCloneExtension` (see "VM-level web-platform surface via quickjs-wasi extensions"). The class SHALL construct with `(message, name)` and provide `name` and `message` properties; instances SHALL satisfy `instanceof Error` and `instanceof DOMException`.

The final guest-visible `DOMException` is a construct-trap `Proxy` wrapper installed by `sandbox-stdlib`'s web-platform plugin (`idb-domexception-fix.ts`) to make fake-indexeddb's subclass `throw new DataError()` land as a plain DOMException instance. See `sandbox-stdlib` for the wrapper.

#### Scenario: DOMException instances pass instanceof checks

- **GIVEN** a sandbox post-init
- **WHEN** guest code evaluates `new DOMException("oops", "DataError") instanceof DOMException` and `... instanceof Error`
- **THEN** both SHALL be `true`

#### Scenario: DOMException is consumed by AbortController / AbortSignal

- **GIVEN** an AbortController from the web-platform plugin
- **WHEN** guest code calls `controller.abort()` without an explicit reason
- **THEN** `controller.signal.reason` SHALL be a DOMException with `name === "AbortError"`

### Requirement: WebCrypto surface

The sandbox SHALL expose the native WebCrypto handles provided by the quickjs-wasi `cryptoExtension`:

- `crypto.getRandomValues(typedArray)` — synchronous CSPRNG fill.
- `crypto.subtle` — PSA-backed subtle crypto handle with digest, key generation, sign/verify, import/export, encrypt/decrypt operations.

The final guest-visible `crypto.subtle` is wrapped by `sandbox-stdlib`'s web-platform plugin (`subtle-crypto.ts`) to add argument validation, sync-to-promise wrapping (the native methods are synchronous; WHATWG SubtleCrypto returns Promises), and DOMException-name normalization. See `sandbox-stdlib` for the wrapper.

Native key material SHALL remain inside WASM linear memory; `CryptoKey` objects SHALL expose read-only `type`, `algorithm`, `extractable`, `usages` but SHALL NOT cross the host/guest boundary. No opaque reference store SHALL be used for crypto keys.

#### Scenario: getRandomValues fills buffer

- **WHEN** guest code calls `crypto.getRandomValues(new Uint8Array(32))`
- **THEN** the typed array SHALL be returned with 32 random bytes

#### Scenario: CryptoKey metadata readable

- **GIVEN** a CryptoKey generated inside the sandbox
- **WHEN** guest code reads `key.type`, `key.algorithm`, `key.extractable`, `key.usages`
- **THEN** the values SHALL match the generation parameters

#### Scenario: Non-extractable key cannot be exported

- **GIVEN** a CryptoKey with `extractable: false`
- **WHEN** guest code calls `crypto.subtle.exportKey(format, key)`
- **THEN** the promise SHALL reject

## ADDED Requirements

### Requirement: VM-level web-platform surface via quickjs-wasi extensions

The sandbox core's `worker.ts` SHALL load the following six `quickjs-wasi` extensions into the QuickJS runtime at Phase 1, via the `extensions` option of `QuickJS.create()`:

| Extension | Guest-visible globals |
|---|---|
| `base64Extension` | `atob`, `btoa` |
| `encodingExtension` | `TextEncoder`, `TextDecoder` |
| `headersExtension` | `Headers` |
| `urlExtension` | `URL`, `URLSearchParams` |
| `cryptoExtension` | `crypto.getRandomValues`, `crypto.subtle` (native handle) |
| `structuredCloneExtension` | `DOMException` (native class; also provides native `structuredClone` which is overridden at Phase 2 by the stdlib web-platform plugin) |

These extensions are the ONLY guest-visible globals installed by the sandbox core before plugin source evaluation (Phase 2). Every other guest-visible global comes from a plugin in `sandbox-stdlib`, the runtime, or the SDK.

The `TextEncoderStream` / `TextDecoderStream` classes, the overriding `structuredClone`, and the wrapped forms of `crypto.subtle` / `DOMException` come from the `sandbox-stdlib` web-platform plugin at Phase 2; they are NOT VM-level.

#### Scenario: VM-level globals exist before Phase 2

- **GIVEN** a sandbox composition with NO plugins (empty `plugins: []`)
- **WHEN** post-init guest code evaluates `typeof URL`, `typeof URLSearchParams`, `typeof Headers`, `typeof TextEncoder`, `typeof TextDecoder`, `typeof atob`, `typeof btoa`, `typeof crypto.getRandomValues`, `typeof crypto.subtle`, `typeof DOMException`
- **THEN** each SHALL be `"function"` (or `"object"` for `crypto.subtle`)

#### Scenario: Adding a new VM-level global requires extending this list

- **WHEN** a future change adds a new `quickjs-wasi` extension to `createOptions.extensions` in `worker.ts`
- **THEN** this requirement's table SHALL be extended in the same change
- **AND** SECURITY.md §2 "Globals surface" SHALL be extended in the same change

### Requirement: SandboxStore provides per-`(tenant, sha)` sandbox access

The runtime SHALL provide a `SandboxStore` component that maps `(tenant, workflow.sha)` pairs to `Sandbox` instances. The store SHALL be the sole runtime-internal accessor for workflow sandboxes. The store SHALL build sandboxes lazily on the first `get` for a given key and SHALL hold them for the lifetime of the store.

```ts
interface SandboxStore {
  get(
    tenant: string,
    workflow: WorkflowManifest,
    bundleSource: string,
  ): Promise<Sandbox>;
  dispose(): void;
}
```

Different tenants with identical `workflow.sha` values SHALL get distinct sandbox instances (per `SECURITY.md §1 I-T2` — tenant isolation). Different shas within a tenant SHALL get distinct sandboxes; the old sandbox SHALL remain until `dispose()` is called.

#### Scenario: First get for a key builds a new sandbox

- **GIVEN** a freshly constructed `SandboxStore`
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called for the first time
- **THEN** the store SHALL construct a new sandbox via the injected `SandboxFactory`
- **AND** retain a reference keyed on `(tenant, workflow.sha)`

#### Scenario: Subsequent get for the same key reuses the sandbox

- **GIVEN** a store with a cached sandbox for `(tenant, workflow.sha)`
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called with matching tenant + sha
- **THEN** the store SHALL resolve to the same sandbox reference
- **AND** it SHALL NOT invoke the factory

#### Scenario: Different tenants with identical shas get distinct sandboxes

- **GIVEN** two tenants `A` and `B` registering workflows with byte-identical bundles
- **WHEN** `store.get("A", workflow, ...)` and `store.get("B", workflow, ...)` are both called
- **THEN** the store SHALL return two distinct sandbox instances
- **AND** module-scope mutations in `A`'s sandbox SHALL NOT be observable from `B`'s sandbox

### Requirement: SandboxStore composes the production plugin catalog

The SandboxStore SHALL compose a standard plugin catalog for every production sandbox, in a fixed order compatible with plugin `dependsOn` declarations:

```ts
plugins: [
  createWasiPlugin(runtimeWasiTelemetry),   // sandbox package (WASI routing)
  createWebPlatformPlugin(),                // sandbox-stdlib (all safe-globals)
  createFetchPlugin(),                      // sandbox-stdlib (hardenedFetch default)
  createTimersPlugin(),                     // sandbox-stdlib
  createConsolePlugin(),                    // sandbox-stdlib
  createHostCallActionPlugin({ manifest }), // runtime (Ajv validators from manifest)
  createSdkSupportPlugin(),                 // sdk (__sdk.dispatchAction)
  createTriggerPlugin(),                    // runtime (trigger.* lifecycle emission)
]
```

`runtimeWasiTelemetry` SHALL be a setup function exported by the runtime that emits `wasi.clock_time_get` / `wasi.random_get` / `wasi.fd_write` leaf events. The store SHALL NOT append any dispatcher source to the workflow bundle; the SDK's `createSdkSupportPlugin` owns dispatcher logic.

Test compositions MAY omit the trigger plugin and wasi-telemetry when a silent sandbox is desired; that concern lives at the test-fixture layer, not in the production store.

#### Scenario: Production composition loads all eight plugins

- **WHEN** a production sandbox is constructed
- **THEN** the plugin list SHALL include the eight plugins named above
- **AND** the plugin composition's topological sort SHALL be valid
- **AND** sandbox construction SHALL complete without error

#### Scenario: No dispatcher source is appended

- **GIVEN** a tenant workflow bundle
- **WHEN** the SandboxStore constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be called with `source` unmodified
- **AND** no runtime-side source SHALL be concatenated, prepended, or appended

### Requirement: SandboxStore lifetime is the process lifetime

The `SandboxStore` SHALL NOT dispose individual sandboxes during normal operation. The store SHALL provide a public `dispose()` method that disposes every cached sandbox; this method SHALL be invoked only on process shutdown. The store SHALL NOT expose any public API for per-key eviction.

Re-upload of a workflow with a new `sha` SHALL NOT dispose the old-sha sandbox. In-flight invocations dispatched to the old-sha sandbox SHALL complete against it; new invocations after re-upload SHALL dispatch to the new-sha sandbox (built on demand if not yet cached).

#### Scenario: Re-upload preserves the old sandbox

- **GIVEN** a store holding a sandbox for `(tenant, oldSha)`
- **WHEN** the same tenant re-registers the workflow with a new sha
- **THEN** the `(tenant, oldSha)` sandbox SHALL remain
- **AND** SHALL NOT be disposed

#### Scenario: In-flight invocation completes on the orphaned sandbox

- **GIVEN** an in-flight invocation dispatched to the `(tenant, oldSha)` sandbox
- **WHEN** the tenant re-uploads with a new sha before the invocation completes
- **THEN** the in-flight invocation SHALL complete against `(tenant, oldSha)`
- **AND** the next invocation post-reupload SHALL dispatch to `(tenant, newSha)`

#### Scenario: Process shutdown disposes every cached sandbox

- **GIVEN** a store holding multiple cached sandboxes
- **WHEN** `store.dispose()` is called
- **THEN** every cached sandbox SHALL have its `dispose()` called
- **AND** all references SHALL be released

### Requirement: SandboxStore factory shape

The `SandboxStore` SHALL be constructed via `createSandboxStore({ sandboxFactory, logger })`. The store SHALL delegate sandbox construction to `sandboxFactory.create(source, options)` and SHALL emit info-level log entries on cache miss (sandbox constructed).

#### Scenario: Factory delegation

- **WHEN** `createSandboxStore({sandboxFactory, logger})` is called
- **THEN** the returned store SHALL retain both dependencies
- **AND** every cache-miss `get` SHALL call `sandboxFactory.create(source, options)` exactly once

### Requirement: SandboxStore onEvent stamps runtime metadata

On every sandbox creation, the SandboxStore SHALL register an `onEvent` callback that stamps `tenant`, `workflow`, `workflowSha`, and `invocationId` onto every incoming event before forwarding it to the bus. The metadata SHALL come from the "current run" state tracked by the store (populated when `sandbox.run()` is invoked, cleared after it returns).

This stamping is the load-bearing point for `SECURITY.md §2 R-8` (tenant/workflow/workflowSha/invocationId never stamped from inside sandbox or plugin code) and `SECURITY.md §1 I-T2` (tenant isolation invariant on invocation-event writes). `meta.dispatch` is separately stamped by the executor's `sb.onEvent` widener, gated on `event.kind === "trigger.request"` per SECURITY.md §2 R-9 (scope of `cleanup-specs-content`).

#### Scenario: Metadata stamping on event forward

- **GIVEN** a sandbox emitting events during an active run
- **WHEN** any event flows from the sandbox to the store's `onEvent` callback
- **THEN** the callback SHALL attach `tenant` / `workflow` / `workflowSha` / `invocationId` from the current run context
- **AND** the stamped event SHALL reach `bus.emit`
- **AND** `tenant` SHALL match the tenant that owns the cached sandbox (invariant I-T2)
