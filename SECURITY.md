# Security Model

This document is the authoritative threat model for this workflow engine. It
is written **primarily for AI coding agents** to consult when adding or
modifying security-sensitive code. Human contributors are welcome readers,
but the prose is optimized for machine consumption: explicit rules, clear
trust boundaries, and enumerated threats per attack surface.

## How to use this document

Before writing or reviewing code that touches security-sensitive areas,
consult the relevant section:

- **Adding or modifying a sandbox global / host bridge API** → §2 Sandbox
  Boundary
- **Adding or changing an HTTP route** → determine trust level first
  (§3–§4)
- **Adding a new webhook handler or trigger type** → §3 Webhook Ingress
- **Changing authentication, authorization, or route protection** → §4
  Authentication
- **Changing container, network, or secret configuration** → §5
  Infrastructure and Deployment
- **Adding or modifying HTTP response headers, CSP, or any HTML rendered
  by the runtime** → §6 HTTP Response Headers

Each section below follows the same structure:

1. **Trust level** — classification of what crosses this boundary.
2. **Entry points** — concrete routes, APIs, or code paths.
3. **Threats** — what can go wrong.
4. **Mitigations** — what is in place today.
5. **Residual risks** — known gaps (labelled `v1 limitation`, `High
   priority`, or `Accepted`).
6. **Rules for AI agents** — hard invariants that must not be violated.
7. **File references** — relevant source and spec files.

Compact invariants also appear in `CLAUDE.md`. `SECURITY.md` is the full
reference.

Section numbering (§1..§6) is stable. Future edits that introduce new
sections must append (§7 and onward), not renumber.

## §1 Trust boundaries overview

```
                         Internet (untrusted)
                                │
                                ▼
                     ┌──────────────────────┐
                     │   Traefik Ingress    │  TLS termination
                     │   (websecure :443)   │
                     └──────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
  /webhooks/*           /dashboard, /trigger        /api/*
  PUBLIC                oauth2-proxy forward-auth   App middleware:
  (intentional)         (GitHub OAuth)              Bearer + GITHUB_USER
        │                       │                       │
        ▼                       ▼                       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                  Runtime (Node.js, Hono)                    │
  │                                                             │
  │   ┌──────────────┐    ┌──────────────┐   ┌──────────────┐   │
  │   │ Webhook      │    │ UI (dashboard│   │ API handlers │   │
  │   │ handlers     │    │  + trigger)  │   │              │   │
  │   └──────┬───────┘    └──────────────┘   └──────────────┘   │
  │          │ parse + validate payload (Ajv)                   │
  │          ▼                                                  │
  │   ┌──────────────┐   EventBus    ┌─────────────────────┐    │
  │   │   Executor   │──lifecycle──►│ Persistence +        │    │
  │   │ (runQueue)   │              │ EventStore + Logging │    │
  │   └──────┬───────┘              └─────────────────────┘     │
  │          │                                                  │
  │          │ invokeHandler(trigger, payload)                  │
  │          ▼                                                  │
  │          ═══════════════════════════════════════            │
  │          Sandbox boundary (QuickJS WASM + worker)           │
  │          ┌───────────────────────────────────────┐          │
  │          │ Trigger handler (UNTRUSTED)           │          │
  │          │   └─► await action(input)             │          │
  │          │       ├─► __hostCallAction(name, in)  │          │
  │          │       │   (host: Ajv validate + audit)│          │
  │          │       └─► action.handler(input)       │          │
  │          │       └─► Zod validate output         │          │
  │          │   └─► fetch(url, …) → __hostFetch     │          │
  │          └───────────────────────────────────────┘          │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                   ┌──────────────────────────┐
                   │  Internal K8s services   │
                   │  (S3 storage, GitHub     │
                   │   API for auth checks)   │
                   └──────────────────────────┘
```

| # | Surface | Trust level | Entry points | Auth mechanism | Section |
|---|---------|-------------|--------------|----------------|---------|
| 1 | Sandbox | **UNTRUSTED** (user-authored trigger + action code) | `sandbox(source, methods).run(handlerName, payload)` | Isolation, not auth | §2 |
| 2 | Webhook ingress | **PUBLIC** (intentionally unauthenticated) | `POST /webhooks/{name}` | None — payload-schema validation only | §3 |
| 3 | UI / API | **AUTHENTICATED** | `/dashboard`, `/trigger`, `/api/*` | oauth2-proxy (GitHub) for UI; Bearer (GitHub) for API | §4 |
| 4 | Infrastructure | **INTERNAL** | K8s pods, Secrets, S3, Traefik | K8s RBAC, pod network | §5 |

**Trust-level semantics** (applies across the whole document):

- **UNTRUSTED** — Code or data that the runtime must assume is hostile.
  Never granted direct access to host APIs, filesystem, process, or
  un-allowlisted network destinations.
- **PUBLIC** — Accepts requests from anyone on the Internet. Must validate
  payloads; must not trust any request metadata.
- **AUTHENTICATED** — Caller identity is established by a named mechanism.
  Authorization is a separate check.
- **INTERNAL** — Cluster-local, reachable only by other pods. Not exposed
  externally. Not a substitute for authentication at the app level.

## §2 Sandbox Boundary

### Trust level

**UNTRUSTED.** All code inside `sandbox(source, methods).run(name, ctx, extraMethods)` is
user-authored action code. Treat it as hostile: it may attempt to read
host state, reach network services it shouldn't, run indefinitely, or
exfiltrate secrets through any channel available to it.

The sandbox is **the single strongest isolation boundary in the system**.
Most security decisions in this document reduce to: *does this expose
new capability across the sandbox boundary?*

**Engine:** the sandbox uses `quickjs-wasi` (QuickJS-ng compiled to
`wasm32-wasip1`), not `quickjs-emscripten`. Each `Sandbox` instance has
its own `QuickJS.create()` VM with its own dedicated WASM linear
memory; there is no runtime/context split. Standard Web APIs (`URL`,
`TextEncoder`/`TextDecoder`, `atob`/`btoa`, `structuredClone`,
`Headers`, WebCrypto) are provided by the engine's native WASM
extensions, not by host-side polyfills bundled into the workflow.
Source is evaluated as an IIFE script (not an ES module) because
`quickjs-wasi`'s `evalCode` does not expose the ES module namespace;
the vite-plugin emits `format: "iife"` with a fixed namespace name
(`IIFE_NAMESPACE` exported from `@workflow-engine/core`), and the
sandbox reads exports from `globalThis[IIFE_NAMESPACE]`.

### Entry points

- `sandbox(source, methods, options)` — spawns a dedicated Node
  `worker_threads` Worker that constructs the QuickJS WASM context,
  installs host-bridged globals and host methods inside the worker,
  and evaluates the workflow module source once. The main thread
  holds only a thin Sandbox proxy that routes `run` / `dispose` /
  `onDied` to the worker and services per-run `request` / `response`
  bridge messages. Guest code never observes the worker boundary —
  the set of exposed globals is unchanged from the pre-worker design.
- `createSandboxFactory({ logger })` — the supported lifecycle owner
  for `Sandbox` instances. Caches sandboxes by source, registers a
  death callback on each, and evicts on unexpected worker termination
  so the next `create(source)` spawns a fresh worker.
- `Sandbox.run(name, ctx, runOptions)` — invokes a named export from
  the workflow module with a JSON-shaped `ctx` argument. `runOptions`
  carries `invocationId`, `workflow`, `workflowSha`, and optional
  `extraMethods`. The worker uses these to stamp every `InvocationEvent`
  emitted during the run (see `__emitEvent` below). Host-provided
  methods in `methods` (construction-time) and `extraMethods` (per-run)
  are installed as top-level globals inside the sandbox via RPC
  proxies: the worker posts a `request` carrying `method` + `args`,
  the main thread dispatches to the provided implementation, and the
  response travels back as a `response` message.
- `Sandbox.onEvent(cb)` — registers a callback the main-thread sandbox
  proxy invokes for each `InvocationEvent` the worker streams. The
  worker posts `{ type: "event", event }` messages as paired
  `system.request` / `system.response` (or `*.error`) events fire from
  the bridge, plus `trigger.*` events around the export call and
  `action.*` events emitted by the in-sandbox dispatcher via
  `__emitEvent`. Events flow main-thread → consumer (typically the
  runtime's event bus) → persistence + DuckDB. The sandbox package
  itself does not know about the bus; it just calls back.
- All arguments and return values crossing the host/sandbox boundary
  via consumer-provided methods are JSON-serializable. Host object
  references, closures, and proxies never cross.
- Globals exposed inside the sandbox (post-init guest-visible surface):
  `console.*`, `performance.now` (QuickJS intrinsic, reads through the
  WASI `clock_time_get` syscall), `crypto.*` (full WebCrypto —
  `crypto.randomUUID`, `crypto.getRandomValues`, and `crypto.subtle.*`
  provided natively by the WASM crypto extension with a JS Promise shim
  so `crypto.subtle.*` returns Promises per spec), `setTimeout` /
  `setInterval` / `clearTimeout` / `clearInterval` (host bridges,
  scheduled on the worker event loop), `fetch` (JS shim inside the
  sandbox that captures `__hostFetch` into an IIFE closure, locked via
  `Object.defineProperty({writable: false, configurable: false})`),
  `self` (identity shim, `self === globalThis`; additionally inherits
  `EventTarget.prototype`, with `addEventListener` / `removeEventListener`
  / `dispatchEvent` installed as non-enumerable bound own-properties
  routed to a private EventTarget instance — `Object.keys(globalThis)`
  is unchanged, but `globalThis instanceof EventTarget === true`),
  `navigator` (frozen object with a single
  `userAgent: "WorkflowEngine/<version>"` string), `reportError` (JS
  shim that captures `__reportError` into an IIFE closure, then
  constructs a cancelable `ErrorEvent`, dispatches it on `globalThis`,
  and — unless a listener calls `event.preventDefault()` — serializes
  the error and forwards to the captured bridge), `queueMicrotask`
  (JS wrap around the native implementation that catches uncaught
  microtask exceptions and routes them through `reportError` above),
  `EventTarget` and `Event` (pure-JS polyfills sourced from
  `event-target-shim@6`, resolved by the `sandboxPolyfills()` Vite
  plugin as the `virtual:sandbox-polyfills` module and inlined as an
  IIFE string into `dist/src/worker.js` by
  `packages/sandbox/vite.config.ts` at sandbox build time), `ErrorEvent`
  (pure-JS class extending `Event`, carries
  `message`/`filename`/`lineno`/`colno`/`error`), `AbortController` and
  `AbortSignal` (hand-written pure-JS classes on top of
  `event-target-shim`'s EventTarget; `AbortSignal` includes the static
  factories `abort(reason?)`, `timeout(ms)` — which uses the
  allowlisted `setTimeout` bridge — and `any(signals)`; default abort
  reasons are native `DOMException`s), `URLPattern` (pure-JS polyfill
  `urlpattern-polyfill@10.0.0` (exact-pinned in
  `packages/sandbox/package.json`), bundled into the same
  `virtual:sandbox-polyfills` IIFE by the `sandboxPolyfills()` Vite
  plugin. The polyfill's own `index.js` self-installs the class on
  initial evaluation with `if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern;`
  — a §2 reader does not need to open `node_modules/` to audit the
  install site. No host bridge; pure compute. Pattern-side user input
  can trigger catastrophic regex backtracking in QuickJS's engine —
  identical attack surface to the already-exposed `RegExp` (guest-
  crafted regex patterns can do the same today). Blast radius is
  bounded to the invoking workflow's own worker thread by per-workflow
  `worker_thread` isolation; the host main thread and other workflows'
  workers remain responsive. No new attacker capability beyond what
  `RegExp` already exposes. Version bumps require a §2 re-audit PR —
  the pin is deliberate, not an oversight), `__dispatchAction` (runtime-
  appended action dispatcher, locked via
  `Object.defineProperty({writable: false, configurable: false})`),
  plus the host methods registered via `methods` and `extraMethods`.
  WASM extensions contribute the additional standard globals `URL`,
  `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`,
  `structuredClone`, `Headers`, and `DOMException` — these are
  implemented in C/WASM inside the WASM linear memory, not as host
  bridges.

  The host-bridged names `__hostFetch`, `__emitEvent`, `__hostCallAction`,
  and `__reportError` are each installed on `globalThis` briefly at
  initialization time for exactly one consumer shim to capture into an
  IIFE closure. Each shim then `delete`s its bridge name from
  `globalThis` before guest source evaluation begins, so guest code
  cannot read or overwrite the underlying host wire. The captured
  reference inside the shim closure is used for all subsequent calls
  (`fetch()`, `reportError()`, action dispatch via `__dispatchAction`)
  and is invariant — a guest attempt to `globalThis.__hostFetch = ...`
  creates a new global with no effect on the shim's captured reference.
  `__reportError` is bound at construction time only (no per-run
  override). The sandbox package itself has no knowledge of manifests,
  Zod, or action dispatch; it exposes `__hostFetch` and `__emitEvent`
  as built-ins (captured by `packages/sandbox/src/polyfills/fetch.ts`
  and the runtime dispatcher shim respectively) and installs whatever
  additional methods the host provides via `methods` / `extraMethods`.
  The runtime passes `__hostCallAction` (and optionally
  `__reportError`) as construction-time methods and appends the
  action-dispatcher shim that captures `__hostCallAction` +
  `__emitEvent`, installs the locked `__dispatchAction`, and deletes
  the two captured names.
- **EventTarget/Event/ErrorEvent/AbortController/AbortSignal
  residual risks**: event dispatch is purely in-guest — no host bridge.
  Listener chains are bounded by the existing QuickJS memory cap;
  dispatch re-entrancy is bounded by the existing stack cap. All
  guest-constructed events have `event.isTrusted === false` by
  construction — there is no pathway to `true`.
  `AbortSignal.timeout` extends reachability only via the already
  allowlisted `setTimeout` bridge; it adds no new host surface. A
  guest listener that calls `event.preventDefault()` on a `reportError`
  ErrorEvent suppresses the `__reportError` host forwarding for that
  report; this grants no new attacker capability (malicious guest code
  could already choose not to call `reportError`). The polyfill IIFE is
  built from `packages/sandbox/src/polyfills/entry.ts` by the
  `sandboxPolyfills()` Vite plugin at sandbox build time; reviewers audit
  the polyfill source files under `packages/sandbox/src/polyfills/`
  (`trivial.ts`, `event-target.ts`, `report-error.ts`, `microtask.ts`,
  `fetch.ts`) and the pinned `event-target-shim@^6` dependency.
- **Test-only surfaces (`__wptReport`)**: The WPT compliance harness at
  `packages/sandbox/test/wpt/` installs `__wptReport` as a **per-run**
  extraMethod (`sandbox.run(…, { extraMethods: { __wptReport } })`) to
  collect testharness.js subtest outcomes. `__wptReport` is never passed
  to production sandbox construction; its presence is scoped to the WPT
  test runner only. Vendored WPT files, the harness adapter (preamble,
  composer, runner), and `scripts/wpt-refresh.ts` are test-time artifacts
  and do not extend the production sandbox surface. See
  `packages/sandbox/test/wpt/README.md`.
- **`__emitEvent(event)`** — write-only telemetry primitive installed
  at init directly on `globalThis` via `vm.newFunction` (NOT through
  `bridge.sync()` / `bridge.async()`, so it does not itself appear in
  the event stream). Accepts a JSON payload constrained to
  `kind ∈ {action.request, action.response, action.error}`; any other
  `kind` is rejected with a `TypeError`. The worker stamps the supplied
  event with `id`, `seq`, `ref`, `ts`, `workflow`, `workflowSha` from
  the current run context and posts it to the main thread as a
  `{ type: "event" }` message. The runtime-appended action-dispatcher
  shim captures the `__emitEvent` reference into its IIFE closure at
  init and then `delete`s `globalThis.__emitEvent`, so guest code
  cannot read or overwrite the channel after init. The dispatcher's
  captured reference is the sole emitter of `action.*` events;
  `trigger.*` and `system.*` events are emitted by the worker and
  bridge respectively, never by guest code.
- **Action dispatch model.** The author writes
  `await sendNotification(input)` against the SDK-returned callable.
  That callable delegates to `dispatchAction()` from
  `@workflow-engine/core`, which reads `globalThis.__dispatchAction`
  and calls it. The runtime appends an IIFE after the workflow bundle
  in `buildSandboxSource`; the IIFE captures `__hostCallAction` and
  `__emitEvent` into closure locals, installs `__dispatchAction` via
  `Object.defineProperty(globalThis, "__dispatchAction", { value: fn,
  writable: false, configurable: false })`, and then `delete`s
  `globalThis.__hostCallAction` and `globalThis.__emitEvent` so
  neither bridge is reachable from guest code after init. The locked
  `__dispatchAction` runs entirely inside the QuickJS context and does
  five things, in order:
  1. Calls its captured `__emitEvent({ kind: "action.request", name, input })`
     to emit the start of the action lifecycle.
  2. Notifies the host via its captured `__hostCallAction(name, input)`.
     The host (registered with the bridge method name
     `host.validateAction`) looks up the action by name in the
     workflow's manifest, validates `input` against the declared JSON
     Schema (Ajv on the host side), and emits an audit-log entry. The
     host returns `undefined` — it does NOT dispatch the user's
     handler.
  3. Invokes the author's handler as a plain JS function call in the
     same QuickJS context (no nested `sandbox.run()`).
  4. Validates the handler's return value against the action's output
     Zod schema using the Zod bundle that ships inlined in the
     workflow bundle.
  5. Calls its captured `__emitEvent({ kind: "action.response", name,
     output })` (or `action.error` on any thrown rejection in
     steps 2-4).
  Action code runs inside the sandbox's QuickJS boundary at all times
  — the host bridge is reached only for input validation + audit
  logging. Validation errors from either end propagate across the
  bridge (when thrown host-side) or propagate directly (when thrown
  sandbox-side, step 4) as JS `Error` rejections. On the host-thrown
  path, the guest-side error carries the Zod-shaped `issues` array
  preserved as a JSON-marshaled own property. Because
  `__dispatchAction` is locked (non-writable, non-configurable), guest
  code cannot replace the dispatcher; calling it directly remains
  possible and is an accepted residual (see R-S10).
- If the runtime does not pass `__hostCallAction` in `methods`, the
  dispatcher shim captures `undefined`; the first step of dispatch
  throws "is not a function" and the author's handler MUST NOT
  execute.
- **Bridge surface inventory** (install → capture → delete lifecycle
  for the underscore-prefixed host bridges, plus the post-init guest-
  visible globals):
  - **Built-ins installed then captured-and-deleted** (hardcoded in
    `packages/sandbox/src/globals.ts` / `worker.ts`): `__hostFetch`
    (captured by `FETCH_SHIM` at init, deleted after the shim installs
    `fetch`) and `__emitEvent` (installed via `vm.newFunction`,
    captured by the runtime's dispatcher shim, deleted after the shim
    installs `__dispatchAction`). Neither name is reachable from guest
    code after init.
  - **Runtime-passed bridges, then captured-and-deleted** (via
    `methods` at `sandbox(source, methods)` construction):
    `__hostCallAction` (captured by the runtime's dispatcher shim,
    deleted after the shim installs `__dispatchAction`) and
    `__reportError` (captured by `REPORT_ERROR_SHIM` at init, deleted
    after the shim installs `reportError`). Neither name is reachable
    from guest code after init. `__reportError` has construction-time
    binding only; per-run override is not supported.
  - **Built-ins that remain guest-visible**: `console`, `setTimeout`,
    `setInterval`, `clearTimeout`, `clearInterval`, `fetch` (locked
    JS shim), `reportError` (JS shim), `self`, `navigator`, plus the
    `crypto.subtle` Promise shim that wraps the WASM crypto
    extension's synchronous API.
  - **WASM extension globals** (provided by `quickjs-wasi` extensions
    loaded at VM creation in `worker.ts`): `URL`, `URLSearchParams`,
    `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`,
    `Headers`, `crypto` (including `crypto.subtle.*`), `performance`.
    These live inside WASM linear memory; they are not host bridges
    and consume no host capability.
  - **Runtime-appended and locked**: `__dispatchAction`. Installed via
    `Object.defineProperty` with `writable: false, configurable: false`
    by the runtime's post-bundle IIFE. Guest may call it; guest may
    not replace or delete it. This is the sole underscore-prefixed
    global that remains on `globalThis` after init. The sandbox
    package itself does not install it — it is plain workflow-bundle-
    appended source that the runtime emits to wire the captured
    `__emitEvent` and `__hostCallAction` together for the SDK's action
    callable.
- Handlers receive `(payload)` (trigger) or `(input)` (action) — no
  `ctx` parameter. Workflow-level env is declared on
  `defineWorkflow({env})` and is referenced via the imported
  `workflow.env` record (module-scoped, frozen at load time). Env
  values are resolved from `process.env` on the host at bundle load
  and shipped into the sandbox as JSON; no per-action scoping, no
  cross-workflow leakage (each workflow has its own sandbox + its own
  env record).
- No other globals are present. `process`, `require`, `fs`, and Node
  APIs are absent.

### WASI override inventory

The QuickJS WASM module imports a small set of `wasi_snapshot_preview1`
functions. Three are overridden by `packages/sandbox/src/wasi.ts` so
host-reaching calls that bypass the explicit bridge are still
observable. The others keep `quickjs-wasi`'s default shim.

- **`clock_time_get(clockId, _precision, resultPtr)`** — drives
  `Date.now()`, `new Date()`, `performance.now()`, and the one-time seed
  of QuickJS's xorshift64\* PRNG (so `Math.random()` inherits from this
  clock). `CLOCK_REALTIME` passes through to host `Date.now() × 1e6` ns.
  `CLOCK_MONOTONIC` returns `(performance.now() × 1e6) − anchorNs`,
  where `anchorNs` is captured at worker init and re-captured every
  time `bridge.setRunContext` fires, so guest `performance.now()`
  restarts near zero at the beginning of each run. While a run context
  is active, each call emits one `system.call` InvocationEvent
  (`name = "wasi.clock_time_get"`, `input = { clockId }`,
  `output = { ns }`). Calls outside a run context (during
  `QuickJS.create`, WASI libc init, guest source eval) pass through
  silently without emitting.
- **`random_get(bufPtr, bufLen)`** — drives `crypto.getRandomValues`,
  `crypto.randomUUID`, and every internal entropy read made by the
  WASM crypto extension (key generation, IV, nonces, HKDF seeds). The
  override fills the requested buffer from host
  `crypto.getRandomValues`. While a run context is active, each call
  emits one `system.call` InvocationEvent
  (`name = "wasi.random_get"`, `input = { bufLen }`,
  `output = { bufLen, sha256First16 }`). The `sha256First16` field is
  the hex encoding of the first 16 bytes of the SHA-256 digest of the
  returned bytes. **The raw entropy bytes MUST NEVER appear in any
  emitted event or log** — only the size and this bounded fingerprint.
  Calls outside a run context pass through silently.
- **`fd_write(fd, iovsPtr, iovsLen, nwrittenPtr)`** — receives bytes
  QuickJS engine-internal paths write to stdout/stderr (rare — mostly
  mbedTLS notices and engine panic paths). Guest `console.log` does
  NOT reach `fd_write`; it uses the `console.*` bridge installed by
  `globals.ts`. The override decodes bytes as UTF-8, line-buffers per
  fd, and on each completed line posts a
  `WorkerToMain { type: "log", level: "debug", message:
  "quickjs.fd_write", meta: { fd, text } }` message. The main thread
  routes the message to the sandbox's injected `Logger.debug` (or
  silently drops it when no logger is injected). **`fd_write` bytes
  never become InvocationEvents** — engine plumbing belongs in the
  operational log, not the workflow event stream. Host `process.stdout`
  and `process.stderr` receive nothing: the default shim's
  pass-through is fully replaced.

**Residual observability gap.** Operations inside the WASM crypto
extension (`crypto.subtle.digest`, `crypto.subtle.generateKey`,
`crypto.subtle.encrypt`, and so on) run entirely inside the extension's
WASM memory without crossing a boundary this project instruments. The
extension's entropy consumption is observable via the `wasi.random_get`
events above, but the higher-level operation (e.g. "a private key was
generated") is not directly observable. Closing that gap would require
separate instrumentation at the crypto extension ABI layer and is out
of scope here.

### Threats

| ID | Threat | Category |
|----|--------|----------|
| S1 | Action escapes sandbox by manipulating the host bridge (e.g. forging promise resolution, re-entering host code) | Elevation of privilege |
| S2 | Action consumes unbounded memory in the WASM heap, starving the host | DoS |
| S3 | Action runs an infinite loop, blocking the host event loop on the `vm.evalCode` call | DoS |
| S4 | Action schedules infinite timers to keep the host pumping jobs | DoS |
| S5 | Action uses `fetch()` / `__hostFetch` to reach internal K8s services, cloud metadata endpoints, or private network ranges (SSRF) | Information disclosure / EoP |
| S6 | Action reads secrets via `workflow.env` that were declared by another workflow | Information disclosure |
| S7 | Action exfiltrates trigger payload data or secrets by returning them from the trigger handler (visible in HTTP response + archive record) or by passing them as action input (audit-logged + written to archive on failure) | Information disclosure |
| S8 | Action generates cryptographic material and exports it through the handler return value or an outbound `fetch()` | Information disclosure |
| S9 | A new host-bridge API is added that accepts a raw host-object reference, allowing reflection / mutation of host state | Elevation of privilege |
| S10 | Guest code calls `__hostCallAction` with a payload that triggers prototype pollution on the host (`__proto__`, `constructor.prototype`) | Tampering / EoP |
| S11 | Guest code calls the locked `__dispatchAction` with `(validActionName, realInput, fakeHandler, fakeSchema)` to emit `action.*` audit events that misrepresent which handler actually ran | Tampering (audit-log integrity) |

### Mitigations (current)

- **Fresh VM per workflow module load.** `QuickJS.create()` (one-level
  model; `quickjs-wasi` exposes a single VM handle per instance, not
  the runtime/context split that `quickjs-emscripten` used) is called
  once when the workflow registry first instantiates a workflow. The
  VM is reused across all subsequent `run()` / handler-invoke calls
  for that workflow. Module-level state persists across runs within
  the same workflow. Disposal happens on workflow reload/unload via
  `Sandbox.dispose()`. Each VM has its own dedicated WASM linear
  memory; cross-VM memory access is physically impossible.
  (`packages/sandbox/src/index.ts`, `packages/runtime/src/workflow-registry.ts`)
- **Cross-workflow isolation preserved.** Each workflow gets its own
  `Sandbox` instance with its own QuickJS VM and its own WASM linear
  memory. State leaking within a workflow is self-leakage (same trust
  domain — one author, one manifest, one deploy). Cross-workflow
  leakage is physically impossible: separate VMs, separate WASM
  memory, separate env records. `CryptoKey` objects also live inside
  WASM linear memory (as PSA key handles managed by the WASM crypto
  extension) and are freed automatically when the VM is disposed — no
  host-side opaque reference store is involved.
- **No Node.js surface.** QuickJS WASM (via `quickjs-wasi`, the WASI
  build — no Emscripten / no `require`, no `process`, no `fs`,
  `child_process`, or network APIs) has no built-in Node.js APIs.
  Only the explicit globals set in `packages/sandbox/src/globals.ts`
  and `worker.ts` (including the `fetch` shim routing through
  `__hostFetch`), the globals contributed by the loaded WASM
  extensions (url, encoding, base64, structured-clone, headers,
  crypto), and the construction-time + per-run host methods are
  present.
- **Allowlist of globals.** Adding a built-in bridge requires editing
  `globals.ts` explicitly. Consumer-provided methods are declared as a
  plain `Record<string, async fn>` — the Bridge primitive
  (`sync`/`async`/`arg`/`marshal`/`opaque-ref`) is fully internal to the
  sandbox package and cannot be reached by consumers.
- **JSON-only host/sandbox boundary.** Arguments and return values of
  host-provided methods are JSON-marshalled. Host object references,
  closures, and proxies cannot cross. Trigger payloads, action input
  and output, and `workflow.env` all cross the boundary as JSON values.
- **Per-workflow env scoping.** `workflow.env` exposes only the keys
  declared in that workflow's `defineWorkflow({env})`. Other workflows'
  env vars are not reachable — each workflow has its own sandbox with
  its own env record (mitigates S6 structurally, not just by policy).
- **Action input validation at the host bridge.** When a handler does
  `await sendNotification(input)`, the SDK wrapper calls
  `__hostCallAction("sendNotification", input)`. The runtime's
  dispatcher (`workflow-registry.ts`'s `buildHostCallAction()`) looks
  up the action in the manifest, runs `input` through a pre-compiled
  Ajv validator against the manifest's JSON Schema, and audit-logs the
  invocation. The host does NOT dispatch the handler — the SDK wrapper
  does, in-sandbox, immediately after the bridge returns. Validation
  failures throw back into the guest with the Zod/Ajv `issues` array
  preserved as a JSON-marshaled own property on the Error. This makes
  input validation authoritative (the manifest schemas live on the
  host) even if the guest-side Zod bundle is compromised.
  (`packages/runtime/src/workflow-registry.ts`,
  `packages/runtime/src/triggers/http.ts`)
- **Action output validation in-sandbox.** The SDK wrapper validates
  the handler's return value against the output Zod schema using the
  Zod bundle inlined in the workflow bundle. A single bridge crossing
  covers input; output validation stays guest-side because the return
  is already a guest value. If the guest tampers with its own Zod
  copy, the self-harm is contained — input validation (the canonical
  contract, host-side) remains authoritative.
- **Trigger payload validation on ingress.** Before the executor
  is invoked, the HTTP trigger middleware validates the request body
  against the trigger's JSON Schema (Ajv, compiled once per trigger at
  registry load). Validation failure → 422 response, no sandbox entry,
  no archive record.
  (`packages/runtime/src/triggers/http.ts`)
- **Static analysis.** TypeScript strict mode and Biome `all` rules are
  enabled to catch unsafe bridge patterns early.
- **Worker-thread isolation of the host-bridge layer.** The QuickJS
  runtime and the host-bridge implementation (`bridge-factory.ts`,
  `bridge.ts`, `globals.ts`) run inside a dedicated `worker_threads`
  Worker, not on the Node main thread. This is an
  implementation-level defense-in-depth layer: guest code still cannot
  observe Node internals (QuickJS is the primary boundary), and the
  worker has no additional permissions (same `process.env`, same file
  system). What it does buy is that long synchronous guest CPU work
  (S3) no longer freezes the main event loop — trigger ingestion and
  the operator UI stay responsive. Unexpected worker termination is
  surfaced as a `Sandbox.onDied` callback; the factory evicts and
  respawns on next `create(source)`.
  (`packages/sandbox/src/worker.ts`, `packages/sandbox/src/factory.ts`)
- **Cancel-on-run-end.** When a guest's exported function resolves
  (or throws), the worker clears every `setTimeout`/`setInterval`
  registered during that run and aborts the per-run `AbortController`
  that wraps in-flight `__hostFetch` calls. Un-awaited background
  work does not outlive the run. This closes a latent bug where a
  guest's `setTimeout(() => fetch(...), N)` could fire after the
  trigger handler returned and touch the response headers of a later
  invocation.
- **Per-workflow runQueue serialization.** The executor serializes one
  trigger invocation at a time per workflow (cross-workflow invocations
  remain parallel). Combined with cancel-on-run-end, this eliminates
  a whole class of module-state race conditions between concurrent
  invocations against the same sandbox.
  (`packages/runtime/src/executor/run-queue.ts`)

### Residual risks

These are **known gaps**. AI agents must not assume protection where none
exists. Each item should be tracked as a follow-up security task.

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-S1 | `SandboxOptions.memoryLimit` wires through to `QuickJS.create({ memoryLimit })` — callers that pass it get enforcement, callers that omit it fall back to the WASM module defaults | S2 opt-in | Caller-controlled (runtime does not set a default yet) |
| R-S2 | WASI `interruptHandler` is supported by the engine, but the current worker protocol cannot serialize functions across `postMessage`, so there is no wired-in timeout. An interrupt handler that fires after N bytecode steps or a deadline would need a worker-side factory reconstituted from a serializable descriptor. | S3 unmitigated | **Follow-up** (engine supports it; wire-up is pending) |
| R-S3 | Host timers (`setTimeout` / `setInterval`) run on the Node event loop with no per-spawn cap; cancel-on-run-end mitigates cross-run leakage but an active run can still register arbitrarily many pending callbacks | S4 partial | v1 limitation |
| R-S4 | `__hostFetch` has **no URL allowlist/denylist** at the app layer — the sandbox can reach any public URL the pod can reach. Infrastructure half (RFC1918 + cloud metadata) closed by K8s NetworkPolicy (§5). Public URL allowlist is a pending app-layer control. | S5 partial | **High priority** (app-layer half) |
| R-S5 | K8s `NetworkPolicy` on the runtime pod restricts cross-pod traffic and blocks RFC1918 + link-local egress | S5 in-cluster / metadata half mitigated | **Resolved** (see §5 R-I1 / R-I9) |
| R-S6 | Workflow `env` is resolved at load time from `process.env` and shipped into the sandbox as JSON; any secret baked into `workflow.env` that a handler deliberately returns, echoes into an action input, or logs will appear in the archive record / pino logs | S7 partial | Behavioural; author responsibility |
| R-S7 | **Resolved.** CryptoKey objects no longer live in a host-side opaque reference store — the WASM crypto extension manages them internally (PSA key handles in WASM linear memory) and they are freed with the VM. The previous unbounded-growth concern is eliminated by the engine swap. | — | **Resolved** (quickjs-wasi migration) |
| R-S8 | `crypto.subtle.exportKey("jwk", ...)` is not supported by the WASM crypto extension (raw / pkcs8 / spki are). Workflows that require JWK export must export as raw and serialize to JWK themselves, or wait for the extension to add the format. | Feature gap | v1 limitation (engine-level) |
| R-S9 | WASI `clock` and `random` overrides (for deterministic / replay execution) cannot be sent across the worker `postMessage` boundary as-is. Engine supports them at `QuickJS.create({ wasi: ... })`; wire-up requires a serializable descriptor resolved on the worker side. | Replay infrastructure | **Follow-up** (engine supports it; wire-up is pending) |
| R-S10 | `__dispatchAction` remains on `globalThis` after init so the SDK's `core.dispatchAction()` helper can find it. The property is locked (`writable: false, configurable: false`), so guest code cannot replace or delete it. It can still be *called* directly — guest calling `__dispatchAction(validActionName, realInput, fakeHandler, fakeSchema)` causes `action.*` events to name `validActionName` and pass host-side input validation, while the fake handler actually runs. This poisons the audit log: the event stream claims the real action ran successfully when a different handler executed. Input validation (host-side) remains authoritative; sandbox isolation is not breached. | S11 accepted | **Accepted** (documented residual; fix would require moving dispatcher reachability off `globalThis`, e.g. via a core-package `setDispatcher` indirection) |

### Rules for AI agents

1. **NEVER add a global, host-bridge API, or Node.js surface to the
   QuickJS sandbox without extending the allowlist in this section in the
   same PR**, with a written rationale and threat assessment per surface
   added. The enumeration in "Globals exposed inside the sandbox" above is
   the exhaustive set of surfaces the sandbox exposes; anything not listed
   is forbidden. New globals expand the attack surface by definition.
2. **NEVER pass a live host-object reference into the sandbox.** Only
   JSON-serializable snapshots cross the boundary. If a new bridge API
   needs to accept data from the sandbox, receive it as a string or
   number and validate it with Zod on the host side before acting on it.
3. **NEVER expose Node.js APIs, `process`, `require`, or filesystem
   access to sandbox code** — directly or through a bridge wrapper.
4. **NEVER reuse a sandbox context across workflows.** Each loaded
   workflow SHALL have its own `Sandbox` instance. Within a single
   workflow, reuse is permitted and expected — module-level state
   persists across `run()` calls for the same workflow. Disposal happens
   on workflow reload/unload; always call `Sandbox.dispose()` when
   evicting from the workflow registry.
5. **NEVER return a host `Promise`'s original reference to the sandbox.**
   The sandbox-internal Bridge primitive handles deferred-promise
   translation via `vm.newPromise()`; consumers provide plain async
   functions and let the sandbox marshal.
6. **NEVER expose the Bridge primitive through the public API.**
   `sync`/`async`/`arg`/`marshal` are sandbox-internal implementation
   details. Consumers register host methods only via `methods`
   (construction-time) and `extraMethods` (per-run). All arguments and
   return values on the public boundary
   are JSON.
7. **When adding an outbound capability (fetch, action call, etc.),
   explicitly consider SSRF and exfiltration.** If there is no URL
   allowlist today, say so in the change proposal; do not claim the
   sandbox "prevents" the action from reaching an internal service.
8. **Sandbox-related changes MUST include security tests** (per
   `openspec/config.yaml` task rules) covering: escape attempts, global
   visibility, sandbox disposal, extraMethods collision rejection, and
   any new bridge API's failure modes.
9. **Every new runtime-passed method in `methods` MUST validate its
   input on the host side before acting on it.** The host is the
   authoritative validation boundary (the guest's Zod copy is
   untrusted). `__hostCallAction` compiles Ajv validators from the
   manifest at registry load and runs every input through one before
   audit-logging or returning. New methods SHALL follow the same
   pattern and SHALL be covered by a prototype-pollution test.
10. **NEVER install a `__*`-prefixed host bridge without wrapping its
    consumer in a capture-and-delete shim that removes the bridge name
    from `globalThis` before workflow source can read it.** The shim
    SHALL capture the bridge reference into its IIFE closure at init
    time, expose only the non-bridge guest-facing surface it implements
    (e.g. `fetch`, `reportError`), and SHALL `delete globalThis.__name`
    before returning. See the "Bridge surface inventory" subsection
    above and the sandbox spec's post-init surface requirement. The
    sole exception is `__dispatchAction`, which is installed with
    `Object.defineProperty({writable: false, configurable: false})` and
    documented as an accepted residual (R-S10); new bridges SHALL NOT
    follow this exception without an explicit threat assessment.

### File references

- Sandbox factory + `run()`: `packages/sandbox/src/index.ts`
- Host fetch bridge: `packages/sandbox/src/bridge.ts`
- Bridge primitive (internal; promise / host-function plumbing): `packages/sandbox/src/bridge-factory.ts`
- Host-method installer (internal): `packages/sandbox/src/install-host-methods.ts`
- Globals allowlist + fetch / crypto-subtle-Promise JS shims: `packages/sandbox/src/globals.ts`
- WebCrypto: provided natively by the `quickjs-wasi` `cryptoExtension` WASM extension (loaded in `worker.ts`); a JS Promise shim in `globals.ts` wraps `crypto.subtle.*` to return Promises per WebCrypto spec
- Workflow registry (owns per-workflow sandbox map + `__hostCallAction` dispatcher): `packages/runtime/src/workflow-registry.ts`
- HTTP trigger middleware (payload validation + executor delegation): `packages/runtime/src/triggers/http.ts`
- Executor (per-workflow runQueue + lifecycle emission): `packages/runtime/src/executor/`
- SDK (authoring API + in-sandbox action wrapper): `packages/sdk/src/index.ts`
- OpenSpec spec: `openspec/specs/sandbox/spec.md`
- OpenSpec spec: `openspec/specs/sdk/spec.md`

## §3 Webhook Ingress

### Trust level

**PUBLIC.** `POST /webhooks/{tenant}/{workflow}/{trigger_path}` is reachable by
anyone on the Internet without authentication. This is an **intentional design
choice**: webhooks are how external systems deliver events. Do not add
authentication here without an OpenSpec change proposal — existing
integrations depend on unauthenticated ingress.

The tenant and workflow-name prefixes in the URL are **identification, not
authorization**: knowledge of a valid `(tenant, workflow, path)` tuple is
sufficient to trigger the workflow. These segments exist to disambiguate
tenants and workflows at the routing layer, not to gate access.

Everything received on this surface must be treated as
attacker-controlled: body, headers, query string, URL parameters, and
timing.

### Entry points

- `POST /webhooks/{tenant}/{workflow}/{trigger_path}` (or whatever `method` the
  trigger declares; default POST) with JSON body.
- `{tenant}` and `{workflow}` are validated against the tenant identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`); non-matching values receive 404.
- Path matching via URLPattern (for `{trigger_path}`); supports `:param` path
  segments and `*wildcard` tail segments. Static segments are prioritized over
  parameterized (`packages/runtime/src/triggers/http.ts`).
- Request data delivered to the trigger handler as the `payload`
  argument:

  ```typescript
  { body, headers, url, method, params, query }
  ```

  `body` is a JSON-parsed object validated against the trigger's JSON
  Schema (Ajv) before the sandbox is entered. `headers`, `url`, `method`,
  `params`, and `query` are attacker-controlled metadata — the sandbox
  sees them as data, not as authentication.

### Threats

| ID | Threat | Category |
|----|--------|----------|
| W1 | Attacker sends malformed JSON or schema-violating payload to crash the handler or poison the invocation store | Tampering |
| W2 | Attacker sends a very large payload, exhausting memory or stream buffers | DoS |
| W3 | Attacker floods an endpoint with high-rate requests | DoS |
| W4 | Attacker impersonates a legitimate upstream (e.g. GitHub, Stripe) — no signature verification | Spoofing |
| W5 | Attacker injects headers (`Authorization`, `Cookie`, `X-Forwarded-*`) that handler code treats as trusted | Spoofing / information disclosure |
| W6 | Attacker probes path variants to discover registered trigger names | Information disclosure |
| W7 | Attacker sends a payload that matches schema but forces an expensive handler path (e.g. unbounded Promise.all over action calls) | DoS |
| W8 | Query-string or URL-parameter injection, passed unsanitized into handler code | Tampering |

### Mitigations (current)

- **Ajv JSON Schema validation** of the request body against the
  trigger's manifest schema. Invalid payloads return **422** with
  structured issues and never reach the sandbox or the executor.
  No matching trigger → **404**. Handler throws → **500** + a `failed`
  archive record.
  (`packages/runtime/src/triggers/http.ts`)
- **Structural JSON round-trip** of the body before validation
  (`structuredCloneJson()` in the workflow registry) strips
  `__proto__` and `constructor` keys from the attacker-supplied object,
  so prototype-pollution payloads cannot poison the validator or the
  downstream handler object.
- **Sole invocation path is `executor.invoke(workflow, trigger, payload)`.**
  The middleware's only job after validation is to delegate to the
  executor and serialize the returned `HttpTriggerResult`. The executor
  owns runQueue serialization + lifecycle emission; the middleware does
  not call into the sandbox directly.
- **Payload scope reaches the sandbox only as the handler's `payload`
  argument** — a JSON snapshot. Any downstream code that consumes the
  payload runs in the sandbox with no host APIs (see §2).
- **TLS termination at Traefik** (HTTPS only on the websecure
  entrypoint).
- **Deterministic path matching** via URLPattern; static segments beat
  parameterized, reducing ambiguity.
- **Separate trust domain** — webhook handlers cannot read the session
  cookies or bearer tokens used by the UI / API routes, because those
  headers are not forwarded to this route family.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-W1 | **No signature verification** on incoming payloads (HMAC, GitHub signature, Stripe signature, etc.) | W4 unmitigated | v1 limitation; add per-integration |
| R-W2 | **No payload size limit** configured at the application or Traefik level | W2 unmitigated | v1 limitation |
| R-W3 | **No rate limiting** at the application or Traefik level | W3, W7 unmitigated | v1 limitation |
| R-W4 | **All request headers are forwarded verbatim** into the payload's `headers` field, including any `Authorization` / `Cookie` the caller sent | W5 unmitigated | **High priority** — move to per-trigger header allowlist |
| R-W5 | Trigger names are reflected in 404 vs 422 vs 200 response differences, enabling enumeration | W6 low | Accepted; triggers are not secret |
| R-W6 | Query-string and path parameters are placed unsanitized into `payload.query` / `payload.params` | W8 partial | Mitigated by sandbox (§2), but handlers must still treat as untrusted |

### Implementation guidance for signed webhooks

When adding signature verification for a specific integration (e.g.
GitHub webhooks, Stripe webhooks), implement the verifier as a
**pre-validation step in the HTTP trigger middleware** — before the
Ajv body-schema check and before `executor.invoke` — and reject
unsigned or incorrectly signed requests with 401 before any sandbox
entry. Store the signing secret as a K8s Secret per §5, never in the
trigger definition. The verifier must not skip the schema check; a
valid signature on a schema-violating payload still returns 422.

### Rules for AI agents

1. **NEVER add authentication to `/webhooks/*` without an explicit
   OpenSpec proposal.** Public ingress is deliberate.
2. **NEVER strip the Ajv body-schema validation step** between the
   incoming request and `executor.invoke`. It is the only pre-sandbox
   filter.
3. **NEVER treat webhook payload metadata (headers, IP, query string)
   as authenticated.** Even if a caller sets `Authorization: Bearer
   …`, that header is just user input on this surface.
4. **ALWAYS define a Zod `body` schema for new HTTP triggers.** The
   vite-plugin derives the manifest's JSON Schema from it; a trigger
   without a `body` schema accepts arbitrary untrusted JSON.
5. **When adding signature verification for a specific integration**,
   follow the "Implementation guidance for signed webhooks" above —
   verifier in the HTTP trigger middleware, before the body-schema
   check, never in handler code.
6. **DO NOT extend the webhook payload shape** (`body` / `headers` /
   `url` / `method` / `params` / `query`) without updating this section
   and the `http-trigger` spec. New fields expand what untrusted data
   reaches the sandbox.
7. **When adding a new trigger type**, decide its trust level first:
   public (like HTTP webhooks) → §3 rules apply; authenticated
   (scheduled, internal) → document separately. Each concrete trigger
   type also gets its own SDK factory (`httpTrigger({...})`-style),
   its own brand symbol, and its own spec file.

### File references

- Webhook middleware + registry: `packages/runtime/src/triggers/http.ts`
- Payload validation entry + body-shape normalization: `packages/runtime/src/workflow-registry.ts`
- Executor (post-validation invocation path): `packages/runtime/src/executor/`
- Traefik routing: `infrastructure/modules/workflow-engine/modules/routing/routing.tf`
- OpenSpec spec: `openspec/specs/triggers/spec.md`
- OpenSpec spec: `openspec/specs/http-trigger/spec.md`
- OpenSpec spec: `openspec/specs/payload-validation/spec.md`

## §4 Authentication

### Trust level

**AUTHENTICATED** — but with different mechanisms and different trust
chains for different routes. This section is the most nuanced: a single
mistake in wiring (a missing env var, a bypassed middleware, a trusted
forwarded header) can collapse the whole auth boundary.

Two distinct auth surfaces:

1. **UI routes** (`/dashboard`, `/trigger`, and any future authenticated
   UI prefix) — authenticated by **oauth2-proxy** at the **Traefik
   forward-auth** layer. The application receives
   `X-Auth-Request-User` and `X-Auth-Request-Email` headers and trusts
   them.
2. **API** (`/api/*`) — authenticated **in the application** by
   `githubAuthMiddleware`, which validates a Bearer token against
   `https://api.github.com/user` and checks the login against a
   comma-separated allow-list configured via the `GITHUB_USER` env
   var. The middleware operates in one of three modes
   (`restricted` / `disabled` / `open`) resolved from config at
   startup — see §4 Mitigations and the `github-auth` spec.

"UI" is used throughout this section as the category name (rather than
"Dashboard") because the trust domain spans `/dashboard`, `/trigger`,
and any future authenticated UI prefix.

### Entry points

| Route family | Auth mechanism | Enforced by | Bypass check |
|---|---|---|---|
| UI routes (`/dashboard`, `/trigger`, future UIs) | GitHub OAuth2 via oauth2-proxy | Traefik `ForwardAuth` middleware | Any new UI prefix must be added to the forward-auth-protected list |
| `/api/*` | GitHub Bearer token + allow-list; three modes (`restricted` / `disabled` / `open`) | App-level middleware, always registered | `disabled` (fail-closed 401) when allow-list is missing; `open` requires the explicit `__DISABLE_AUTH__` sentinel |
| `/webhooks/*` | **None (PUBLIC)** | Intentional | See §3 |
| `/static/*`, `/livez`, `/` | None | Intentional | Must stay non-sensitive |
| `/oauth2/*` | N/A (OAuth2 callback itself) | oauth2-proxy | Never add application logic on these paths |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| A1 | Attacker steals a session cookie (XSS, shared device) and accesses a UI route | Spoofing |
| A2 | Attacker steals a Bearer token and accesses `/api/*` | Spoofing |
| A3 | Request bypasses Traefik and reaches the app pod directly, sending forged `X-Auth-Request-User` | Spoofing / EoP |
| A4 | A new authenticated route is added but not wired through the forward-auth middleware | EoP |
| A5 | Deployment sets the `__DISABLE_AUTH__` sentinel in production (intended for local dev only), opting `/api/*` into `open` mode and reaching the handler unauthenticated | EoP |
| A6 | oauth2-proxy cookie secret is leaked or reused across deployments, enabling cookie forgery | Spoofing |
| A7 | GitHub API is unreachable; `/api/*` returns 401 for all callers (availability) | DoS |
| A8 | GitHub API rate-limits the application's IP (no caching of token validation) | DoS |
| A9 | Bearer token is logged via request / response logging or included in an event payload | Information disclosure |
| A10 | User is removed from the `GITHUB_USER` / `OAUTH2_PROXY_GITHUB_USERS` allowlist but an existing session cookie stays valid until expiry | EoP (stale access) |
| A11 | Open redirect via `/oauth2` callback parameters | Spoofing (phishing) |
| A12 | Allow-listed user uploads to a tenant they are not a member of (or enumerates tenants) to discover tenant names | EoP (cross-tenant) / Information disclosure |

### Mitigations (current)

- **HTTPS-only cookies** (`OAUTH2_PROXY_COOKIE_SECURE=true`) — cookies
  are not sent over plain HTTP.
  (`infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf` line 166)
- **Per-deployment random cookie secret** (32 bytes, generated at apply
  time, stored in a K8s Secret, marked sensitive).
- **Single-source-of-truth allow-list.** The Terraform
  `oauth2.github_users` variable feeds both `OAUTH2_PROXY_GITHUB_USERS`
  (UI) and `GITHUB_USER` (API), so the UI and API authorize the same
  set of GitHub logins by construction.
  (`infrastructure/modules/workflow-engine/modules/app/app.tf`;
  `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`)
- **Multi-user API allow-list.** `GITHUB_USER` is parsed as a
  comma-separated list (pflag `StringSlice` parity with oauth2-proxy);
  any login in the list is accepted. Matching is case-sensitive.
- **Fail-closed three-mode API middleware.** The API middleware is
  **always registered** and resolves to one of three modes from config
  at startup: `restricted` (token validated + login on allow-list),
  `disabled` (every request → 401, no outbound call to GitHub),
  `open` (middleware not installed). Unset `GITHUB_USER` →
  `disabled`; the explicit sentinel `__DISABLE_AUTH__` → `open`.
  A missing config **never** silently opens the API.
  (`packages/runtime/src/api/auth.ts`; `packages/runtime/src/config.ts`;
  `openspec/specs/github-auth/spec.md`,
  `openspec/specs/runtime-config/spec.md`)
- **Allow-list enumeration protection.** All negative outcomes in
  `restricted` mode (missing header, invalid token, wrong login,
  GitHub network error) return `401 Unauthorized` with an identical
  body; the status code does not distinguish "wrong user" from "bad
  token", preventing enumeration by holders of valid PATs.
- **Tenant membership enforcement for `/api/workflows/<tenant>` (R-A12).**
  The upload handler runs `githubAuthMiddleware` first (allow-list gate),
  then `userMiddleware` (which populates `UserContext.orgs` and `.name`
  by hitting `/user`, `/user/orgs`, `/user/teams` on GitHub for Bearer
  tokens and by parsing `X-Auth-Request-Groups` for oauth2-proxy). The
  handler then validates `<tenant>` against the identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) and evaluates
  `isMember(user, tenant) := user.orgs.includes(tenant) || user.name === tenant`.
  Both failures (invalid regex, non-member) return `404 Not Found` with
  body `{ "error": "Not Found" }`, indistinguishable from "tenant does
  not exist," which prevents allow-listed users from enumerating tenant
  names. Teams (`UserContext.teams`, populated from colon-separated
  groups) are **not** consulted for membership.
  (`packages/runtime/src/auth/tenant.ts`,
  `packages/runtime/src/api/upload.ts`)
- **Startup-logged auth mode.** The runtime emits a log record at
  startup identifying the effective `githubAuth.mode`, at `warn` level
  for `disabled` or `open`. Misconfigured deployments are visible in
  logs immediately.
- **Per-request token validation against GitHub** for the API — no
  long-lived stale sessions; a revoked GitHub token is rejected on the
  next request.
  (`packages/runtime/src/api/auth.ts`)
- **TLS termination at Traefik** — session cookies and Bearer tokens are
  not in cleartext on the wire.
- **Forward-auth integration** — Traefik calls oauth2-proxy's
  `/oauth2/auth` endpoint on every UI request; unauthenticated requests
  are redirected to the sign-in flow.
- **Separate trust domains for UI vs API** — the UI's cookie does not
  authenticate the API; the API's Bearer token does not sign a UI
  session.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-A1 | The `__DISABLE_AUTH__` sentinel exists for local development; a production deployment that sets it puts `/api/*` into `open` mode. The `warn`-level startup log is the only guard against accidental production use. | A5 | Mitigated by operational discipline and startup logs; consider refusing `open` mode when a production marker is set |
| R-A2 | No caching of GitHub token validation — every `/api/*` request makes a live GitHub API call. Exposes the application to GitHub availability and rate limits (A7, A8). | High | Design follow-up |
| R-A3 | K8s `NetworkPolicy` restricts app-pod ingress on `:8080` to Traefik pods only (`app.kubernetes.io/name=traefik`) plus the UpCloud node CIDR for kubelet probes. Forged `X-Auth-Request-User` from a neighbouring pod is no longer possible. | High | **Resolved** (see §5 R-I1) |
| R-A4 | Forwarded-header trust is implicit — the application does not verify requests came via Traefik / oauth2-proxy; it just reads `X-Auth-Request-User`. Now load-bearing on the NetworkPolicy from R-A3 to ensure only Traefik is a legitimate source. | Medium | Accepted given R-A3 resolution |
| R-A5 | No logout-on-allowlist-removal — removing a user from `OAUTH2_PROXY_GITHUB_USERS` does not invalidate existing sessions until cookie expiry. | Low-Medium | Accept or add session store |
| R-A6 | No explicit request / response logging policy for `Authorization` headers — nothing guarantees tokens are redacted from pino logs. | Medium | Verify logger config |
| R-A7 | GitHub OAuth is the only identity provider — no local fallback, no MFA enforcement beyond what GitHub offers. | Accepted | By design |
| R-A8 | No CSRF tokens on state-changing UI routes — session cookie is the only auth; if any cross-site POST is possible, forms could be submitted cross-origin. | TBD | Audit UI mutations |

### Rules for AI agents

1. **NEVER add a UI route (under `/dashboard`, `/trigger`, or any new
   authenticated UI prefix) without confirming the Traefik
   `oauth2-forward-auth` middleware applies to it.** Check
   `infrastructure/modules/workflow-engine/modules/routing/routing.tf`.
2. **NEVER add a route under `/api/` without the `githubAuthMiddleware`
   in front of it.**
3. **NEVER trust `X-Auth-Request-User`, `X-Auth-Request-Email`, or any
   `X-Forwarded-*` header as authoritative outside the current
   NetworkPolicy assumption.** The §5 `NetworkPolicy` restricts ingress
   on app `:8080` and oauth2-proxy `:4180` to Traefik pods only (plus
   the node CIDR for kubelet probes). Any change that weakens the
   NetworkPolicy selectors — e.g. relaxing the Traefik pod-label
   `app.kubernetes.io/name=traefik` — collapses this trust and MUST be
   flagged in the same review.
4. **NEVER log, emit, or store** the `Authorization` header, a session
   cookie, or an OAuth client secret. When adding new logging,
   explicitly allowlist which request fields go to logs.
5. **NEVER add a silent short-circuit for auth in development.** The
   only supported dev bypass is the explicit `__DISABLE_AUTH__`
   sentinel, which opts into `open` mode *visibly* (warn log at
   startup, documented in the `github-auth` spec). Do not introduce
   new implicit bypasses (env checks, `NODE_ENV`, debug flags).
6. **When adding a new config gate for auth enforcement**, make it
   fail-closed by default and visible at startup (warn-level log when
   the weaker mode is active). Document the gate and its three modes
   here so future agents can reason about it without reading code.
7. **Bearer tokens and session cookies live at different trust levels**
   — never design a feature that accepts either interchangeably. Pick
   one per surface.

### File references

- API auth middleware: `packages/runtime/src/api/auth.ts`
- Config / env: `packages/runtime/src/config.ts`
- API wiring: `packages/runtime/src/api/index.ts`
- UI header-trust middleware: `packages/runtime/src/ui/dashboard/middleware.ts`
- oauth2-proxy deployment: `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`
- Traefik routing / forward-auth: `infrastructure/modules/workflow-engine/modules/routing/routing.tf`
- OpenSpec spec: `openspec/specs/dashboard-auth/spec.md`
- OpenSpec spec: `openspec/specs/dashboard-middleware/spec.md`
- OpenSpec spec: `openspec/specs/github-auth/spec.md`
- OpenSpec spec: `openspec/specs/oauth2-proxy/spec.md`
- OpenSpec spec: `openspec/specs/runtime-config/spec.md`

## §5 Infrastructure and Deployment

### Trust level

**INTERNAL** — components that run inside the Kubernetes cluster, not
directly exposed to the Internet. "Internal" is **not** a substitute for
authentication: a compromised pod, a missing NetworkPolicy, or a rogue
workload can reach everything else in the cluster.

This section covers the current dev stack and production deployment
requirements (noted inline). The production target is an UpCloud K8s
cluster; see `openspec/specs/infrastructure/spec.md`.

### Entry points

| Component | Exposure | Port | Namespace | Who can reach it |
|---|---|---|---|---|
| Traefik Ingress (HTTPS) | Public (LB → 443, NodePort 30443 → 443 in dev) | 443 | `traefik` | Internet |
| Traefik Ingress (HTTP) | Public (LB → 80) | 80 | `traefik` | Internet — redirects to HTTPS, plus serves `/.well-known/acme-challenge/*` to cert-manager's HTTP-01 solver |
| oauth2-proxy | In-cluster Service | 4180 | per-instance (e.g. `prod`) | Traefik (cross-namespace forward-auth) |
| App (runtime) | In-cluster Service | 8080 | per-instance (e.g. `prod`) | Traefik (cross-namespace, NP-enforced) |
| S2 (S3-compatible storage) | In-cluster Service | 9000 | `default` (local only) | App pod (NP-enforced) |
| cert-manager controllers | In-cluster Service (webhook) | 9402 | `cert-manager` | kube-apiserver (admission webhooks) |
| DuckDB | Process-local | — | — | App process only (in-memory) |
| GitHub API | External egress | 443 | — | App pod (auth validation) |
| Let's Encrypt ACME (egress) | External egress | 443 | — | cert-manager (prod only, issuance + renewal) |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| I1 | K8s Secret is leaked via logs, etcd snapshots, or a pod with broad RBAC read | Information disclosure |
| I2 | A compromised pod or sidecar reaches the app pod's `:8080` directly, bypassing Traefik and forging `X-Auth-Request-User` (A3 from §4) | EoP |
| I3 | A compromised pod or action (via SSRF, §2) reaches cloud metadata endpoints (e.g. `169.254.169.254`) or internal admin APIs | Information disclosure / EoP |
| I4 | App container runs with unnecessary capabilities, a writable root filesystem, or as a privileged user | EoP |
| I5 | No resource limits → a runaway action or memory leak crashes the node, not just the pod | DoS |
| I6 | OAuth2 client secret or S3 credentials committed to a `.tfvars` file checked into git | Information disclosure |
| I7 | Traefik accepts weak TLS ciphers or outdated TLS versions | Tampering / eavesdropping |
| I8 | Self-signed dev cert used in production by mistake | Spoofing |
| I9 | S3 bucket policy permits unintended readers (production deployment) | Information disclosure |
| I10 | Events stored to S3 / filesystem in plaintext, containing secrets that leaked via action env vars | Information disclosure |
| I11 | Default ServiceAccount token auto-mounted into a pod becomes a latent `kube-apiserver` bearer credential. A sandbox escape, RCE, or future RoleBinding to `default` converts it into active cluster access. Amplified by R-I1 (no NetworkPolicy blocks pod → apiserver) and §2 R-S4 (no `__hostFetch` URL allowlist). | EoP / Information disclosure |

### Mitigations (current)

- **Namespace isolation** — each app-instance runs in a dedicated
  namespace (e.g. `prod`, `staging`). Traefik runs in `ns/traefik`.
  cert-manager in `ns/cert-manager`. The `default` namespace is empty
  (except S2 in local dev). Cross-namespace access is controlled by
  NetworkPolicy `namespaceSelector` rules.
- **PodSecurity admission `restricted`** — workload namespaces carry
  the `pod-security.kubernetes.io/enforce=restricted` label (initially
  `warn` during rollout). Non-compliant pods are rejected at admission.
  (`infrastructure/modules/baseline/baseline.tf`)
- **Explicit securityContext on all pods** — every workload sets
  `runAsNonRoot=true`, `runAsUser=65532`, `seccompProfile=RuntimeDefault`,
  `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`,
  `capabilities.drop=["ALL"]`. Writable paths use `emptyDir` mounts.
  (`infrastructure/modules/app-instance/workloads.tf`;
  `infrastructure/modules/object-storage/s2/s2.tf`;
  `infrastructure/modules/traefik/traefik.tf` Helm values)
- **Secrets in K8s Secret objects** — oauth2 client credentials, S3
  credentials, and the cookie secret are all stored as Kubernetes
  Secrets and injected via `envFrom.secretRef`. None are baked into
  images or committed to source.
  (`infrastructure/modules/app-instance/secrets.tf`;
  `infrastructure/modules/object-storage/s2/s2.tf`)
- **Terraform `sensitive = true`** on all secret variables; values are
  expected in `dev.secrets.auto.tfvars` which is gitignored.
- **Distroless non-root base image** — the application runs as UID
  65532 on `gcr.io/distroless/nodejs24-debian13`. No shell, minimal
  userspace. Numeric UID for PodSecurity admission static validation.
  (`infrastructure/Dockerfile`)
- **Internal-only services** — oauth2-proxy, S2, and the app's
  business-logic port are not published via NodePort; only Traefik is.
- **TLS at Traefik** — public traffic is HTTPS-only via the `websecure`
  entrypoint. Port 80 serves only cert-manager ACME HTTP-01 challenges
  and a catch-all 301 redirect to HTTPS; no app traffic flows on
  plaintext.
- **cert-manager-managed TLS** — production TLS certificates are issued
  by Let's Encrypt via the `letsencrypt-prod` ClusterIssuer (HTTP-01
  challenge, `ingressClassName: traefik`) and stored as K8s Secrets.
  Local uses a cluster-internal self-signed CA chain
  (`selfsigned-bootstrap` → `selfsigned-ca`). Chart version is pinned
  in `infrastructure/modules/cert-manager/cert-manager.tf`.
- **Build-time image versioning** — S2 uses a pinned minor tag
  (`0.4.1`); the app image is built from source.
- **`automountServiceAccountToken: false` on all app workloads** —
  app, oauth2-proxy, and S2 pods suppress the projected SA token.
  Mitigates **I11**.
  (`infrastructure/modules/app-instance/workloads.tf`;
  `infrastructure/modules/object-storage/s2/s2.tf`)
- **`Secret` wrapper for K8s-Secret-sourced config fields** — the
  runtime config schema wraps S3 credentials (and any future
  Secret-sourced field) in a `Secret` value. `toJSON`, `toString`, and
  `util.inspect` all return `"[redacted]"`; `reveal()` is the single
  exit, called only at the AWS SDK boundary in `main.ts`. Prevents
  cleartext credentials from reaching pino log sinks. Mitigates **I1**
  for the S3 credentials specifically.
  (`packages/runtime/src/config.ts` — `createSecret`)
- **JSON-serializer `toJSON()` contract**: the `Secret` wrapper
  depends on the in-use JSON serializer honoring `toJSON()`. Verified
  for pino (current logger) as of 2026-04-14. Any future change to the
  log transport must re-verify redaction before merging.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-I1 | Namespace-wide default-deny `NetworkPolicy` plus per-workload allow-rules: app / oauth2-proxy ingress restricted to Traefik (+ node CIDR for probes); Traefik ingress restricted to `0.0.0.0/0:80,443` + node CIDR; cross-pod traffic otherwise dropped. | I2, I3 | **Resolved** (production enforcement via Cilium; kindnet silently no-ops locally, accepted) |
| R-I2 | ~~App pod has no `securityContext`~~ — **Resolved**: all workloads now set explicit securityContext (runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation=false, capabilities.drop=[ALL]), enforced by PodSecurity admission `restricted` at namespace level. | I4 | **Resolved** |
| R-I3 | **No resource `requests` / `limits`** on the app, oauth2-proxy, or S2 pods — a runaway process can starve the whole node. | I5 (amplifies §2 R-S1 / R-S2) | **High priority** |
| R-I4 | ~~S2 container has no user specified~~ — **Resolved**: S2 now runs as UID 65532 with full securityContext. Data writes use emptyDir at `/data`. | I4 | **Resolved** |
| R-I5 | ~~TLS cert source not pinned in IaC~~ — **Resolved**: cert-manager codified in `infrastructure/modules/cert-manager/`; prod uses Let's Encrypt (HTTP-01), local uses a cluster-internal self-signed CA chain. Chart version is pinned. | I7, I8 | Resolved |
| R-I10 | **cert-manager has cluster-wide RBAC** — creates/manages Secrets cluster-wide and reconciles ClusterIssuer/Certificate resources. Compromise of the cert-manager controller pod grants broad Secret read/write. | I1, EoP | Accepted — standard upstream Helm-chart RBAC; chart version pinned; runs in `cert-manager` namespace. Revisit if narrower scope becomes available. |
| R-I7 | **No encryption at rest** — the event store and S3 objects are plaintext JSON. Any secret leaked through an action payload (e.g. via emit) is stored in readable form. | I10 | Out of scope for v1; see §2 R-S6 |
| R-I8 | **No secret-management integration** (Vault, SOPS, external-secrets). Secrets live in `terraform.tfvars` files on operator workstations. | I6 | Acceptable for small teams; revisit for production |
| R-I9 | Egress `ipBlock` `0.0.0.0/0` with `except = [10/8, 172.16/12, 192.168/16, 169.254/16]` blocks cluster pod/service CIDRs, the UpCloud node network, and cloud metadata (IMDS `169.254.169.254`). Public Internet egress remains open — URL-level scoping of `__hostFetch` (§2 R-S4 app-layer half) is still outstanding. | I3 (infrastructure half of §2 R-S4) | **Resolved** for metadata/RFC1918 (app-layer URL allowlist still pending under §2 R-S4) |
| R-I11 | **Traefik's SA token remains mounted** because the controller watches `Ingress` / `IngressRoute` via the K8s API. The Helm chart's ClusterRole has not been audited for least privilege; it may grant verbs/resources wider than ingress watching requires. | I11 partial | **Follow-up: audit Traefik chart RBAC scope** |
| R-I12 | **AWS SDK error messages** surfaced via `main.service-failed` may contain the S3 access key ID verbatim (e.g. `InvalidAccessKeyId`). The secret key is never echoed by the SDK. Impact: low — the access key ID alone cannot authenticate. | I1 partial | Accepted |

### Production deployment notes

When deploying to the production UpCloud K8s target, treat the
following as **must-have** before exposing to real traffic:

1. **NetworkPolicy** — DONE. Namespace-wide default-deny plus per-workload
   allow-rules: Traefik → app:8080, Traefik → oauth2-proxy:4180,
   app → Internet (RFC1918 + IMDS blocked) + CoreDNS,
   oauth2-proxy → Internet + CoreDNS, Traefik → Internet + CoreDNS.
   Resolves R-I1, R-A3, and the infrastructure half of R-I9 / §2 R-S4.
   Note: app does NOT need to reach oauth2-proxy directly — forward-auth
   is performed by Traefik, not the app.
2. **Pod `securityContext`** — DONE. All workloads set
   `runAsNonRoot: true`, `runAsUser: 65532`,
   `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`,
   `capabilities.drop: ["ALL"]`. Enforced by PodSecurity admission
   `restricted` at namespace level. Resolves R-I2.
3. **Resource requests / limits** — at minimum `cpu` and `memory`
   limits on every pod, sized from observed usage. Resolves R-I3.
4. **Real TLS** — cert-manager with the `letsencrypt-prod` ClusterIssuer
   and HTTP-01 challenge is wired in (`infrastructure/envs/upcloud/cluster/upcloud.tf`,
   `infrastructure/modules/cert-manager/`). Resolves R-I5 and I8.
5. **Egress policy** — NetworkPolicy half DONE (see item 1). URL
   filtering inside `__hostFetch` (§2 R-S4 app-layer half) is still
   outstanding; combined mitigation resolves R-I9 completely once that
   app-layer control lands.
6. **Encrypted event storage** — if UpCloud Object Storage is used,
   enable server-side encryption. Document the key custody model.
7. **Secret rotation procedure** — document how to rotate the
   `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`, and S3
   credentials without downtime.

### Rules for AI agents

1. **NEVER commit a `.tfvars` file containing real secrets.** Use the
   `.example` pattern; put the real file in `.gitignore`.
2. **NEVER add a new public NodePort, Ingress, or Route** without
   explicit review. The public surface is currently exactly Traefik
   on 443; widening it requires §3 / §4 treatment.
3. **NEVER hardcode a secret** in Terraform, Kubernetes manifests,
   Helm values, or container images. Secrets come from K8s Secrets
   injected via `envFrom.secretRef`.
4. **NEVER downgrade to HTTP** for any route. Cookies rely on
   `COOKIE_SECURE=true`; serving plain HTTP breaks session security.
5. **When adding a new in-cluster service**, place it on an in-cluster
   Service only (not NodePort). Document who is allowed to reach it
   and plan for a NetworkPolicy.
6. **When adding a new environment variable that holds a secret**,
   route it through a K8s Secret. Mark the Terraform variable
   `sensitive = true`. Do not log it. In the runtime config schema,
   wrap the field with `createSecret()` at the zod field level so the
   resulting `Secret` value self-redacts on `JSON.stringify`,
   `String()`, and `util.inspect`. Reveal only at the boundary that
   hands the cleartext to the receiving client (e.g. AWS SDK).
7. **Assume "internal" is not a perimeter.** Any new component must
   justify its own auth / isolation story, not rely on "it's only
   cluster-local".
8. **When adding infrastructure for production deployment**, consult
   the "Production deployment notes" checklist above.
9. **When adding a new K8s workload**, set
   `automountServiceAccountToken: false` at the pod spec. If the
   workload genuinely needs the K8s API, create a dedicated
   `ServiceAccount` with the narrowest possible `Role` /
   `ClusterRole`, justify it in the PR, and add it to this section as
   a named exception (I11).

### File references

- App + oauth2-proxy deployment: `infrastructure/modules/app-instance/workloads.tf`
- App-instance secrets: `infrastructure/modules/app-instance/secrets.tf`
- App-instance NetworkPolicies: `infrastructure/modules/app-instance/netpol.tf`
- Traefik: `infrastructure/modules/traefik/traefik.tf`
- Baseline (namespaces, PSA, default-deny): `infrastructure/modules/baseline/baseline.tf`
- NetworkPolicy factory: `infrastructure/modules/netpol/main.tf`
- S2 storage: `infrastructure/modules/object-storage/s2/s2.tf`
- Dockerfile: `infrastructure/Dockerfile`
- OpenSpec spec: `openspec/specs/infrastructure/spec.md`

## §6 HTTP Response Headers

### Trust level

**Defense-in-depth layer.** Response headers do not authenticate or
authorise — §4 does. They reduce the blast radius of an upstream bug:
if an XSS or template-injection slips past input validation, the CSP
prevents remote-script execution and inline-handler triggers; HSTS
forces HTTPS even when an attacker tries to strip it; X-Frame-Options
blocks clickjacking; Referrer-Policy caps data leaking to third
parties; Permissions-Policy denies the page access to browser
capabilities it does not need.

### Entry points

- Every HTTP response served by `packages/runtime` passes through
  `secureHeadersMiddleware` (mounted first in `main.ts`).
- Headers are uniform across route families: `/livez`, `/webhooks/*`,
  `/api/*`, `/dashboard*`, `/trigger*`, `/static/*`.
- `/oauth2/*` responses are served by the oauth2-proxy sidecar and do
  not receive these headers. Accepted gap — same-origin, minimal
  scripting surface.

### Threats

| ID | Threat | Category |
|----|--------|----------|
| H1 | Remote-script injection runs arbitrary JS via `<script src="evil.com">` | Elevation of privilege |
| H2 | Inline-handler injection runs arbitrary JS via `onclick=`, `ontoggle=`, etc. | Elevation of privilege |
| H3 | Eval-based injection runs arbitrary JS via `eval()` or `new Function()` in a library | Elevation of privilege |
| H4 | Inline-style injection leaks data via `@import` or URL in a `style` attribute | Information disclosure |
| H5 | HTTPS stripped by an on-path attacker (public Wi-Fi, rogue DNS) | Confidentiality |
| H6 | Dashboard embedded in a hostile iframe for clickjacking | UI redressing |
| H7 | Cross-origin opener abuses `window.opener` to navigate our tab | Elevation of privilege |
| H8 | Our responses embedded cross-origin to exfiltrate or fingerprint | Information disclosure |
| H9 | Referer header leaks correlation IDs or event IDs to third parties | Information disclosure |
| H10 | Browser capability (clipboard read, geolocation, camera, USB, etc.) abused by injected script | Information disclosure / privacy |

### Mitigations (current)

- **Strict CSP.** `default-src 'none'`, plus explicit grants for
  `script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`,
  `connect-src 'self'`, `form-action 'self'`, `frame-ancestors 'none'`,
  `base-uri 'none'`. No `'unsafe-inline'`, `'unsafe-eval'`,
  `'unsafe-hashes'`, `'strict-dynamic'`, or remote origins. Mitigates
  H1–H4.
- **Alpine CSP build.** `@alpinejs/csp` replaces the standard build so
  Alpine's expression evaluator never reaches `new Function()`. All
  components are pre-registered via `Alpine.data(...)` in
  `packages/runtime/src/ui/static/dashboard-alpine.js`. Alpine `:style`
  bindings use object form exclusively (Alpine sets styles via
  `el.style.setProperty`; string form sets the inline `style`
  attribute and is blocked by `style-src 'self'`).
- **No inline handlers, scripts, or styles in rendered HTML.** All
  behaviour lives in `/static/*.js` files bound via `addEventListener`
  or `Alpine.data`. `html-invariants.test.ts` asserts this at build
  time across every HTML surface.
- **HSTS.** `Strict-Transport-Security: max-age=31536000;
  includeSubDomains` on every response in production. Gated off in
  local via `LOCAL_DEPLOYMENT=1` to prevent developer browsers from
  pinning HSTS on `localhost` (a self-signed kind cert would then
  cause unrecoverable `NET::ERR_CERT_AUTHORITY_INVALID` on any
  localhost service for a year).
- **X-Content-Type-Options: nosniff.** Prevents MIME sniffing.
- **X-Frame-Options: DENY** and **CSP `frame-ancestors 'none'`.** Two
  layers against clickjacking (H6).
- **Cross-Origin-Opener-Policy: same-origin.** No cross-origin window
  handle (H7). Safe because GitHub OAuth is redirect-based, not
  popup-based.
- **Cross-Origin-Resource-Policy: same-origin.** No other origin may
  embed our responses (H8).
- **Referrer-Policy: strict-origin-when-cross-origin.** Full URL
  same-origin; origin only on cross-origin HTTPS→HTTPS; nothing on
  downgrade. Protects IDs in query strings (H9).
- **Permissions-Policy.** Every browser capability locked to `()` —
  camera, microphone, geolocation, USB, MIDI, payment, clipboard-read,
  fullscreen, etc. — with `clipboard-write=(self)` the sole exception
  (needed for the copy-event button on the dashboard). Mitigates H10.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-H1 | `/oauth2/*` pages served by the sidecar do not carry our headers | Same-origin pages without our CSP | Accepted — minimal scripting surface, maintained upstream |
| R-H2 | No CSP `report-to` / `report-uri` + ingestion endpoint | Violations surface only in browser devtools | Accepted — add only if repeated regressions motivate it |
| R-H3 | Not on HSTS preload list | Browsers not pre-seeded with HTTPS-only must see one response first | Accepted — keeps a path to back out within a year |

### Rules for AI agents

1. **NEVER add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`,
   or `'strict-dynamic'` to the CSP.** These tokens defeat the
   protections in H1–H3.
2. **NEVER add a remote origin (`https:`, `http:`, a wildcard host, or
   a specific third-party domain) to any CSP directive.** If a library
   must be loaded, bundle it and serve from `/static`.
3. **NEVER add an inline `<script>` element with executable content,
   an inline event handler attribute (`onclick=`, `ontoggle=`,
   `onchange=`, `onload=`, `onsubmit=`, `onerror=`, `onfocus=`,
   `onblur=`, or any other `on*=` attribute), an inline `<style>`
   element, or an inline `style="..."` attribute to HTML served by
   the runtime.** All behaviour goes into a file under
   `/static/*.js`; all styling into `/static/*.css`.
4. **NEVER use a string-form Alpine `:style` binding.** Only object
   form is permitted (Alpine sets object-form styles via
   `el.style.setProperty`, which is CSP-safe; string form sets the
   inline `style` attribute and is blocked).
5. **NEVER add an `x-data` attribute with an inline object literal or
   method body.** Register the component via
   `Alpine.data('<name>', () => ({...}))` in
   `packages/runtime/src/ui/static/dashboard-alpine.js` and reference
   it by bare identifier: `x-data="myComponent"`.
6. **NEVER replace `@alpinejs/csp` with the standard `alpinejs` CDN
   build.** The standard build uses `new Function()` and requires
   `'unsafe-eval'` in CSP.
7. **NEVER remove the HSTS local gate (`LOCAL_DEPLOYMENT=1` check).**
   A developer who hits `https://localhost:8443` with a self-signed
   cert will have HSTS pinned for `localhost` (host-level, not
   port-level) for a year. Every other local dev service on
   `localhost` then fails with `NET::ERR_CERT_AUTHORITY_INVALID` and
   no "Proceed anyway" option.
8. **NEVER weaken `Permissions-Policy` to `*` or `self` without
   concrete justification.** Every feature currently locked to `()`
   stays `()` unless a new UI feature genuinely requires it, and the
   grant MUST be as narrow as possible (`(self)`, not `*`).

### File references

- Middleware: `packages/runtime/src/services/secure-headers.ts`
- Unit + integration tests:
  `packages/runtime/src/services/secure-headers.test.ts`
- HTML invariants test: `packages/runtime/src/ui/html-invariants.test.ts`
- Alpine component registrations:
  `packages/runtime/src/ui/static/dashboard-alpine.js`
- Local deployment gate:
  `infrastructure/modules/workflow-engine/modules/app/app.tf`
  (`local_deployment` variable), set to `true` in
  `infrastructure/local/local.tf`
- OpenSpec spec: `openspec/specs/http-security/spec.md`
