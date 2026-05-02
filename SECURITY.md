# Security Model

This document is the authoritative threat model for this workflow engine. It
is written **primarily for AI coding agents** to consult when adding or
modifying security-sensitive code. Human contributors are welcome readers,
but the prose is optimized for machine consumption: explicit rules, clear
trust boundaries, and enumerated threats per attack surface.

## How to use this document

Before writing or reviewing code that touches security-sensitive areas,
consult the relevant section:

- **Adding or modifying a sandbox plugin, a guest-visible global, or a
  host-bridged descriptor** → §2 Sandbox Boundary
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
                     │     Caddy Ingress    │  TLS termination
                     │      (HTTPS :443)    │  HTTP-01 ACME (LE)
                     └──────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
  /webhooks/*           /dashboard, /trigger        /api/*
  PUBLIC                App sessionMiddleware       App middleware:
  (intentional)         (in-app GitHub OAuth)       Bearer + AUTH_ALLOW
        │                       │                       │
        ▼                       ▼                       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                  Runtime (Node.js, Hono)                    │
  │                                                             │
  │   ┌──────────────┐    ┌──────────────┐   ┌──────────────┐   │
  │   │ Webhook      │    │ UI (dashboard│   │ API handlers │   │
  │   │ handlers     │    │  + trigger)  │   │              │   │
  │   └──────┬───────┘    └──────────────┘   └──────────────┘   │
  │          │ parse + validate payload (Zod)                   │
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
  │          │       ├─► __sdk.dispatchAction(name,  │          │
  │          │       │     in, handler)              │          │
  │          │       │   ├─► host-call-action plugin │          │
  │          │       │   │     validates input       │          │
  │          │       │   ├─► captured handler(input) │          │
  │          │       │   └─► host-call-action plugin │          │
  │          │       │       validateActionOutput    │          │
  │          │       │       (validated value back)  │          │
  │          │   └─► fetch(url, …) → fetch plugin    │          │
  │          │                       (hardenedFetch) │          │
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
| 1 | Sandbox | **UNTRUSTED** (user-authored trigger + action code) | `sandbox({source, plugins}).run(handlerName, payload)` | Isolation, not auth | §2 |
| 2 | Webhook ingress | **PUBLIC** (intentionally unauthenticated) | `POST /webhooks/<owner>/<workflow>/<trigger>` | None — payload-schema validation only | §3 |
| 3 | UI / API | **AUTHENTICATED** | `/dashboard`, `/trigger`, `/login`, `/auth/*`, `/api/*` | In-app OAuth (sealed session cookie) for UI; Bearer (GitHub) for API. Both gated by `AUTH_ALLOW`. `/login` is the provider-agnostic sign-in page; `/auth/github/*` is the GitHub-specific handshake. | §4 |
| 4 | Infrastructure | **INTERNAL** | K8s pods, Secrets, S3, Caddy ingress | K8s RBAC, pod network | §5 |

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

### Owner + Repo isolation invariants

**I-T2** — No caller (authenticated or not) SHALL read, modify, or execute
another (owner, repo)'s workflows or invocation events.

Enforcement is distributed across several mechanisms; each is
load-bearing and documented in its own section or capability spec. The
table below is the navigation map:

| Data path                                                        | Enforcement mechanism                                                                                                          | Documented in                      |
|------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|------------------------------------|
| `POST /api/workflows/:owner/:repo`                               | Owner + repo regex + `isMember(user, owner)` gate; identical 404                                                               | §4, threat A12                     |
| Invocation event reads                                           | `EventStore.query(scopes)` accepts a caller-supplied allow-list; callers route through `resolveQueryScopes(user, registry, …)` | `event-store/spec.md`              |
| Invocation event writes                                          | Runtime stamps `owner` + `repo` in its `sb.onEvent` receiver before forwarding to the bus (the sandbox has no identity)        | `executor/spec.md`, §2 R-2, R-8    |
| `POST /webhooks/:owner/:repo/:workflow/:trigger`                 | Registry lookup by `(owner, repo, workflow, trigger)` tuple                                                                    | §3, `http-trigger/spec.md`         |
| Workflow bundle storage                                          | Storage key = `workflows/<owner>/<repo>.tar.gz`                                                                                | `workflow-registry/spec.md`        |

The regex-validated owner + repo identifiers are NOT a permission check — they
are a format check. Every mechanism above is load-bearing; weakening any one
of them breaks I-T2. Threats that specifically target I-T2 are
enumerated in §4 (A12, A13, A14) alongside their mitigations.

The audit burden for the EventStore scoping shifted from "pre-bound by
implementation" (old single-owner `query(owner)`) to "caller-supplied from
an audited allow-set" — still safe, because every production call site is
routed through `resolveQueryScopes`, which only returns pairs that satisfy
`(owner ∈ user.orgs) ∧ ((owner, repo) ∈ registry.pairs())`. Any direct
construction of a `Scope` from request input (e.g. URL segments) is a
cross-owner-leak bug and forbidden by the R-A14 review checklist.
## §2 Sandbox Boundary

### Trust level

**UNTRUSTED.** All code inside `sandbox({source, plugins}).run(name, input)`
is user-authored trigger + action code. Treat it as hostile: it may attempt
to read host state, reach network services it shouldn't, run indefinitely,
or exfiltrate secrets through any channel available to it.

The sandbox is **the single strongest isolation boundary in the system**.
Most security decisions in this document reduce to: *does this expose new
capability across the sandbox boundary?*

**Engine:** the sandbox uses `quickjs-wasi` (QuickJS-ng compiled to
`wasm32-wasip1`), not `quickjs-emscripten`. Each `Sandbox` instance has its
own `QuickJS.create()` VM with its own dedicated WASM linear memory; there
is no runtime/context split. Standard Web APIs (`URL`,
`TextEncoder`/`TextDecoder`, `atob`/`btoa`, `structuredClone`, `Headers`,
WebCrypto) are provided by the engine's native WASM extensions, not by
host-side polyfills bundled into the workflow. Source is evaluated as an
IIFE script (not an ES module) because `quickjs-wasi`'s `evalCode` does not
expose the ES module namespace; the vite-plugin emits `format: "iife"`
with a fixed namespace name (`IIFE_NAMESPACE` exported from
`@workflow-engine/core`), and the sandbox reads exports from
`globalThis[IIFE_NAMESPACE]`.

### Architecture: plugins are the sole host-callable surface

The sandbox core is a pure mechanism: WASM hosting, event stamping
(`seq`/`ref`/`ts`/`at`/`id`), WASI routing, run lifecycle, and plugin
composition. It emits **zero** application events. Every host-callable
surface — fetch, timers, console, action dispatch, trigger lifecycle,
WASI telemetry — is installed by a `Plugin` passed to the factory.

A plugin contributes some combination of: guest-visible / private
`GuestFunctionDescription`s, polyfill source evaluated after plugins boot,
WASI hook overrides (clock, random, fd_write), and run-lifecycle hooks
(`onBeforeRunStarted`, `onRunFinished`). All plugin code executes worker-
side; plugin configs must be JSON-serializable.

**Plugin catalog (v1).** `web-platform` (polyfills: EventTarget, Streams,
URLPattern, CompressionStream, reportError, microtask, fetch WHATWG shape),
`fetch` (dispatcher closing over `hardenedFetch` by default), `timers`
(setTimeout/setInterval/clearTimeout/clearInterval + per-run cleanup),
`console` (`console.log`/`info`/`warn`/`error`/`debug` leaf events),
`wasi` (inert by default; runtime supplies telemetry setup), `host-call-
action` (Zod input validation, exports `validateAction` to dependents),
`sdk-support` (installs locked `__sdk.dispatchAction`; depends on
`host-call-action`), `trigger` (emits `trigger.request`/`response`/`error`
around every run). Test-only: `wpt-harness` (`__wptReport` private
descriptor).

### Entry points

- `sandbox({source, plugins, filename?, memoryLimit?, interruptHandler?})`
  — spawns a dedicated Node `worker_threads` Worker that constructs the
  QuickJS WASM context and boots plugins. The main thread holds only a
  thin Sandbox proxy that routes `run` / `dispose` / `onDied` / `onEvent`
  to the worker.
- `createSandboxFactory({ logger })` — construction primitive for
  `Sandbox` instances. Every `create({source, plugins}, options?)` call
  spawns a new worker. Owner-scoped sandbox reuse is owned by
  `SandboxStore` (`packages/runtime/src/sandbox-store.ts`), keyed by
  `(owner, workflow.sha)`.
- `Sandbox.run(name, input)` — invokes a named export from the workflow
  module. Runtime metadata (owner/workflow/workflowSha/invocationId) is
  NOT passed into `run` — the runtime stamps those fields on events in
  its `sb.onEvent` receiver after the sandbox emits them (see R-2 below).
- `Sandbox.onEvent(cb)` — registers a callback invoked for each
  `InvocationEvent` the worker streams. Events carry only intrinsic
  fields (`id`, `seq`, `ref`, `ts`, `at`, `kind`, `name`, `input?`,
  `output?`, `error?`). Downstream consumers see identical shape to
  pre-plugin-architecture events because the runtime stamps metadata
  post-hoc.

### Boot sequence

Every `create()` runs deterministically through the phases below
(matching `packages/sandbox/src/worker.ts:245-263`):

- **Phase 0** — module load. `worker.ts` imports are processed at module
  evaluation time; plugin descriptor modules resolve in Phase 1a.
- **Phase 1** — WASM instantiation (`QuickJS.create`). Bridge + RPC
  setup, polyfill bundle eval, stack-size cap applied via the wasm
  export `qjs_set_max_stack_size`.
- **Phase 1a** — `plugin.worker(ctx, deps, config)` for each plugin
  descriptor in topological order. Each plugin's `workerSource` is
  dynamic-imported from a `data:` URI. Returns a `PluginSetup`
  (exports, guestFunctions, wasiHooks, lifecycle hooks).
- **Phase 1b** — install WASI hooks collected during Phase 1a.
  `installWasiHooks` enforces hook-slot collision (one plugin per slot).
- **Phase 1c** — install each plugin's guest-function descriptors on
  `globalThis` so Phase 2 plugin source eval can capture private
  descriptors into closures (`const x = globalThis.__x; delete
  globalThis.__x;`).
- **Phase 2** — plugin source eval (each plugin's `guestSource` IIFE,
  in topological order). The IIFE captures private descriptors and
  installs guest-facing globals (e.g. `globalThis.fetch`,
  `globalThis.console`).
- **Phase 3** — private-binding auto-deletion. The sandbox iterates
  every registered `GuestFunctionDescription` and `delete
  globalThis[name]` for every entry with `public !== true`. Structural
  enforcement, not review discipline.
- **Phase 4** — user source evaluation (the workflow bundle IIFE,
  which writes to `globalThis.__wfe_exports__`).

Immediately after Phase 4, the sandbox calls `vm.snapshot()` and every
subsequent `handleRun` restores from this snapshot — so the
post-Phase-4 globals surface is what every run starts from.

Failures in any phase dispose the bridge, post `init-error`, and
`process.exit(0)`.

### Globals surface (post-init guest-visible)

The surface below is contributed by the v1 plugin catalog AND by the
workflow IIFE bundle. Adding a new global requires adding or extending
a plugin (or the bundle) AND extending the list here AND extending the
inline const arrays in `packages/runtime/src/globals-surface.test.ts`.
See R-14 below — the enumeration test fails on additions or removals.

- From `web-platform`: `self` (identity shim with EventTarget),
  `navigator` (frozen `{userAgent}`), `reportError`, `EventTarget`,
  `Event`, `ErrorEvent`, `CustomEvent`, `addEventListener`,
  `removeEventListener`, `dispatchEvent` (top-level proxies that mirror
  `self`'s EventTarget methods), `AbortController`, `AbortSignal`,
  `URLPattern`, `CompressionStream`, `DecompressionStream`, `scheduler`,
  `TaskController`, `TaskPriorityChangeEvent`, `Observable`,
  `Subscriber`, `EventTarget.prototype.when`, the WHATWG Streams family
  (`ReadableStream` + 4 Reader/Controller variants, `WritableStream` +
  2 Controller/Writer variants, `TransformStream` + Controller,
  `ByteLengthQueuingStrategy`, `CountQueuingStrategy`,
  `TextDecoderStream`, `TextEncoderStream`), IndexedDB family
  (`indexedDB`, `IDBCursor`, `IDBCursorWithValue`, `IDBDatabase`,
  `IDBFactory`, `IDBIndex`, `IDBKeyRange`, `IDBObjectStore`,
  `IDBOpenDBRequest`, `IDBRequest`, `IDBTransaction`,
  `IDBVersionChangeEvent`), User Timing Level 3 entries
  (`PerformanceEntry`, `PerformanceMark`, `PerformanceMeasure`),
  `structuredClone` override, `URL.prototype.searchParams` accessor
  (live two-way bound URLSearchParams; patches the WASM-ext URL
  constructor via a construct-trap Proxy), and the fetch interfaces
  (`Blob`, `File`, `FormData`, `Request`, `Response`).
  Pinned polyfills: `event-target-shim@^6`, `urlpattern-polyfill@10.0.0`,
  `fflate@^0.8.2`, `web-streams-polyfill@^4.2.0`, `fetch-blob@^4.0.0`,
  `formdata-polyfill@^4.0.10`, `@ungap/structured-clone@^1.3.0`,
  `fake-indexeddb@^6.2.5`, `scheduler-polyfill@^1.3.0`,
  `observable-polyfill@^0.0.29`. Version bumps require a §2 re-audit PR.
- **core-js conformance surface** (`core-js@^3`, targeted modules
  only): pure-JS, feature-detected ES gap fillers — Iterator helpers
  (`Iterator.from` + `Iterator.prototype.{map,filter,take,drop,reduce,
  toArray,forEach,some,every,find,flatMap}`), new Set methods
  (`intersection`, `union`, `difference`, `symmetricDifference`,
  `isSubsetOf`, `isSupersetOf`, `isDisjointFrom`),
  `Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`,
  `Array.fromAsync`, and `ArrayBuffer.prototype.transfer` /
  `transferToFixedLength` / `resize`. core-js also installs
  `__core-js_shared__` on `globalThis` as its private cross-module
  shared store (its public surface is the prototype methods above; the
  shared store is incidental but enumerable, so it is part of the
  globals surface). The aggregate `core-js/stable` is intentionally
  **not** imported: it would replace the more
  conformant WASM-ext `URL` / `URLSearchParams` / `DOMException` and
  the existing `urlpattern-polyfill` / `@ungap/structured-clone` /
  `event-target.ts` shims with less-conformant pure-JS variants
  (regresses ~98 WPT subtests, including surrogate handling). No host
  bridges, no Node surface; lives entirely in linear memory. Version
  bump requires a §2 re-audit PR.
- From `console`: `console` (object with `log`/`info`/`warn`/`error`/
  `debug` leaf-event emitters via the console plugin's `$console/*`
  private descriptors).
- From `fetch`: `globalThis.fetch` (WHATWG shape around the private
  dispatcher `$fetch/do`). Default implementation closes over
  `hardenedFetch` (see R-4 below).
- From `timers`: `setTimeout`, `setInterval`, `clearTimeout`,
  `clearInterval`.
- From `sdk-support`: `__sdk` — locked via
  `Object.defineProperty(globalThis, "__sdk", {writable: false,
  configurable: false})` wrapping an `Object.freeze`d inner
  `{dispatchAction}` object. The underlying `__sdkDispatchAction`
  private descriptor is captured by the plugin's IIFE and auto-deleted
  in phase 3.
- **From system-bridge plugins** (locked outer + frozen inner — see
  "Adding a system-bridge plugin" below for the canonical pattern):
  - From `sql` (sandbox-stdlib): `__sql` — locked outer, frozen inner
    `{execute}`. Backed by the private `$sql/do` descriptor captured
    by the plugin's IIFE and phase-3-deleted.
  - From `mail` (sandbox-stdlib): `__mail` — locked outer, frozen
    inner `{send}`. Backed by the private `$mail/send` descriptor
    captured by the plugin's IIFE and phase-3-deleted.
- From `secrets` (runtime/plugins/secrets.ts):
  - `workflow` — locked outer, frozen inner `{name, env}` (env values
    are strings, frozen shallowly). Populated by the plugin's Phase-2
    IIFE from the runtime-supplied `__secretsConfig` private
    descriptor. Author-facing access is via the SDK's
    `defineWorkflow({env}).env(...)` callable, but the binding is
    reachable directly on `globalThis`.
  - `$secrets` — locked outer, frozen inner `{addSecret(value)}`. The
    inner is a closure over the private `$secrets/addSecret`
    descriptor (phase-3-deleted), wired to the runtime's secret
    scrubber so any plaintext computed inside a handler is redacted
    from emitted events.
- **From the workflow IIFE bundle** (Phase 4): `__wfe_exports__` — the
  fixed namespace constant exported as `IIFE_NAMESPACE` from
  `@workflow-engine/core/constants`. The vite-plugin emits the
  workflow as `format: "iife"` assigning exports onto
  `globalThis.__wfe_exports__`; the sandbox reads handler exports from
  this object via `vm.global.getProp(IIFE_NAMESPACE)`. The descriptor
  is currently **writable** and **configurable** (the IIFE writes via
  ordinary property assignment, and no plugin locks it). Tracked as a
  separate finding (sister F-4) for descriptor locking; until then,
  guests CAN mutate `__wfe_exports__` between handler invocations,
  but exports are read once per run by the host so the practical
  blast radius is bounded to the same run (see threat S15 below).
- **WASM extension globals** (contributed by quickjs-wasi extensions
  loaded at VM creation): `URL`, `URLSearchParams`, `TextEncoder`,
  `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`
  (including `crypto.subtle.*` with a JS Promise shim, plus the
  `Crypto`, `CryptoKey`, `SubtleCrypto` constructor identities),
  `performance`, `DOMException`, `queueMicrotask`. These live inside
  WASM linear memory; they are not host bridges and consume no host
  capability.

No other globals are present. `process`, `require`, `fs`, and Node APIs
are absent. The exact post-init globals delta over the engine + ES
baseline is enforced by `packages/runtime/src/globals-surface.test.ts`
(see R-14).

### WASI override inventory

The `wasi` plugin owns WASI override dispatch. In production the runtime
passes a telemetry setup that emits `wasi.clock_time_get`,
`wasi.random_get`, and `wasi.fd_write` leaf events. Without a setup
function the plugin is inert — WASI calls compute real values, no events
emitted.

- **`clock_time_get`** — drives `Date.now()`, `new Date()`,
  `performance.now()`, and the one-time seed of QuickJS's xorshift64\*
  PRNG. `CLOCK_REALTIME` passes through to host `Date.now() × 1e6` ns.
  `CLOCK_MONOTONIC` returns `(performance.now() × 1e6) − anchorNs`.
- **`random_get`** — drives `crypto.getRandomValues`, `crypto.randomUUID`,
  and internal entropy reads made by the WASM crypto extension. The
  telemetry setup emits a `wasi.random_get` leaf carrying only
  `{bufLen, sha256First16}` (first 16 bytes of the SHA-256 digest, hex).
  **The raw entropy bytes MUST NEVER appear in any emitted event or
  log** — only size and this bounded fingerprint.
- **`fd_write`** — receives bytes QuickJS engine-internal paths write to
  stdout/stderr (rare; mostly mbedTLS notices and engine panic paths).
  Guest `console.log` does NOT reach `fd_write`; it flows through the
  console plugin's descriptor. The telemetry setup emits `wasi.fd_write`
  with `{fd, text}`. **`fd_write` bytes never become owner-visible
  `console.*` events** — engine plumbing belongs in the operational log.

**Residual observability gap.** Operations inside the WASM crypto
extension (`crypto.subtle.digest`, `generateKey`, `encrypt`, etc.) run
entirely inside the extension's WASM memory without crossing an
instrumented boundary. Entropy consumption is observable via
`wasi.random_get`; the higher-level operation is not. Closing that gap
would require separate instrumentation at the crypto extension ABI layer
and is out of scope.

### Event emission model

Every event is stamped with `id/seq/ref/ts/at/kind/name/input?/output?/error?`
by the sandbox on the worker thread (single-authority counter). The
sandbox does NOT know owner/workflow/workflowSha/invocationId; those
are labels the runtime attaches post-hoc in its `sb.onEvent` receiver
(see R-2, R-8). `seq` is monotonic per run; `ref` forms the parent-
frame stack (`createsFrame` pushes after emit; `closesFrame` emits with
current top then pops). Plugin code never reads or writes these fields
directly — only `ctx.emit(kind, name, extra, options?)` and
`ctx.request(prefix, name, extra, fn)`.

### Threats

| ID | Threat | Category |
|----|--------|----------|
| S1 | Plugin or user code escapes sandbox by reflecting a host-object reference, forging promise resolution, or re-entering host code | Elevation of privilege |
| S2 | User code consumes unbounded memory in the WASM heap, starving the host | DoS |
| S3 | User code runs an infinite loop, blocking the host event loop on the `vm.evalCode` call | DoS |
| S4 | User code schedules infinite timers to keep the host pumping jobs | DoS |
| S5 | User code uses `fetch()` to reach internal K8s services, cloud metadata endpoints, or private network ranges (SSRF) | Information disclosure / EoP |
| S6 | User code reads secrets via `workflow.env` that were declared by another workflow | Information disclosure |
| S7 | User code exfiltrates trigger payload data or secrets by returning them from the trigger handler (visible in HTTP response + archive record) or by passing them as action input (audit-logged + written to archive on failure) | Information disclosure |
| S8 | User code generates cryptographic material and exports it through the handler return value or an outbound `fetch()` | Information disclosure |
| S9 | A new plugin is added that accepts a raw host-object reference or leaks one back to the guest, allowing reflection / mutation of host state | Elevation of privilege |
| S10 | Guest code calls a validated host function with a payload that triggers prototype pollution on the host (`__proto__`, `constructor.prototype`) | Tampering / EoP |
| S11 | Guest code calls the locked `__sdk.dispatchAction` with `(validActionName, realInput, fakeHandler, fakeCompleter)` to emit `action.*` audit events that misrepresent which handler actually ran | Tampering (audit-log integrity) |
| S12 | A private descriptor fails to auto-delete in phase 3 (descriptor marked `public: true` by mistake, or phase-3 iteration is skipped) and becomes reachable from guest code | Elevation of privilege (audit-log forging / bridge access) |
| S13 | A plugin retains worker-side long-lived state (timers Map, pending `Callable`s, in-flight fetch handles) that is not captured by the per-run VM snapshot+restore — failing to clean up on `onRunFinished` leaks state across runs or fires callbacks after the run closed. Guest-visible state is structurally reset by snapshot-restore; S13 now covers only the host-side residue. | Tampering (cross-run state) / DoS |
| S14 | A plugin emits events with hand-crafted `seq`/`ref`/`ts` values (via direct `bridge.*` mutation) that desync the event stream | Tampering (audit-log integrity) |
| S15 | Guest code mutates a locked guest-visible global (`__sdk`, `__sql`, `__mail`, `$secrets`, `workflow`) to swap a dispatcher, alter a frozen view, or replace exports between runs. Mitigation: locked-outer + frozen-inner descriptor pattern uniformly applied at install time (parallels S11 for `__sdk`). For the lone unlocked surface `__wfe_exports__`, guests CAN rewrite it today; impact is bounded to the same run because the host reads exports once per `run()` (sister finding F-4 tracks descriptor locking). | Tampering (audit-log integrity / surface integrity) |

### Mitigations (current)

- **Fresh VM per workflow module load, fresh guest state per run.**
  `QuickJS.create()` is called once when the workflow registry first
  instantiates a workflow. At end of init the worker takes one
  `vm.snapshot()`; after each `run()` completes, the VM is disposed and
  restored from that snapshot asynchronously, off the critical path. The
  next `run()` awaits any in-flight restore. Guest-visible state
  (`globalThis` writes, module-level `let`/`const` mutations, closures
  over mutable module state) therefore SHALL NOT persist across runs.
  Worker-side plugin state on `PluginSetup` (timers Map, rehydrated Zod
  validators, etc.) is NOT in the snapshot and persists for the
  sandbox's lifetime; plugins remain responsible for per-run cleanup
  via R-4. Cross-workflow leakage remains physically impossible:
  separate VMs, separate WASM memory, separate env records.
  (`packages/sandbox/src/worker.ts`, `packages/runtime/src/sandbox-store.ts`)
- **Private-by-default descriptors (S12).** Every
  `GuestFunctionDescription` defaults to `public: false`. After phase-2
  source evaluation, the sandbox iterates registered descriptors and
  `delete globalThis[name]` for every entry with `public !== true`.
  Reviewers grep for `public: true` to audit what remains guest-visible.
  Currently only the web-platform / fetch / timers / console user-facing
  surfaces + `__sdk` pass the filter.
- **Locked `__sdk` (S11 bounded, S12 structural).** `sdk-support` installs
  `__sdk` via `Object.defineProperty({writable: false, configurable:
  false})` wrapping a frozen inner `{dispatchAction}`. Guest code cannot
  replace the dispatcher with a stub, cannot delete the binding, cannot
  reassign `__sdk.dispatchAction`. S11 (guest calls real dispatcher with
  fake handler) remains an accepted audit-log residual (R-10).
- **Structural hardened fetch (S5).** `createFetchPlugin` closes over
  `hardenedFetch` as its default. Production composition does not pass an
  override; tests replace the entire plugin via `__pluginLoaderOverride`.
  `hardenedFetch` enforces: scheme allowlist (http, https, data; `data:`
  short-circuits), `dns.lookup(host, {all: true})` with IPv4-mapped-IPv6
  unwrap, IANA special-use blocklist (loopback, RFC1918, CGNAT, link-
  local, TEST-NET, benchmark, 6to4, multicast, reserved, ULA), fail-
  closed if any resolved address is blocked, connect to validated IP
  directly with SNI preserved, manual redirect follow re-running the
  full pipeline on every hop, 5-hop cap, `Authorization` stripped on
  cross-origin redirects, 30s total-wall-clock timeout. On a block the
  main-thread handler logs `sandbox.fetch.blocked` and returns a generic
  `TypeError("fetch failed")` to the guest.
- **Per-run cleanup (S13).** Plugins with long-lived state MUST
  implement `onRunFinished`. The `timers` plugin iterates live timers at
  run end and routes each through the same clear path as guest-initiated
  `clearTimeout`, emitting `timer.clear` leaves. The `fetch` plugin's
  per-run `AbortController` aborts in-flight requests. The `sql` plugin
  (`createSqlPlugin`) calls `sql.end({timeout:5})` in a `finally` block
  around every query so the per-call connection is closed on both
  success and failure; `onRunFinished` is a backstop that forces
  `sql.end({timeout:0})` on any handle whose `finally` path failed to
  complete. Cleanup runs inside the run's refStack frame so audit events
  parent correctly.
- **ctx-only emission (S14).** All events flow through `ctx.emit` /
  `ctx.request`. `ts`/`at`/`kind`/`name`/`callId` are bridge-stamped
  (worker-side); `seq`/`ref` are Sandbox-stamped (main-side, by the
  `RunSequencer` per the `bridge-main-sequencing` change); `id`/`owner`/
  `repo`/`workflow`/`workflowSha`/`invocationId`/`meta.dispatch` are
  runtime-stamped (in the executor's `sb.onEvent` widener). No layer
  may stamp fields that belong to another layer; in particular plugin
  code MUST NOT touch `seq`/`ref`/`callId` and the worker MUST NOT
  parse the `kind` string for framing — the typed `type` field on
  `WireEvent` is the framing discriminator.
- **Reserved event prefixes.** `trigger`, `action`, `system` are
  reserved for stdlib / runtime plugins. Third-party plugins use
  domain-specific prefixes to avoid conflating with core audit
  categories. Per the `bridge-main-sequencing` change, the previously
  separate `fetch`, `mail`, `sql`, `timer`, `console`, `wasi`, and
  `uncaught-error` prefixes were consolidated under `system.*` with
  the operation identity carried in the event's `name` field
  (e.g. `system.request name="fetch"`, `system.call name="setTimeout"`,
  `system.exception name="TypeError"`).
- **SQL event param-value redaction.** SQL `system.request` events
  (with `name="executeSql"`) MAY carry the full `query` text (authors
  see it in the dashboard for debugging) but MUST NOT carry any param
  *values*. The `createSqlPlugin` descriptor's `logInput` emits
  `{engine, host, database, query, paramCount}` — `paramCount` is the
  length of the params array; the values themselves never appear in
  any SQL `system.request`, `system.response`, or `system.error`
  event payload (filtered by `name="executeSql"`).
  This matches the `mail` plugin's "log envelope, not body" discipline:
  param values are the most common carrier of PII / PHI / tokens flowing
  through SQL calls, and the event stream is operator-visible.
- **Worker-only plugin execution.** Plugin code runs in the Node worker
  thread exclusively. No cross-thread method calls. Plugin configs are
  validated JSON-serializable (`assertSerializableConfig`) at sandbox
  construction. This closes a whole class of thread-crossing bugs
  (closure capture, proxy marshaling) that prior method-RPC designs
  allowed.
- **No Node.js surface.** QuickJS WASM has no built-in Node.js APIs. Only
  plugin-installed globals plus WASM-extension globals are present.
- **JSON-only host/sandbox boundary.** `GuestFunctionDescription` args/
  results use a fixed vocabulary (`string`, `number`, `boolean`,
  `object`, `array`, `callable`, `raw`, `void`); host object references,
  closures, and proxies cannot cross directly. The sole exception is
  `callable` (first-class QuickJS function handle with explicit
  `.dispose()`) — invocable multiple times, surfaces guest throws as
  host `Error`, and throws `CallableDisposedError` on post-dispose use.
- **Per-workflow env scoping.** `workflow.env` exposes only the keys
  declared in that workflow's `defineWorkflow({env})`. Other workflows'
  env vars are unreachable — each workflow has its own sandbox + own
  env record (mitigates S6 structurally).
- **Action input validation via `host-call-action`.** Zod validators are
  rehydrated per action from the manifest's JSON Schema (via
  `z.fromJSONSchema`) at plugin boot. The plugin exports
  `validateAction(name, input)`; `sdk-support` calls it inside
  `__sdk.dispatchAction` before invoking the handler. Validation
  failures throw back into the guest with a structured `issues` array
  preserved. Input validation is host-authoritative.
- **Action output validation host-side via `host-call-action`.** The
  plugin also exports `validateActionOutput(name, raw)`, rehydrated from
  the manifest's output schema at plugin boot. `sdk-support`'s
  dispatcher handler invokes it after `await handler(input)` resolves,
  on the host side, before returning to the guest caller. The
  `__sdk.dispatchAction` bridge takes three positional args (`name,
  input, handler`) — there is no guest-supplied `completer`, so a
  tampered SDK cannot substitute a lenient output validator. Output
  validation is host-authoritative, parallel to input validation.
- **Trigger handler output validation host-side in `buildFire`.** After
  `executor.invoke` resolves with `{ok:true, output}`, `buildFire` runs
  the rehydrated Zod schema against `descriptor.outputSchema`. Mismatches
  surface as `{ok:false, error:{message:"output validation: …"}}` with
  no `issues` field — the HTTP source maps `no-issues → 500` (handler
  bug, not client fault). Structured per-field issues are logged via
  `trigger.output-validation-failed` for dashboards/archives.
- **Validator-source eval removed.** Prior versions used Ajv's
  `standaloneCode` to emit per-action validator source strings, which
  the worker plugin instantiated via `new Function(source)`. After the
  Zod migration, validators are constructed via `z.fromJSONSchema()`
  directly — no string-form validator code is generated, transferred,
  or `new Function()`-evaluated in the worker. Defence in depth, not a
  load-bearing boundary (the worker is trusted), but one fewer
  `new Function` site to reason about.
- **Worker-thread isolation of plugin runtime.** QuickJS, plugin code,
  `hardenedFetch`, and Zod validators all run inside a dedicated
  `worker_threads` Worker. Long synchronous guest CPU work (S3) does not
  freeze the main event loop — trigger ingestion and the operator UI
  stay responsive. Unexpected worker termination is surfaced as
  `Sandbox.onDied`; the factory evicts and respawns on next `create()`.
- **Cancel-on-run-end.** When a guest's exported function resolves (or
  throws), the run lifecycle's `onRunFinished` hooks run in reverse topo
  order, clearing timers and aborting in-flight fetches. Un-awaited
  background work does not outlive the run.
- **Per-workflow runQueue serialization.** The executor serializes one
  trigger invocation at a time per workflow (cross-workflow invocations
  remain parallel). Combined with per-run cleanup, module-state race
  conditions across invocations are eliminated.

### Residual risks

These are **known gaps**. AI agents must not assume protection where none
exists.

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-S1 | `SandboxOptions.memoryLimit` wires through to `QuickJS.create({ memoryLimit })` — callers that omit it fall back to WASM defaults | S2 opt-in | Caller-controlled (runtime does not set a default yet) |
| R-S2 | WASI `interruptHandler` is supported by the engine, but the current worker protocol cannot serialize functions across `postMessage`, so there is no wired-in timeout. | S3 unmitigated | **Follow-up** (engine supports it; wire-up is pending) |
| R-S3 | Host timers run on the Node event loop with no per-spawn cap; per-run cleanup mitigates cross-run leakage but an active run can still register arbitrarily many pending callbacks | S4 partial | v1 limitation |
| R-S4 | Every outbound-TCP plugin in `sandbox-stdlib` MUST route host resolution through the shared `net-guard` primitive (`assertHostIsPublic` in `packages/sandbox-stdlib/src/net-guard/`) so the IANA special-use blocklist is applied identically across plugins. Current consumers: the `fetch` plugin (via `hardenedFetch` — closed over in `createFetchPlugin` as the structural production default; override requires replacing the entire plugin via `__pluginLoaderOverride`, a test-only path), the `mail` plugin (`assertHostIsPublic(smtp.host)` called before constructing the nodemailer transport, with `host: <validatedIP>` + `tls.servername: <originalHost>` to close the TOCTOU window), and the `sql` plugin (`createSqlPlugin`: `assertHostIsPublic(host)` called before the porsager/postgres `socket` factory hands the driver a socket connected to the validated IP, with `ssl.servername: <originalHost>` pinned for SNI + cert verification; the driver never re-resolves DNS after the socket is handed over). Any future outbound-TCP plugin MUST adopt the same primitive. Note: `createSqlPlugin` invokes the driver via `sql.unsafe(query, params)` — the `unsafe` method name is porsager/postgres's label for the raw-string API; with `$N` placeholders and a non-empty `params` array it routes through Postgres's extended protocol and is parameterized / injection-safe. Empty `params` uses the simple-query protocol (multi-statement allowed, no binding). The plugin does not expose tagged-template authoring. **Test seam:** `assertHostIsPublic` honours `WFE_TEST_DISABLE_SSRF_PROTECTION=true` to skip the resolved-IP blocklist (DNS lookup, zone-id rejection, and "no addresses" failure are preserved). The flag is read on every call so a single spawned runtime can enable it via its child env without affecting siblings. Used by the e2e test framework (`packages/tests`) to let a spawned runtime deliver to in-process loopback mocks (SMTP / Postgres / HTTP echo). The flag MUST NEVER be set in production composition, in `pnpm dev`, or in any CI job other than `pnpm test:e2e`; the loopback-rejection invariant is independently re-asserted by e2e test #17 (SSRF guard), which runs in a sibling describe with the flag unset. Precedent for environment-gated test seams: `WFE_TEST_SANDBOX_RESTORE_FAIL` in `packages/sandbox/src/worker.ts`. | S5 closed | **Resolved** |
| R-S5 | K8s `NetworkPolicy` on the runtime pod restricts cross-pod traffic and blocks RFC1918 + link-local egress. Defence-in-depth under R-S4. | S5 defence-in-depth | **Resolved** (see §5 R-I1 / R-I9) |
| R-S12 | **No public-URL allowlist.** Guest code can still `fetch()` any public URL the pod can reach. This mitigates S5 (internal SSRF) but leaves S8 (exfiltration to attacker-controlled public endpoint) unaddressed. Closing S8 requires a per-owner host allowlist in the owner manifest, enforced at upload-time + in `hardenedFetch`. | S8 deferred | **Deferred** (separate change) |
| R-S6 | Workflow `env` is resolved at load time from `process.env` and shipped into the sandbox as JSON; any secret a handler returns, echoes into an action input, or logs will appear in the archive / pino logs | S7 partial | Behavioural; author responsibility |
| R-S7 | **Resolved.** CryptoKey objects live in WASM linear memory (PSA key handles managed by the crypto extension) and are freed with the VM. | — | **Resolved** |
| R-S8 | `crypto.subtle.exportKey("jwk", ...)` is not supported by the WASM crypto extension (raw / pkcs8 / spki are). | Feature gap | v1 limitation (engine-level) |
| R-S9 | WASI clock / random overrides (for deterministic replay) cannot be sent across the worker `postMessage` boundary as functions. The `wasi` plugin's setup function pattern enables replay via a descriptor-based path, but no replay plugin ships in v1. | Replay infrastructure | **Follow-up** |
| R-S10 | `__sdk.dispatchAction` is reachable on `globalThis` after init so the SDK's `action()` callable can find it. The binding is locked and the inner object is frozen, so guest code cannot replace the dispatcher. It CAN still be *called* directly with `(validActionName, realInput, fakeHandler, fakeCompleter)` — emitting `action.*` events that pass host-side input validation while a fake handler actually runs. Poisons the audit log; input validation remains authoritative; sandbox isolation is not breached. | S11 accepted | **Accepted** (fix would require moving dispatcher reachability off `globalThis`, e.g. via a core-package `setDispatcher` indirection) |
| R-S13 | Plugin discipline ("don't leak a private descriptor via `public: true`, don't bypass `ctx.emit`, don't forget `onRunFinished` cleanup") is partially structural and partially review-enforced. Phase-3 auto-deletion + descriptor-level `public: false` default + `ctx`-only emission close the common cases; per-plugin review remains load-bearing for the small catalog. | S9, S12, S13, S14 partial | Accepted (structurally bounded; reviewer-enforced for the plugin catalog) |

### Rules for AI agents

The invariants below collapse the pre-plugin-architecture per-shim rules
into 8 plugin-discipline rules. Each applies to every new or modified
plugin, and every change that adds a guest-visible surface.

1. **R-1 Private by default.** `GuestFunctionDescription.public` defaults
   to `false`. Phase 3 auto-deletes every non-public descriptor from
   `globalThis` after phase-2 source eval. A new descriptor is guest-
   visible only if the author writes `public: true` explicitly. Any such
   addition MUST extend the "Globals surface" list above in the same PR,
   with a written rationale and threat assessment.
2. **R-2 Locked internals.** Any `globalThis` binding installed for
   guest access MUST be
   `Object.defineProperty({writable: false, configurable: false})`
   wrapping an `Object.freeze`d inner object. Canonical examples: `__sdk`
   (action dispatcher) and `__mail` (SMTP dispatcher).
   Rationale: owner code cannot replace the dispatcher with a stub that
   bypasses `action.*` / `mail.*` emission. Adding a new top-level
   host-callable global without this structural lock is forbidden.
3. **R-3 Hardened fetch default.** `createFetchPlugin` closes over
   `hardenedFetch` as the structural production default (scheme
   allowlist + IANA blocklist + DNS validation + redirect re-check +
   30 s timeout). Overriding requires replacing the entire plugin via
   `__pluginLoaderOverride` — a test-only path. Production composition
   MUST NOT pass a fetch override; tests that need a mock replace the
   plugin, not its default.
4. **R-4 Per-run cleanup.** Plugins that allocate **per-call host
   resources** (a `Transport` per `sendMail`, a `postgres()` handle per
   `executeSql`, a per-call `AbortController` per `fetch`, a pending
   timer registered via `setTimeout`, a queued `Callable`, etc.) MUST
   implement `onRunFinished` to release that state at run end. Stdlib
   plugins SHOULD route per-call tracking through
   `createRunScopedHandles` (`packages/sandbox-stdlib/src/internal/run-scoped-handles.ts`)
   so the same closer drains both the per-call `finally` and the
   run-end backstop with delete-before-close ordering and swallowed
   closer errors.

   **Per-call vs pool-shared.** Resources that live in a process-wide
   pool (e.g. undici's cached `Agent` for fetch) are governed by their
   pool, not the run, and MUST NOT be drained on `onRunFinished` —
   tearing down the pool would leak state across plugin instances and
   defeat connection reuse. Plugins MAY track and abort per-call
   *tickets* (AbortControllers, in-flight request handles) against
   such pools without touching the pool itself.

   **Audit safety is independent of the backstop.** The worker-side
   `bridge.clearRunActive()` gate (`packages/sandbox/src/worker.ts`)
   silently suppresses any host-callback emission that arrives after
   `onRunFinished` returns, and the main-thread `RunSequencer.finish()`
   synthesizes close frames for any dangling open frames using the
   current run's stamping. Late real events therefore never reach the
   executor's `sb.onEvent` widener — they cannot be mis-tagged onto a
   later run's `invocationId`. The backstop's job is **resource-lifetime
   determinism and worker-time fairness** (in-flight I/O from run N
   does not consume run N+1's worker-thread budget), not audit
   correctness.

   Cleanup that DOES route through guest-equivalent emission paths (the
   `timers` plugin's `clearTimeout` audit event per still-live timer) is
   preserved by this refinement; it is one specific contract on top of
   R-4, not the rule itself.

   Skipping R-4 leaks state across runs (sockets/handles persist past
   the QuickJS snapshot-restore boundary because the Node worker thread
   is not snapshot-managed) and starves the next run of worker time.

   **Pairs with R-13 at the rejection boundary.** R-4 governs the
   disposal protocol that runs WHEN a run finishes; R-13 governs the
   `Callable` rejection contract that prevents a guest throw from
   PREMATURELY ending the worker before R-4 can run.
5. **R-5 ctx-only emission.** All events flow through `ctx.emit` /
   `ctx.request`. Direct `bridge.*` mutation from plugin code is
   prohibited. `seq`, `ref`, `ts`, `at`, and `callId` are stamped by
   the sandbox; plugin authors never construct these fields. A plugin
   that needs a frame-producing event passes `type: "open"` on
   `ctx.emit` (capturing the returned `CallId`) and a matching
   `type: { close: callId }` on the close — it never computes a ref
   value itself, and the worker→main wire pipeline never parses the
   `kind` string for framing.
6. **R-6 Worker-only execution.** Plugin code executes in the Node
   worker thread exclusively. No cross-thread method calls. Plugin
   configs passed to `descriptor.config` MUST be JSON-serializable
   (verified by `assertSerializableConfig` at sandbox construction).
   Main-thread state (connection pools, persistent caches) cannot live
   in a plugin — it must be passed in as serialized config or reached
   via a descriptor-bridged guest function that the plugin registers.
7. **R-7 Reserved prefixes.** Event prefixes `trigger`, `action`, and
   `system` are reserved for stdlib / runtime plugins. Third-party
   plugins use domain-specific prefixes (e.g. `mypkg.request` /
   `mypkg.response`) to avoid conflating with core audit categories.
   Per the `bridge-main-sequencing` change, host-call kinds previously
   under `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*`,
   and `uncaught-error` are consolidated under `system.*` with the
   operation identity carried in the event's `name` field.

   The `trigger.*` family is currently `trigger.request`, `trigger.response`,
   `trigger.error`, `trigger.exception`, and `trigger.rejection`. The
   first three are the handler-frame triplet emitted by the in-sandbox
   trigger plugin (paired open/close around `entry.fire`).
   `trigger.exception` is a *leaf* event for author-fixable pre-dispatch
   failures (IMAP misconfig, broken cron expression, etc.).
   `trigger.rejection` is a *leaf* event for HTTP webhook body schema
   rejections (zod 422 against the trigger's `body` schema). Both are
   host-emitted by the runtime helper `emitTriggerException` — no paired
   `trigger.request`, no frame, no sequencer involvement. See R-8 for
   the carve-out and `openspec/specs/invocations/spec.md` for the full
   contract.

   The `system.*` family additionally carries `system.upload` — a leaf
   event emitted host-side per workflow on successful `POST /api/workflows/
   <owner>/<repo>`, sha-deduped against the EventStore. See R-8 for the
   carve-out and R-9 for the `meta.dispatch` carve-out for uploads.
8. **R-8 Stamping-boundary discipline.** Event-field stamping is split
   across four layers:
   - **Bridge-stamped (worker-side):** `kind`, `name`, `ts`, `at`,
     `input?`, `output?`, `error?`, plus the wire-only `type` framing
     discriminator and (for opens) a worker-minted `callId`.
   - **Sandbox-stamped (main-side, by `RunSequencer`):** `seq` (per-run
     monotonic from 0) and `ref` (parent-frame seq, looked up by
     `callId` for closes; refStack-top for opens and leaves).
   - **Runtime-stamped (executor's `sb.onEvent` widener):** `id`,
     `owner`, `repo`, `workflow`, `workflowSha`, `invocationId`, and
     (on `trigger.request` only) `meta.dispatch`.
   - **Runtime-stamped (host-side `emitTriggerException` helper, no
     sandbox involved):** all of `id`, `kind`, `name`, `seq=0`,
     `ref=0`, `ts=0`, `at`, plus `owner`/`repo`/`workflow`/
     `workflowSha`/`invocationId`. This carve-out exists because
     pre-dispatch failures have no run, no sandbox, and no
     `RunSequencer` to stamp the worker-owned scalars. **The carve-out
     covers `trigger.exception` AND `trigger.rejection` ONLY.** The
     helper's `assertHostFailKind` asserts on the kind set; no other
     kind may bypass the sandbox/sequencer through this path. A future
     contributor extending the helper to additional kinds is breaking
     R-8.
   - **Runtime-stamped (host-side `emitSystemUpload` helper, no sandbox
     involved):** all of `id`, `kind="system.upload"`, `name`, `seq=0`,
     `ref=0`, `ts=0`, `at`, plus `owner`/`repo`/`workflow`/
     `workflowSha`/`invocationId`/`meta.dispatch`. This is a sibling
     carve-out for workflow uploads — uploads have no run, no sandbox,
     and no caller-supplied identity stream beyond the authenticated
     session. The helper's `assertSystemUploadKind` asserts
     `kind === "system.upload"`; the path is the only emitter for that
     kind and it is invoked from the upload handler only. R-9 carves
     out `meta.dispatch` for `system.upload` in the same way.
   No layer may stamp fields owned by another layer. A plugin
   that needs to attach an owner, repo, or workflow label is doing
   something wrong — that labelling belongs on the runtime side.
9. **R-9 Runtime-only dispatch provenance.** `InvocationEvent.meta` and
   every field nested under it (including `meta.dispatch`, which carries
   `{ source: "trigger" | "manual" | "upload", user? }`) are stamped
   exclusively by the runtime. The sandbox and plugin code MUST NOT
   emit, read, or construct `meta` — it has no guest-side entry point
   by design. Parallels R-8; the dispatch source and dispatching user
   are runtime concerns, never guest-visible.

   `meta.dispatch` appears on two event kinds and ONLY those two:
   `trigger.request` (stamped by the executor's `sb.onEvent` widener
   when forwarding the sandbox's open event onto the bus, with
   `source: "trigger" | "manual"`) and `system.upload` (stamped by the
   host-side `emitSystemUpload` helper when the upload handler emits a
   per-workflow upload event, with `source: "upload"`). Each stamping
   site asserts on the kind it is responsible for. Other kinds
   (`trigger.response`, `trigger.error`, `trigger.exception`,
   `trigger.rejection`, `action.*`, `system.request`, `system.response`,
   `system.error`, `system.call`, `system.exception`,
   `system.exhaustion`) MUST NOT carry `meta.dispatch`.
10. **R-10 `onPost` requires cross-cutting rationale.** The
    `PluginSetup.onPost` hook sees every outbound `WorkerToMain` message
    from every plugin; implementing it widens the plugin's observation
    and transformation surface across the whole composition. Plugins
    implementing `onPost` MUST have a documented cross-cutting
    rationale (e.g. uniform scrubbing, observability, PII redaction).
    The `secrets` plugin (from the `workflow-secrets` change) implements
    `onPost` for uniform literal-plaintext redaction: every outbound
    message is walked and occurrences of any known plaintext
    (manifest-sealed or runtime-registered via `secret()`) are replaced
    with `"[secret]"`. The scrubber is best-effort — author-side
    transformations (base64, hash, slice) evade it; `secret(derivedValue)`
    is the documented escape hatch.

    **Ordering invariant.** `worker.ts`'s `post()` threads each
    outbound message through every plugin's `onPost` in topo order,
    then `port.postMessage`s the result. If a plugin's `onPost`
    throws, `runOnPost` collects the error and feeds the pre-call
    message to the next plugin; `worker.ts` then posts a
    `sandbox.plugin.onPost_failed` log entry directly via
    `port.postMessage` — that log does NOT re-enter the scrubber
    pipeline. For this bypass to be safe, the `secrets` plugin MUST
    run before every other plugin that implements `onPost`, so each
    downstream `onPost` only ever sees scrubbed input; a throwing
    downstream plugin's `err.message` can therefore reference only
    scrubbed values. Today `secrets` is the only `onPost` plugin —
    the invariant is trivially met. Any future plugin adding `onPost`
    MUST be ordered AFTER `secrets` in the descriptor list built in
    `runtime/src/sandbox-store.ts#buildPluginDescriptors`. Reordering
    is a security regression.

    **`secrets.onPost` must never throw with plaintext.** The
    scrubber's own `onPost` is wrapped in `try { walkStrings(...) }
    catch { return placeholderLog }` — neither the original message
    nor the caught error escapes the function on the exception path.
    The placeholder drops the event content (acceptable — a throw
    here is a scrubber bug we want to fix, not paper over). Any
    future change to that body MUST preserve this containment.
11. **R-11 Sandbox resource caps — two-class pipeline.** Sandbox
    resource caps SHALL split into two classes distinguished by whether
    the guest can catch the breach. **Recoverable caps** (`memory`,
    `stack`) are enforced natively by QuickJS (`QuickJS.create({
    memoryLimit })` and `qjs_set_max_stack_size`); a breach SHALL
    surface as a catchable QuickJS exception (`InternalError: out of
    memory` / `RangeError: Maximum call stack size exceeded`). The
    sandbox SHALL survive recoverable breaches; the worker SHALL stay
    alive; the cache SHALL NOT be evicted; NO `system.exhaustion` event
    SHALL be emitted. Uncaught recoverable breaches bubble through
    `vm.callFunction`'s catch and become an ordinary
    `RunResult{ok:false, error}` like any guest error. **Terminal
    limits** (`cpu`, `output`, `pending`) SHALL flow through the
    uniform termination pipeline: (1) **detection** — worker-side
    output/pending construct a tagged `SandboxLimitError` and throw it
    via `queueMicrotask` so the throw escapes any surrounding plugin
    try/catch and lands on the Node thread outside any QuickJS
    evaluation frame; main-thread CPU breaches set `cpuBudgetExpired =
    true` and call `worker.terminate()`; (2) **classification** — both
    paths converge in `packages/sandbox/src/worker-termination.ts`,
    whose synchronous `cause()` getter (and exactly-once `onTerminated`
    dispatch) returns `{kind:"limit", dim, observed?}` with `dim ∈
    {"cpu","output","pending"}`; (3) **synthesis** —
    `packages/sandbox/src/sandbox.ts`'s `sb.run()` consults
    `termination.cause()` on `onError`/`onExit`, emits a
    `system.exhaustion` leaf via `sequencer.next()` carrying `name:
    dim, input: { budget, observed? }`, then calls
    `sequencer.finish({closeReason: "limit:<dim>"})` to synthesise LIFO
    close events for every still-open frame (seq/ref stamped by
    `RunSequencer` — no manual fabrication); (4) **eviction** —
    `sandbox-store` is the SOLE production subscriber to
    `Sandbox.onTerminated` and on any cause (limit or crash) evicts the
    `(owner, sha)` cache entry. The executor has no limit-specific
    code path: `sb.run()` rejects with `Error("sandbox limit exceeded:
    <dim>")` on terminal limit (symmetric with `Error("worker exited
    with code N")` on crash), and the executor's existing try/catch
    converts both into `InvokeResult{ok:false}`. NEVER bypass any
    stage of the terminal pipeline; NEVER add a runtime-termination
    call to the recoverable path; NEVER emit `system.exhaustion` for a
    recoverable breach. Adding a new terminal dimension without
    wiring it through `SandboxLimitError` (or a main-side flag) +
    `cause()` classification + `sequencer`-driven synthesis +
    `sandbox-store` eviction is a regression. See
    `openspec/specs/sandbox/spec.md` "Sandbox resource caps — two-class
    classification" and "Eviction on sandbox termination", and
    `openspec/specs/invocations/spec.md` "Requirement: system.exhaustion
    event kind".
12. **R-12 Host/sandbox boundary opacity for thrown errors.** NEVER
    throw an arbitrary `Error` toward the QuickJS trampoline from a
    host-callback closure. Errors crossing into the guest VM MUST be
    `GuestSafeError` instances (or one of its in-tree subclasses:
    `GuestArgTypeMismatchError`, `GuestValidationError`,
    `GuestThrownError`, `FetchError`, `MailError`, `SqlError`); the
    bridge-closure rule (in `bridge.ts`'s `buildHandler`) converts
    everything else into a generic `BridgeError` whose message is
    `"<publicName> failed"` and whose stack is a single synthetic
    `at <bridge:<publicName>>` frame. Plugin authors who want
    guest-visible message detail MUST construct a `GuestSafeError` (or
    subclass) with a curated `.message` containing only sandbox-internal
    information — guest-supplied input, well-known enums (libuv errnos,
    SQLSTATEs, SMTP response codes), and synthetic identifiers. Host
    filesystem paths, `node_modules` paths, pinned dependency versions,
    `data:text/javascript;base64,...` URLs, and Node-internal stack
    frames SHALL NOT be observable from guest code via thrown errors.
    Forwarding a third-party library's `.message` (undici / nodemailer /
    postgres-driver) verbatim is forbidden — the dispatcher MUST translate
    to a curated `*Error` shape and build the message from structured
    fields. The guest→host rethrow path (`callGuestFn` /
    `awaitGuestResult` in `bridge.ts`) SHALL construct `GuestThrownError`
    instances so cross-VM action throws preserve the inner `.name` and
    `.message` and the guest-side `.stack` (which is workflow-author
    source — already known to that author). See
    `openspec/specs/sandbox/spec.md` "Host/sandbox boundary opacity for
    thrown errors", "GuestSafeError class hierarchy", and "Guest-side
    error rethrow uses GuestThrownError"; per-dispatcher field provenance
    lives in `openspec/specs/sandbox-stdlib/spec.md` under the
    `FetchError` / `MailError` / `SqlError` requirements.
13. **R-13 Guest→host boundary opacity (audit integrity).** NEVER
    let a guest-originated throw escape into Node's
    `unhandledRejection` / `uncaughtException` escalation path.
    `Callable.invoke` (`bridge.ts`) surfaces guest throws as resolved
    `Promise<CallableResult>` envelopes — `{ ok: false, error:
    GuestThrownError }` — instead of rejected promises;
    `pluginRequest` (`plugin.ts`) auto-unwraps the envelope onto the
    `prefix.error` close and resolves its outer promise (never
    rethrows on envelope-error). Engine-side errors —
    `CallableDisposedError`, host `marshalArg` failures, vm-disposed
    mid-call — continue to reject (fail-loud signal preserved for
    genuine engine bugs). The contract change is type-checker-
    enforced: out-of-tree plugin consumers who upgrade
    `@workflow-engine/sandbox` see TS errors at every `await
    callable()` site that treats the result as a raw `GuestValue`,
    forcing migration to envelope inspection. R-13 is the symmetric
    twin of R-12: R-12 closes host→guest information leakage; R-13
    closes guest→host crash-channel abuse. Together they make the
    bridge a two-way opaque boundary. **Rationale.** A hostile
    workflow author can otherwise force `kind:"crash"` worker
    terminations and `worker exited with code N` run rejections by
    deferring a throw past handler return (e.g. `setTimeout(() => {
    throw }, 0)` plus any async wait in the handler reproduces it
    100%). This (a) flips a successful run into a failed run on the
    operator's dashboard view, corrupting audit signal indistinguishable
    from a genuine engine bug; (b) drops in-flight events between the
    throw and the worker's restore boundary; (c) forces a cold-start
    on the next run (full WASM instantiate + plugin source eval +
    Phase-3 deletes + initial snapshot), amplifying the author's CPU
    budget by the cold-start cost. R-4 (cleanup ordering) governs
    the disposal protocol that runs WHEN a run finishes; R-13
    governs the contract that prevents a guest throw from PREMATURELY
    ending the worker before R-4 can run. See `openspec/specs/
    sandbox/spec.md` "Guest→host boundary opacity (Callable envelope
    contract)" and "pluginRequest auto-unwraps Callable envelopes".
14. **R-14 Globals are enumerated.** Every own property of `globalThis`
    present after the post-init snapshot — minus the ES standard
    library and the quickjs-wasi engine baseline — MUST appear in the
    "Globals surface (post-init guest-visible)" list above. The
    enumeration test in
    `packages/runtime/src/globals-surface.test.ts` MUST pass under the
    production plugin descriptor set returned by
    `buildPluginDescriptors` in
    `packages/runtime/src/sandbox-store.ts`. A change that adds,
    renames, or removes a guest-visible global on `globalThis`
    (whether installed by a plugin's Phase-2 IIFE, by the workflow
    IIFE namespace, or by any future mechanism) MUST update both this
    section AND the inline const arrays in the test in the same
    change. The audit posture is mechanical, not by-eye: the test
    asserts an exact-set equality on the *delta* between a
    NOOP_PLUGINS baseline boot and the production-plugin boot.

Additional standing rules that predate the plugin rewrite:

- **Sandbox-related changes MUST include security tests** covering
  escape attempts, global visibility, sandbox disposal, and any new
  plugin's failure modes. Private-descriptor deletion, `__sdk` lock
  semantics, and `hardenedFetch` defaults each have dedicated probes.
- **Every new host-callable descriptor MUST validate its input** before
  acting on it (the guest's Zod copy is untrusted). `host-call-action`'s
  Zod-rehydration pipeline is the canonical pattern; new descriptors
  either reuse it or follow the same shape, and SHALL be covered by a
  prototype-pollution test.
- **When adding an outbound capability (fetch, action call, etc.),
  explicitly consider SSRF and exfiltration.** If no URL allowlist
  applies, say so in the change proposal; do not claim the sandbox
  "prevents" reaching an internal service beyond what `hardenedFetch`
  structurally blocks.

### Adding a system-bridge plugin

A "system-bridge plugin" is any sandbox-stdlib plugin that exposes a
host-side I/O capability to the guest under the reserved `system.*`
event prefix (R-7) — currently `fetch`, `mail`, `sql`. Adding a new one
(IMAP host-side, S3 client, gRPC, LDAP, etc.) is a high-impact change:
each item below has been the subject of a prior security finding or
spec refinement, so the checklist is review-mandatory, not aspirational.

Before merging a new system-bridge plugin, every item below MUST be
satisfied (or explicitly justified in the change proposal):

1. **Net-guard ordering.** Call `assertHostIsPublic(host)` from
   `@workflow-engine/sandbox-stdlib/net-guard` BEFORE constructing any
   driver-level resource. Pass the validated IP to the driver; pin the
   ORIGINAL hostname as the TLS `servername` so SNI + cert verification
   still bind to the user-supplied identity. Closes the TOCTOU window
   between DNS validation and socket open. (R-S4 in §2 Mitigations;
   canonical: `mail/worker.ts:307`, `sql/worker.ts:442`,
   `fetch/hardened-fetch.ts` connector.)

2. **Per-call resources track via `createRunScopedHandles`.** Wire
   `track` on resource construction, `release` in the per-call
   `finally`, and register `onRunFinished: handles.drain` on the
   plugin's `PluginSetup`. Closer must be idempotent against the
   delete-before-close ordering the helper enforces. Pool-shared
   resources do NOT use this — see R-4 "per-call vs pool-shared".

3. **Reserved prefix `system.*` (R-7).** Set `log: { request: "system" }`
   on the guest function descriptor. The operation identity goes into
   the event's `name` field (e.g. `system.request name="sendMail"`),
   never into the prefix.

4. **Structured errors.** Define a local `classify*Error(err)` and a
   `throwStructured(err)` helper that surfaces `{ kind, message, code?,
   ... }` to the guest. Authors must be able to discriminate failure
   modes (auth vs timeout vs recipient-rejected vs ...) without parsing
   the message string. Wire-shape MUST match the existing
   `MailError` / `SqlError` precedent.

5. **Redacted logging.** Implement `logInput` to drop credentials,
   request bodies, query parameters, attachments, and any other
   PII-bearing payload. Keep the envelope (host, port, method, URL
   path, recipient list, query SQL skeleton) so the audit log stays
   useful. The `Authorization` header rule from §4 applies: never
   emit raw credentials under any prefix. The runtime `secrets`
   plugin's `onPost` scrubber is the LAST-resort backstop, not a
   substitute for plugin-side redaction.

6. **Timeouts: default + ceiling.** Define `DEFAULT_TIMEOUT_MS` (typical
   call) and `MAX_TIMEOUT_MS` (hard ceiling). Author-supplied timeouts
   MUST be clamped to the ceiling. Document both at the top of the
   worker module.

7. **JSON-serializable config (R-6).** Plugin `descriptor.config` MUST
   be JSON-serializable (verified by `assertSerializableConfig` at
   sandbox construction). Main-thread state (connection pools,
   persistent caches) cannot live in a plugin — pass it as serialized
   config or reach it via a descriptor-bridged guest function.

A proposal that adds a system-bridge plugin without addressing every
item is incomplete. A new plugin author may copy `sql/worker.ts` or
`mail/worker.ts` as the canonical reference; both follow this checklist.

### File references

- Sandbox factory + `run()`: `packages/sandbox/src/index.ts`
- Plugin types + composition: `packages/sandbox/src/plugin.ts`,
  `packages/sandbox/src/plugin-compose.ts`
- Worker boot phases + WASI dispatch: `packages/sandbox/src/worker.ts`,
  `packages/sandbox/src/wasi.ts`
- Host↔VM bridge (arg/result marshaling, `Callable` lifecycle, descriptor
  install + leak audit): `packages/sandbox/src/bridge-factory.ts`
- Guest descriptor error classes: `packages/sandbox/src/guest-errors.ts`
- Vite plugin + worker-side loader: `packages/sandbox/src/vite/sandbox-plugins.ts`,
  `packages/sandbox/src/worker-plugin-loader.ts`
- Sandbox stdlib plugins: `packages/sandbox-stdlib/src/{web-platform,fetch,timers,console}/`
- WASI plugin: `packages/sandbox/src/plugins/wasi-plugin.ts`
- WebCrypto: provided natively by the `quickjs-wasi` `cryptoExtension`
  WASM extension (loaded in `worker.ts`)
- `hardenedFetch`: `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts`
  (re-exported from `@workflow-engine/sandbox-stdlib`)
- SDK support plugin + action callable: `packages/sdk/src/sdk-support/`,
  `packages/sdk/src/index.ts`
- Runtime host-call-action plugin: `packages/runtime/src/plugins/host-call-action.ts`,
  `packages/runtime/src/host-call-action-config.ts`
- Runtime trigger plugin: `packages/runtime/src/plugins/trigger.ts`
- Sandbox store (per-`(owner, sha)` sandbox cache + plugin composition):
  `packages/runtime/src/sandbox-store.ts`
- Workflow registry (metadata + per-owner trigger index):
  `packages/runtime/src/workflow-registry.ts`
- HTTP trigger middleware: `packages/runtime/src/triggers/http.ts`
- Executor (per-workflow runQueue + `sb.onEvent` stamping):
  `packages/runtime/src/executor/`
- OpenSpec spec: `openspec/specs/sandbox/spec.md`
- OpenSpec spec: `openspec/specs/sandbox-plugin/spec.md`
- OpenSpec spec: `openspec/specs/sandbox-stdlib/spec.md`
- OpenSpec spec: `openspec/specs/sdk/spec.md`


## §3 Webhook Ingress

### Trust level

**PUBLIC.** `POST /webhooks/{owner}/{repo}/{workflow}/{trigger_name}` is
reachable by anyone on the Internet without authentication. This is an
**intentional design choice**: webhooks are how external systems deliver
events. Do not add authentication here without an OpenSpec change proposal —
existing integrations depend on unauthenticated ingress.

The owner, repo, workflow, and trigger-name segments in the URL are
**identification, not authorization**: knowledge of a valid
`(owner, repo, workflow, trigger)` tuple is sufficient to trigger the
workflow. These segments exist to disambiguate the `(owner, repo)` scope
and the workflow/trigger identity at the routing layer, not to gate
access.

Everything received on this surface must be treated as
attacker-controlled: body, headers, query string, URL parameters, and
timing.

**Cron triggers are NOT on this surface.** `cronTrigger(...)` fires from the
runtime's internal scheduler (`packages/runtime/src/triggers/cron.ts`) —
there is no external caller, no external URL, and no untrusted input crosses
a network boundary at fire time (the handler receives an empty payload `{}`,
reflected in the SDK's `inputSchema: z.object({})` property, enforced at the
type level and validated by the `fire` closure before the sandbox is entered).
Cron triggers are exposed only via the authenticated `/trigger` UI's
"Run now" affordance, which sits behind `sessionMiddleware` +
`requireOwnerMember` (§4).

**WS triggers are NOT on this surface either.** `wsTrigger(...)` is reachable
only via authenticated WebSocket upgrades at
`/ws/{owner}/{repo}/{workflow}/{trigger_name}` —
`packages/runtime/src/triggers/ws.ts`. The upgrade handler runs the same
`apiAuthMiddleware` semantics as `/api/*` (Bearer + provider header → resolved
`UserContext`) and additionally requires `isMember(user, owner)`. Every
failure mode (no Authorization, unknown provider, bad Bearer, owner not
member, trigger not registered, trigger wrong kind, missing `Upgrade:
websocket` header, malformed path) writes a byte-identical
`HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
on the socket and destroys it — no existence/authorization information leaks
on the wire. Per-message frames are JSON-parsed and validated against the
trigger's `request` zod schema by the registry-built `fire` closure before the
sandbox is entered; a malformed frame closes the connection with code 1007.
The handler's return value is JSON-serialized and sent back to the originating
client only (FIFO-ordered with the per-workflow runQueue). No identity is
surfaced into the handler payload — the workflow sees only `{data}`.

### Entry points

- `POST /webhooks/{owner}/{repo}/{workflow}/{trigger_name}` (or whatever
  `method` the trigger declares; default POST) with JSON body.
- `{owner}` and `{workflow}` are validated against the owner identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`); `{repo}` is validated against the
  repo regex (`^[a-zA-Z0-9._-]{1,100}$`); `{trigger_name}` is validated
  against the trigger-name regex (`^[A-Za-z_][A-Za-z0-9_]{0,62}$`);
  non-matching values receive 404.
- Trigger segment matching is **exact**: the URL MUST be exactly four
  regex-constrained segments after `/webhooks/`. No URLPattern, no `:param`
  named segments, no `*wildcard` tail segments. Lookup is a constant-time
  `Map.get()` keyed by `(owner, repo, workflow, trigger-name)`
  (`packages/runtime/src/triggers/http.ts`). Query strings on the URL are
  tolerated for compatibility with providers that append tracking params
  (AWS signatures, delivery IDs) but are **not parsed** into any structured
  field on the handler's payload.
- Request data delivered to the trigger handler as the `payload`
  argument is exactly these four fields, and no others:

  ```typescript
  { body, headers, url, method }
  ```

  There are no `params` fields (webhook URLs have no `:param`
  segments) and no `query` field (the query string is not pre-parsed
  into structured data). Handlers that need a query-string value SHALL
  parse it explicitly via `new URL(payload.url).searchParams` and
  treat the result as untrusted. `body` is a JSON-parsed object
  validated against the trigger's JSON Schema (Zod, rehydrated at
  workflow load) before the sandbox
  is entered. `headers`, `url`, and `method` are attacker-controlled
  metadata — the sandbox sees them as data, not as authentication.
  Removing `params`/`query` eliminated an entire class of
  URL-to-handler-argument injection vectors; do not reintroduce these
  fields without a threat-model proposal.

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

### Mitigations (current)

- **Zod validation** of the request body against the trigger's manifest
  JSON Schema (rehydrated via `z.fromJSONSchema` at workflow load).
  Invalid payloads return **422** with
  structured issues and never reach the sandbox or the executor.
  No matching trigger → **404**. Handler throws → **500** + a `failed`
  archive record.
  (`packages/runtime/src/triggers/http.ts`)
- **Structural JSON round-trip** of the body before validation
  (`structuredCloneJson()` in the workflow registry) strips
  `__proto__` and `constructor` keys from the attacker-supplied object,
  so prototype-pollution payloads cannot poison the validator or the
  downstream handler object.
- **Sole invocation path is `entry.fire(input)`.** The HTTP middleware's
  only job after URL routing is to normalize the request into an
  `input` object and call `entry.fire(input)` on the matched
  `TriggerEntry`. The `fire` closure is built by the `WorkflowRegistry`
  (see `packages/runtime/src/triggers/build-fire.ts`) and
  encapsulates Zod input-schema validation + `executor.invoke`; the
  HTTP source does NOT import or call the executor directly. The
  executor still owns runQueue serialization + lifecycle emission.
- **Payload scope reaches the sandbox only as the handler's `payload`
  argument** — a JSON snapshot. Any downstream code that consumes the
  payload runs in the sandbox with no host APIs (see §2).
- **TLS termination at Caddy** (HTTPS only on `:443`; `:80` serves the
  HTTP-01 ACME challenge and redirects all other paths to HTTPS).
- **Closed URL vocabulary.** The three URL segments
  (`<owner>/<workflow>/<trigger-name>`) are all regex-constrained identifiers
  set at workflow build time (the trigger name IS the export identifier,
  enforced by the vite plugin) and validated at upload (the manifest Zod
  schema's `.regex()` constraints). There is no author-controlled URL
  fragment; there are no param placeholders; there is no URL-derived data
  structured onto the handler's payload. A request URL either matches
  exactly one registered `(owner, workflow, trigger-name)` triple or
  returns **404**. This is strictly stricter than URLPattern-based matching
  and eliminates any `payload.params` / `payload.query` injection surface
  entirely — the handler receives `{ body, headers, url, method }` and
  nothing else. Collisions within a workflow are impossible by
  construction (JS rejects duplicate export names at parse time; the
  manifest schema requires unique trigger names per workflow; the
  workflow manifest schema requires unique workflow names per owner).
- **Separate trust domain** — webhook handlers cannot read the session
  cookies or bearer tokens used by the UI / API routes, because those
  headers are not forwarded to this route family.
- **Global request body size cap of 10 MiB** via Hono's `bodyLimit`
  middleware mounted at `*` in `createApp`. Oversize requests short-
  circuit with **413** `{ "error": "payload_too_large" }` before any
  route handler runs. Applies to webhooks and the `/api/workflows`
  upload path alike.
  (`packages/runtime/src/services/server.ts`)
- **Reserved response header strip.** The HTTP `TriggerSource` filters
  the workflow-supplied `headers` against `RESERVED_RESPONSE_HEADERS`
  (exported from `@workflow-engine/core`) before writing the wire
  response. Reserved names cover (a) the cross-tenant /
  external-attacker class — `set-cookie`, `set-cookie2`, `location`,
  `refresh`, `clear-site-data`, `authorization`, `proxy-authenticate`,
  `www-authenticate` — and (b) the platform security/transport
  invariants set globally by `secureHeadersMiddleware` —
  `content-security-policy*`, `strict-transport-security`,
  `x-content-type-options`, `x-frame-options`, `referrer-policy`,
  `cross-origin-{opener,resource,embedder}-policy`,
  `permissions-policy`, `server`, `x-powered-by`. Reserved values are
  stripped silently from the wire and surfaced to the workflow author
  via a single `trigger.exception` per response with
  `name: "http.response-header-stripped"` and
  `input: { stripped: [<sorted lowercased names>] }`. The same set is
  enforced at SDK build time: `wfe upload` rejects any `httpTrigger`
  whose `response.headers` zod schema declares a reserved name. Build-
  time enforcement is developer-experience only; the runtime strip is
  the security boundary. See `http-trigger` and `http-security` specs.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-W1 | **No signature verification** on incoming payloads (HMAC, GitHub signature, Stripe signature, etc.) | W4 unmitigated | v1 limitation; add per-integration |
| R-W2 | ~~No payload size limit~~ — Mitigated by a global 10 MiB Hono `bodyLimit` in `createApp` (`packages/runtime/src/services/server.ts`). A owner tarball is additionally bounded to 10 MiB decompressed inside `extractOwnerTarGz` (`packages/runtime/src/workflow-registry.ts`). | W2 mitigated | Resolved |
| R-W3 | **No rate limiting** at the application or ingress (Caddy) level | W3, W7 unmitigated | v1 limitation |
| R-W4 | ~~All request headers are forwarded verbatim~~ — Mitigated by the typed-headers contract (2026-04-26): `payload.headers` exposes only header keys declared in the trigger's `request.headers` zod schema; undeclared keys are stripped silently before the handler runs and never reach the event store. Default when no schema is declared is the empty object `{}`. Authors who need a specific header opt in by declaring it in the schema (`request: { headers: z.object({ "x-hub-signature-256": z.string() }) }`); auth-bearing headers (`authorization`, `cookie`) are not forwarded unless explicitly declared, which tightens the `never log Authorization` invariant from logger-level redaction to schema-level filtering. | W5 mitigated by per-trigger schema | Resolved |
| R-W5 | Trigger names are reflected in 404 vs 422 vs 200 response differences, enabling enumeration | W6 low | Accepted; triggers are not secret |

### Implementation guidance for signed webhooks

When adding signature verification for a specific integration (e.g.
GitHub webhooks, Stripe webhooks), implement the verifier as a
**pre-validation step in the HTTP trigger middleware** — before the
registry-built `fire` closure runs Zod input-schema validation and
dispatches to the executor — and reject unsigned or incorrectly
signed requests with 401 before any sandbox entry. Store the signing
secret as a K8s Secret per §5, never in the trigger definition. The
verifier must not skip the schema check; a valid signature on a
schema-violating payload still returns 422.

### Rules for AI agents

1. **NEVER add authentication to `/webhooks/*` without an explicit
   OpenSpec proposal.** Public ingress is deliberate.
2. **NEVER strip the Zod input-schema validation step** between the
   incoming request and `executor.invoke`. In the current design the
   check lives inside the registry-built `fire` closure (see
   `packages/runtime/src/triggers/build-fire.ts`); removing it would
   let schema-violating payloads reach the sandbox directly. It is the
   only pre-sandbox filter on the webhook surface.
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
8. **NEVER rely solely on SDK build-time validation for security
   boundaries on the workflow→runtime contract.** The SDK runs in
   tenant-controlled environments (developer machines, CI runners) and
   can be forked, replaced, or bypassed; every build-time guard MUST
   have a corresponding runtime check at the host boundary. Canonical
   example: `RESERVED_RESPONSE_HEADERS` (exported from
   `@workflow-engine/core`) is enforced both in `wfe upload` (rejects
   declared reserved keys in `response.headers` schemas) and in the
   runtime HTTP `TriggerSource` (strips reserved keys from the wire
   response and emits a `trigger.exception`).
9. **NEVER allow the workflow to set a header in
   `RESERVED_RESPONSE_HEADERS` on a `/webhooks/*` response.** The
   strip happens in the response-shaping path
   (`packages/runtime/src/triggers/http.ts`) and is paired with a
   single `trigger.exception` per response. Removing the strip
   reintroduces the cross-tenant cookie-injection / open-redirect /
   platform-invariant-override threat class; weakening the reserved
   list to admit a previously-reserved name requires an explicit
   OpenSpec proposal.

### File references

- Webhook middleware + registry: `packages/runtime/src/triggers/http.ts`
- Payload validation entry + body-shape normalization: `packages/runtime/src/workflow-registry.ts`
- Executor (post-validation invocation path): `packages/runtime/src/executor/`
- Caddy ingress (Caddyfile + Quadlet): `infrastructure/caddy.tf`, `infrastructure/files/Caddyfile.tmpl`, `infrastructure/files/caddy.container.tmpl`
- OpenSpec spec: `openspec/specs/triggers/spec.md`
- OpenSpec spec: `openspec/specs/http-trigger/spec.md`
- OpenSpec spec: `openspec/specs/payload-validation/spec.md`

## §4 Authentication

### Trust level

**AUTHENTICATED** — one identity model, two transports, one enforcement
surface (the app). All authentication and authorization runs in-process;
the oauth2-proxy sidecar and Traefik forward-auth chain are no longer
part of the trust chain.

Authentication is organized as an `AuthProvider` registry
(`packages/runtime/src/auth/providers/{types,registry,github,local,index}.ts`).
Each provider implements the `AuthProvider` interface in `providers/types.ts`:
`renderLoginSection`, `mountAuthRoutes`, `resolveApiIdentity`, and
`refreshSession`. The registry is built at startup by
`buildProviderFactories` in `providers/index.ts` by bucketing `AUTH_ALLOW`
entries by provider id (first colon-separated token) and handing each
factory its entries. Two providers ship: `github` (always available) and
`local` (only registered when `process.env.LOCAL_DEPLOYMENT === "1"`). The
old `Auth = { mode: "disabled" | "open" | "restricted" }` discriminated
union, the `authOpen` `ContextVariableMap` flag, and the `__DISABLE_AUTH__`
sentinel are gone — the only state is "which providers are registered,
with which entries."

Two transports share the same registry and the same `UserContext` shape:

1. **UI routes** (`/dashboard`, `/trigger`) — authenticated by
   `sessionMiddleware` (`packages/runtime/src/auth/session-mw.ts`),
   which reads an AEAD-sealed `session` cookie (iron-webcrypto). The
   sealed `SessionPayload` carries a required
   `provider: "github" | "local"` field that selects which provider's
   `refreshSession` runs on soft-TTL refresh (10 min). The login page
   lives at `/login` and iterates the registry, rendering one section
   per provider (GitHub button, local-user dropdown form). Per-provider
   handshake routes (`/auth/github/signin`, `/auth/github/callback`,
   `POST /auth/local/signin`) are mounted by each provider's
   `mountAuthRoutes(subApp)`; `POST /auth/logout` is provider-agnostic.
2. **API** (`/api/*`) — authenticated by `apiAuthMiddleware`
   (`packages/runtime/src/api/auth.ts`), which reads the
   `X-Auth-Provider: <id>` request header, looks up the provider in the
   registry, and dispatches to `provider.resolveApiIdentity(req)`. Each
   provider owns its own `Authorization` parsing: `github` expects a
   Bearer token validated against
   `https://api.github.com/user` + `/user/orgs`; `local` expects
   `Authorization: User <name>` and validates against its bucketed
   entries. Missing / unknown `X-Auth-Provider`, or provider returning
   `undefined`, → 401 (identical response body).

Both transports produce `UserContext = { name, mail, orgs }` (no
`teams`; no consumer reads them). Empty `AUTH_ALLOW` → empty registry →
`/login` renders with no provider sections and nothing can authenticate
(`/api/*` → 401 unconditionally; UI → redirect to an empty `/login`).
This replaces the former "disabled mode" rejection-of-all-requests
behaviour — same end result, different mechanism. Owner scope for writes
runs through `isMember(user, owner)`, unchanged from prior revisions.

**Manual-fire dispatch through `/trigger/*`.** The operator "fire this
trigger now" UI submits every kind (HTTP, cron, future kinds) to the
authenticated endpoint `POST /trigger/<owner>/<workflow>/<name>`, which
sits behind `sessionMiddleware` + `requireOwnerMember`. HTTP descriptors
are server-wrapped into the `HttpTriggerPayload` shape before dispatch
(`{ body, headers: {}, url: "/webhooks/<owner>/<workflow>/<name>",
method }`). The session user (`{ name, mail }`) is captured as dispatch
provenance (`meta.dispatch.user`, see `invocations` spec and R-9) so
operator-initiated fires are attributable. External (non-UI) callers
continue to hit the public `/webhooks/*` ingress (§3) unchanged and
produce `meta.dispatch = { source: "trigger" }` with no `user`. Adding
authentication to `/webhooks/*` is still forbidden (see below); the
authenticated dispatch path is `/trigger/*`, and a UI form posting to
`/webhooks/*` would bypass attribution.

### Entry points

| Route family | Auth mechanism | Enforced by | Bypass check |
|---|---|---|---|
| `/dashboard`, `/trigger` | Sealed session cookie + soft-TTL refresh | App `sessionMiddleware` (mounted inside each UI middleware factory) | Any new authenticated UI prefix must receive `sessionMw` in its factory deps |
| `/login` | None (public page) | App `loginPageMiddleware` | Renders the sign-in page; never auto-redirects to an IdP. The "Sign in with GitHub" button links to `/auth/github/signin`. |
| `/auth/*` (per-provider `mountAuthRoutes`, plus provider-agnostic `POST /auth/logout`) | None; these ARE the handshake surface | App `authMiddleware` | Providers mount their own routes under `/auth/<id>/`. GitHub handlers must validate the `auth_state` cookie on callback and must sanitize `returnTo` to same-origin; local handlers validate the submitted `name` against the provider's bucketed entries |
| `/api/*` | `X-Auth-Provider` header + provider-specific credential | `apiAuthMiddleware` dispatches to registered provider's `resolveApiIdentity` | Empty registry / missing `X-Auth-Provider` / unknown id / provider returns `undefined` → 401 (identical body) |
| `/webhooks/*` | **None (PUBLIC)** | Intentional | See §3 |
| `/static/*`, `/livez`, `/` | None | Intentional | Must stay non-sensitive |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| A1 | Attacker steals a session cookie (XSS, shared device) and accesses a UI route | Spoofing |
| A2 | Attacker steals a Bearer token and accesses `/api/*` | Spoofing |
| A3 | Attacker forges the session cookie or state cookie without the in-memory sealing password | Spoofing |
| A4 | A new authenticated route is added but not wired through `sessionMiddleware` | EoP |
| A5 | Deployment sets `LOCAL_DEPLOYMENT=1` in production and/or adds a `local:<name>` entry to the prod `AUTH_ALLOW` GH variable, registering the LocalProvider in production | EoP |
| A6 | Attacker with access to the browser cookie store exfiltrates the sealed session and replays it against the app | Spoofing |
| A7 | GitHub API is unreachable; sessions past their soft TTL fail refresh and the dashboard returns 302 → login → fails | DoS |
| A8 | GitHub API rate-limits the application's IP (no caching of `/api/*` token validation) | DoS |
| A9 | Bearer token, session cookie, GitHub access token, or the in-memory sealing password is written to logs or to an event payload | Information disclosure |
| A10 | User is removed from `AUTH_ALLOW` but an existing session cookie is still honoured until the next soft-TTL refresh | EoP (stale access) |
| A11 | OAuth callback CSRF: attacker tricks a signed-in user into visiting a malicious `/auth/github/callback?code=…&state=…` URL | Spoofing (phishing) |
| A12 | Allow-listed user uploads to a owner they are not a member of (or enumerates owners) to discover owner names | EoP (cross-owner) / Information disclosure |
| A13 | *(Eliminated.)* Historical: allow-listed Bearer caller on `/api/*` forges `X-Auth-Request-*` headers to impersonate membership in another owner. No code path reads those headers; kept here as a reminder. | n/a |
| A14 | Authenticated caller reads workflow or invocation-event data by id or name on a surface whose handler omits the owner scope (breaks I-T2) | EoP (cross-owner) / Information disclosure |
| A15 | App Deployment is scaled to `replicas > 1` while the sealing password is in-memory; cookies signed on pod A fail to decrypt on pod B | Availability / EoP (indirect: forces re-login, possibly thrashing) |

### Mitigations (current)

- **Sealed session cookie** (`iron-webcrypto` AEAD, Path=/, HttpOnly,
  Secure, SameSite=Lax, Max-Age=7d). Tampered or expired cookies fail
  `unseal` and are treated as absent.
  (`packages/runtime/src/auth/session-cookie.ts`)
- **Sealed state + flash cookies** for the OAuth handshake. The
  `auth_state` cookie carries `{state, returnTo}` with a 5-minute TTL;
  the callback handler verifies `state === query.state` (CSRF check)
  and sanitises `returnTo` to a same-origin relative path before
  redirecting. Failure → `400 Bad Request`. The `auth_flash` cookie
  (60 s TTL) carries the rejected login so the login page can render a
  red deny banner on the next hit.
  (`packages/runtime/src/auth/state-cookie.ts`,
  `packages/runtime/src/auth/flash-cookie.ts`,
  `packages/runtime/src/auth/routes.ts`)
- **In-memory sealing password, never persisted.** 32 random bytes
  generated at process start, held in a module-level closure, never
  written to disk, K8s Secret, log, or telemetry. Pod restart rolls
  the password and invalidates every existing cookie (users re-login).
  This is the load-bearing invariant behind `replicas = 1` (A15, see
  §5 R-I*).
  (`packages/runtime/src/auth/key.ts`)
- **AUTH_ALLOW grammar, provider-prefixed and fail-fast.** Env value:
  `github:user:<login>,github:org:<org>,local:<name>,local:<name>:<org>|<org>,…`.
  Top-level separator is `,`; the local provider uses `|` as its
  org sub-separator. Entries are bucketed by provider id (first
  colon-separated token) and handed to that provider's factory.
  Unknown provider ids cause `createConfig` to throw at startup with a
  diagnostic identifying the offending token — the runtime fails to
  boot rather than silently ignoring the entry. When
  `process.env.LOCAL_DEPLOYMENT` is unset (prod/staging), the local
  factory is not in the registry, so any `local:*` entry surfaces as
  the same `unknown provider "local"` error.
  (`packages/runtime/src/auth/providers/index.ts`,
  `packages/runtime/src/config.ts`)
- **Per-provider membership predicate, owned by each provider.** Each
  provider's factory closes over its bucketed entries and produces a
  provider instance whose `resolveApiIdentity` / `refreshSession`
  return `undefined` for non-matching callers. There is no central
  `allow(user, auth)` function. GitHub matches by case-sensitive login
  or `user.orgs ∩ entry.orgs ≠ ∅`; local matches by name and copies
  the entry's declared orgs into `UserContext.orgs`.
  (`packages/runtime/src/auth/providers/github.ts`,
  `packages/runtime/src/auth/providers/local.ts`)
- **Session-refresh re-validation via provider.** The stale-session
  branch of `sessionMiddleware` reads the `provider` field from the
  sealed `SessionPayload`, looks up the provider in the registry, and
  calls `provider.refreshSession(payload)`. The github provider
  re-fetches `/user` and `/user/orgs`, rebuilds `UserContext`, and
  re-checks its bucketed entries; the local provider re-matches the
  name against its static entries (no network roundtrip). A GitHub user
  removed from the bucketed entries loses access within ≤10 min (A10),
  bounded by the soft TTL rather than the 7 d hard TTL. On rejection
  the cookie is cleared and an `auth_flash` cookie is set so the next
  `/login` renders the deny banner. Local sessions never expire due to
  upstream changes — they only re-validate against the static
  bucketed entries loaded at boot; removing a `local:` entry requires a
  restart to take effect.
- **Fail-closed refresh.** Any non-OK response from GitHub on the
  refresh path (401, 403, 5xx, timeout, DNS error) clears the session
  cookie and 302s to `/login`. No grace period; during a
  GitHub outage the dashboard is unreachable. The `/api/*` path has
  equivalent fail-closed behaviour (no caching of token validation).
- **GitHub OAuth scope `user:email read:org`.** `read:org` is required
  so private-org `AUTH_ALLOW=github:org:<priv>` entries resolve
  correctly. No broader scope is requested.
  (`packages/runtime/src/auth/github-api.ts`)
- **Fail-closed empty registry.** Unset / empty `AUTH_ALLOW` → empty
  registry → `/api/*` rejects every request 401 (the dispatcher finds
  no provider for any `X-Auth-Provider` value, including a missing one)
  and `/login` renders with zero provider sections (nothing can
  authenticate, so `/dashboard` and `/trigger` are unreachable). A
  missing config **never** silently opens the app. The `local`
  provider factory only enters the registry when
  `process.env.LOCAL_DEPLOYMENT === "1"`; in prod/staging it is
  physically absent regardless of `AUTH_ALLOW` contents.
- **Allow-list enumeration protection.** All negative outcomes on
  `/api/*` return `401 Unauthorized` with an identical body — missing
  `X-Auth-Provider`, unknown provider id, missing/invalid credential,
  upstream provider error, and allow-list miss are indistinguishable
  to the caller.
  (`packages/runtime/src/api/auth.ts`)
- **Owner membership enforcement via `requireOwnerMember()` middleware
  (R-A12).** A single Hono middleware factory is the sole enforcement
  point for the `:owner` authorization invariant. It validates
  `<owner>` against the identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`). When a `:repo` param is present on
  the matched route, its segment is also validated against the repo regex
  (`^[a-zA-Z0-9._-]{1,100}$`). The membership predicate then evaluates
  `isMember(user, owner) := user.orgs.includes(owner)` — `user.orgs` is
  seeded with `[user.login, ...githubOrgs]` at login so user-owned
  resources satisfy membership via the same set check, without a separate
  `user.login === owner` clause. Both format and membership failures return
  `404 Not Found` with an identical JSON body (`{"error":"Not Found"}`)
  sourced from each sub-app's `app.notFound(...)` handler. Teams are not
  consulted (and are no longer part of `UserContext`). The membership check
  applies to every authenticated caller regardless of which provider minted
  the identity — there is no longer an "open mode" bypass. The middleware
  is mounted on `/api/workflows/:owner/:repo` and on the
  `/trigger`-basePath and `/dashboard`-basePath sub-apps' `/:owner`,
  `/:owner/*`, `/:owner/:repo`, and `/:owner/:repo/*` subtrees. Inline
  `validateOwner` / `validateRepo` + `isMember`/`ownerSet` checks in
  individual route handlers are prohibited; any new route that accepts a
  `:owner` (with optional `:repo`) path parameter MUST mount
  `requireOwnerMember()` on its subpath.
  (`packages/runtime/src/auth/owner.ts`,
  `packages/runtime/src/auth/owner-mw.ts`,
  `packages/runtime/src/api/index.ts`,
  `packages/runtime/src/ui/trigger/middleware.ts`)
- **No code path reads `X-Auth-Request-*` (A13 eliminated).** The
  `headerUserMiddleware` reader and all references to those headers
  were deleted. `apiAuthMiddleware` reads only the
  `X-Auth-Provider` header and then delegates `Authorization` /
  credential parsing to the selected provider's `resolveApiIdentity`;
  `sessionMiddleware` reads only the `session` cookie. Forged
  `X-Auth-Request-*` headers have no handler to trust them. No
  ingress-side strip-headers middleware exists — no upstream
  produces those headers, and no downstream consumes them.
- **Startup-logged registered providers.** The runtime emits a log
  record at init listing the registered provider ids and the per-provider
  entry counts (not the entries themselves). When `LOCAL_DEPLOYMENT=1`
  is set, the presence of `local` in the registry is logged at `warn`
  level to make accidental enablement visible.
  (`packages/runtime/src/main.ts`)
- **POST-only logout.** `POST /auth/logout` clears the session cookie
  and 302s to `/`. Any other method returns 405 — prevents cross-site
  logout CSRF via `<img src>` / `<a>` / navigation.
- **TLS termination at Caddy.** Session cookies, Bearer tokens, and
  the GitHub access token stored inside the sealed cookie are not in
  cleartext on the wire.
- **Scope-list query API (A14).** `EventStore.query(scopes)` accepts a
  caller-supplied allow-list of `{owner, repo}` pairs and compiles
  `WHERE (owner, repo) IN (…)` via Kysely. An empty scope list throws —
  it never degrades to an unscoped read. Every production call site
  routes through `resolveQueryScopes(user, registry, constraint?)`,
  which intersects `user.orgs` with `registry.pairs()` (registered
  bundles) and optionally narrows by a caller-supplied `(owner, repo)`
  constraint. Constructing a raw `Scope` from URL segments is a
  cross-owner-leak bug and forbidden by the R-A14 review checklist.
  Workflow bundles are `(owner, repo)`-keyed at the storage layer
  (`workflows/<owner>/<repo>.tar.gz`).

### CLI authentication (`wfe upload`)

The `@workflow-engine/sdk` CLI (`pnpm exec wfe upload --owner <name>`
— packaged as `bin: { wfe: dist/cli/cli.js }` in
`packages/sdk/package.json`) POSTs the built tarball to
`/api/workflows/:owner`. That endpoint lives under `/api/*`, so the
same `apiAuthMiddleware` rules apply: every request SHALL carry
`X-Auth-Provider` plus an `Authorization` credential the provider can
validate. The CLI supports two mutually-exclusive auth inputs and one
env-var fallback:

- `--user <name>` → sends `X-Auth-Provider: local` +
  `Authorization: User <name>`. Only accepted when the server has
  `LOCAL_DEPLOYMENT=1` and registers the `local` provider (see
  `AUTH_ALLOW` above). Local-dev only.
- `--token <ghp_…>` → sends `X-Auth-Provider: github` +
  `Authorization: Bearer <token>`. The server delegates validation to
  the GitHub API (`/user`, `/user/emails`, org membership per
  `AUTH_ALLOW`). Intended for CI / human operators against prod.
- `GITHUB_TOKEN` env var → identical to `--token` when neither
  `--user` nor `--token` is passed. Documented fallback so CI can set
  the secret once and reuse it across invocations.

Mutual exclusion is enforced in `packages/sdk/src/cli/upload.ts`
before the build step so that conflicting auth inputs never cause an
upload request and never waste a build:

- `--user` and `--token` together → `Error("user and token are
  mutually exclusive…")`.
- `--user` and `GITHUB_TOKEN=…` together → `Error("user and
  GITHUB_TOKEN are mutually exclusive…")`.

Both checks run *before* `await build(...)` so a misconfigured caller
sees the error immediately and the build artefacts are not produced.
This ordering was tightened to resolve a prior
env-var-read-after-build bug in which `GITHUB_TOKEN` was resolved
only after the Vite build completed — the build ran even when the
credentials would have been rejected.

The CLI also performs bundle sealing (see §5 workflow-secret-key
management) against `GET /api/workflows/:owner/public-key`, which
uses the same auth pair; if `--user` and `--token` disagree the
public-key fetch would fail before the upload ever ran, but the
mutual-exclusion check in front of `build()` gives the clearer error.

No CLI path reads or logs `Authorization`, `GITHUB_TOKEN`, or the
`WFE_WORKFLOW_SECRET_KEY` sealing password; failures surface the
HTTP status and server-reported error message only.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-A1 | The `local` provider exists for local development; a production deployment that sets both `LOCAL_DEPLOYMENT=1` AND adds a `local:<name>` entry to the prod `AUTH_ALLOW` GH variable would register it. Prod terraform never sets `LOCAL_DEPLOYMENT`, prod's `AUTH_ALLOW_PROD` is GitHub-only, and the runtime `warn`-logs the `local` provider at startup. Both gates are visible and require an explicit operator action to breach. | A5 | Mitigated by operational discipline, registry gate, and startup logs |
| R-A2 | No caching of `/api/*` token validation — every `/api/*` request makes a live GitHub API call. UI soft-TTL refresh is 10 min; the API has no equivalent. Exposes the application to GitHub availability and rate limits (A7, A8). | Medium | Design follow-up |
| R-A3 | Session refresh is fail-closed: during a GitHub outage, `/dashboard` and `/trigger` become unreachable for any session past its 10-minute soft TTL. Accepted tradeoff — matches `/api/*` behaviour and avoids serving stale allow-list decisions. | Medium | Accepted |
| R-A5 | Stale-allowlist exposure is bounded by the soft TTL (≤10 min) rather than the hard TTL (7 d), because `allow()` is re-evaluated on every refresh. An attacker with a just-removed session cookie retains access for at most one soft-TTL window. | Low | Accepted |
| R-A6 | No explicit request / response logging policy for `Authorization` headers, session cookies, or the `GITHUB_OAUTH_CLIENT_SECRET`. Nothing guarantees they are redacted from pino logs. | Medium | Verify logger config |
| R-A7 | GitHub OAuth is the only production identity provider — no MFA enforcement beyond what GitHub offers. The `local` provider is development-only and gated on `LOCAL_DEPLOYMENT=1`. | Accepted | By design |
| R-A8 | The dashboard has state-changing forms (upload, logout). Logout is POST-only; uploads go to `/api/*` which is Bearer-only (no cookie accepted). CSRF surface on the cookie path is limited to logout; CSRF surface on `/api/*` does not exist because the cookie is never read there. | Low | Accepted |
| R-A9 | Pod restart (deploy, eviction, OOM) invalidates every session because the sealing password is in-memory. Deploy-frequency–driven forced re-logins are the UX cost. Moving the password to a shared mechanism is required before `replicas > 1` (A15). | Low | Accepted |
| R-A10 | The sealed session cookie carries the GitHub access token at rest in the browser. HttpOnly prevents JS access; the scope granted is `user:email read:org`, so the blast radius of a cookie exfiltration is read-only user metadata. A caller who extracts the browser cookie store can act as the user for up to 7 d (hard TTL) or until they refresh against GitHub. | Medium | Accepted |
| R-A14 | Unchanged from prior revisions; `EventStore.query(owner)` pre-binds the owner predicate. | High | **Resolved** |

### Rules for AI agents

1. **NEVER add a new authenticated UI prefix (under `/dashboard`,
   `/trigger`, or a new route) without wiring `sessionMiddleware`
   into its middleware factory.** The `sessionMw` option on
   `dashboardMiddleware` and `triggerMiddleware` is the enforcement
   hook; a new factory that forgets to mount it leaves the prefix
   unauthenticated.
2. **NEVER add a route under `/api/` without `apiAuthMiddleware` in
   front of it.** The `apiMiddleware` factory in
   `packages/runtime/src/api/index.ts` mounts it for every `/api/*`
   path; the middleware reads `X-Auth-Provider`, looks up the provider
   in the registry, and delegates credential validation to
   `provider.resolveApiIdentity(req)`. New `/api/*` routes MUST go
   inside that factory.
3. **NEVER accept the session cookie on `/api/*`.** The cookie is
   UI-only by design; accepting it on the API would open a CSRF
   surface on every mutating endpoint and is explicitly out of scope
   for this design.
4. **NEVER read `X-Auth-Request-*`, `X-Forwarded-User`, or any
   forward-auth style header on any code path.** No upstream produces
   them; reading them would reintroduce the A13 threat class.
5. **NEVER log, emit, or store** the `Authorization` header, the
   `session` cookie, the `auth_state` / `auth_flash` cookies, the
   GitHub access token, the `GITHUB_OAUTH_CLIENT_SECRET`, or the
   in-memory JWE sealing password. When adding new logging, explicitly
   allowlist which request fields go to logs.
6. **NEVER persist the JWE sealing password** (disk, K8s Secret, log,
   telemetry, env var). It must be regenerated in-memory on every
   process start.
7. **NEVER skip the provider's `refreshSession` call on the soft-TTL
   refresh path.** The `sessionMiddleware` reads `payload.provider`,
   looks up the provider in the registry, and MUST call
   `refreshSession` to re-validate. The bound on stale-allowlist
   exposure for GitHub (R-A5) depends on that re-evaluation happening
   on every successful refresh. (Local sessions re-validate against
   static boot-time entries only; this is accepted dev-only behaviour.)
8. **NEVER add an `AUTH_ALLOW` token whose `<provider>` is not one of
    the registered providers.** Unknown prefixes MUST fail startup
    config validation with a diagnostic identifying the token. The
    `local` provider is only registered when
    `process.env.LOCAL_DEPLOYMENT === "1"`, so `local:*` entries
    outside local dev produce the same `unknown provider "local"`
    diagnostic as a typo.
9. **NEVER register the `LocalProvider` unless
    `process.env.LOCAL_DEPLOYMENT === "1"`.** The gate lives in the
    `buildProviderFactories` function in
    `packages/runtime/src/auth/providers/index.ts`; do not bypass it
    for tests. Tests that need an authenticated baseline MUST use the
    `withTestUser` helper from
    `packages/runtime/src/auth/test-helpers.ts`, which stubs
    `c.set("user", …)` directly without touching the registry.
10. **NEVER persist a `SessionPayload`
    (`packages/runtime/src/auth/session-cookie.ts`) without a required
    `provider: "github" | "local"` field.** Old payloads lacking the
    field MUST fail to unseal so the request gets redirected to
    `/login` and re-authenticates — this is what bounds the blast
    radius of the schema change to a one-time forced re-login.
11. **NEVER trust the `X-Auth-Provider` request header as identity.** It
    only selects which provider's `resolveApiIdentity` is invoked. The
    selected provider's `resolveApiIdentity` MUST validate the actual
    credential (Bearer token for `github`, `User <name>` scheme for
    `local`) before returning a `UserContext`. A request with a valid
    `X-Auth-Provider` and no / wrong credential MUST be rejected 401.
12. **NEVER add a silent short-circuit for auth in development.** The
    only supported dev authentication path is the `local` provider,
    gated on `LOCAL_DEPLOYMENT=1` and requiring an explicit
    `local:<name>` entry in `AUTH_ALLOW`. Do not introduce new implicit
    bypasses (env checks, `NODE_ENV`, debug flags).
13. **Credentials and session cookies live at different transports
    of the same identity model.** Share `UserContext`, share the
    registry, share `isMember()` — but never accept one transport's
    credential where the other is expected.
14. **NEVER read or list workflow or invocation-event data without an
    `(owner, repo)` scope.** `EventStore.query(scopes)` is the only
    scoped read API; every call site MUST build `scopes` via
    `resolveQueryScopes(user, registry, constraint?)`. Passing raw URL
    segments as a `Scope` is forbidden — middleware is the policy
    boundary. For workflows, route through `WorkflowRegistry`, which
    is keyed by `(owner, repo)`. Format validation of an owner or repo
    identifier (the regexes) is NOT a permission check and does NOT
    substitute for a scoped query (A14, R-A14, §1 I-T2).
15. **NEVER enforce the `:owner` / `:repo` authorization invariant
    inline in a route handler.** `requireOwnerMember()` is the sole
    enforcement point and MUST be mounted on every subpath that accepts
    an `:owner` (with optional `:repo`) path parameter (today:
    `/api/workflows/:owner/:repo`, `/trigger/:owner`,
    `/trigger/:owner/*`, `/dashboard/:owner`, `/dashboard/:owner/*`).
    Inline `validateOwner(owner)` / `validateRepo(repo)` +
    `isMember(user, owner)` / `ownerSet(user).has(owner)` checks in
    handlers are prohibited — they are the drift source the middleware
    exists to prevent.

### File references

- AuthProvider interfaces: `packages/runtime/src/auth/providers/types.ts`
- Provider registry: `packages/runtime/src/auth/providers/registry.ts`
- Provider factory wiring + `LOCAL_DEPLOYMENT` gate: `packages/runtime/src/auth/providers/index.ts`
- GitHub provider: `packages/runtime/src/auth/providers/github.ts`
- Local provider (dev-only): `packages/runtime/src/auth/providers/local.ts`
- Test helper (stubs `c.set("user", …)` without registry): `packages/runtime/src/auth/test-helpers.ts`
- In-memory sealing password: `packages/runtime/src/auth/key.ts`
- Session cookie seal/unseal + TTLs (payload includes `provider`): `packages/runtime/src/auth/session-cookie.ts`
- State cookie seal/unseal + returnTo sanitiser: `packages/runtime/src/auth/state-cookie.ts`
- Flash cookie seal/unseal: `packages/runtime/src/auth/flash-cookie.ts`
- Session middleware (dispatches refresh via `payload.provider`): `packages/runtime/src/auth/session-mw.ts`
- Provider-agnostic `/login` + `POST /auth/logout`: `packages/runtime/src/auth/routes.ts`
- GitHub API client (typed): `packages/runtime/src/auth/github-api.ts`
- API auth dispatcher (`X-Auth-Provider` → provider.resolveApiIdentity): `packages/runtime/src/api/auth.ts`
- Owner predicate + regex: `packages/runtime/src/auth/owner.ts`
- Owner-authorization middleware: `packages/runtime/src/auth/owner-mw.ts`
- Deny banner template: `packages/runtime/src/ui/auth/login-page.ts`
- Config / env (AUTH_ALLOW, OAuth creds, BASE_URL): `packages/runtime/src/config.ts`
- App wiring (route ordering): `packages/runtime/src/main.ts`
- Owner predicate: `packages/runtime/src/auth/owner.ts`
- App route mounting (in-app, no edge auth): `packages/runtime/src/main.ts`
- OpenSpec spec: `openspec/specs/auth/spec.md` (created by change `replace-oauth2-proxy`)
- OpenSpec spec: `openspec/specs/runtime-config/spec.md`

## §5 Infrastructure and Deployment

### Trust level

**INTERNAL** — components that run on the single Scaleway VPS, isolated from the public Internet by the host firewall and by binding only to loopback. "Internal" is **not** a substitute for authentication: a compromised container, a misconfigured firewall rule, or a host kernel exploit can reach everything else on the box.

This section describes the production target: a single Scaleway VPS running rootless Podman + systemd Quadlet, with Caddy and two app instances (prod + staging) as long-running units. There is no Kubernetes; there is no shared cluster. See `openspec/specs/infrastructure/spec.md` and `openspec/specs/host-security-baseline/spec.md`.

### Entry points

| Component | Exposure | Port | User | Who can reach it |
|---|---|---|---|---|
| Caddy (HTTPS) | Public | 443/tcp | `deploy` (rootless Podman, sysctl-permitted bind) | Internet |
| Caddy (HTTP) | Public | 80/tcp | `deploy` | Internet — Caddy serves the LE HTTP-01 challenge and 301-redirects everything else to HTTPS |
| sshd | Public | configurable (default 2222) | system | Internet — keys-only, `AllowUsers deploy`, fail2ban-protected |
| App `wfe-prod` | Loopback only | `127.0.0.1:8081` → container `:8080` | `deploy` (rootless Podman) | Caddy (loopback) |
| App `wfe-staging` | Loopback only | `127.0.0.1:8082` → container `:8080` | `deploy` (rootless Podman) | Caddy (loopback) |
| DuckDB | Process-local | — | — | One app process only (in-memory + on-disk catalog at `/srv/wfe/<env>/`) |
| GitHub API | External egress | 443 | — | App containers (OAuth handshake + token validation) |
| ghcr.io | External egress | 443 | — | `podman-auto-update.timer` (registry HEAD + image pull) |
| Let's Encrypt ACME | External egress | 443 | — | Caddy (issuance + renewal) |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| I1 | A secret env file is leaked via logs, host backups (none yet — see R-I7), or operator misclick | Information disclosure |
| I2 | An attacker reaches the app loopback port `:8081` / `:8082` directly, bypassing Caddy (would require host-side compromise — public ports are firewalled; only Caddy binds 80/443) | EoP (note: no code path reads `X-Auth-Request-*`; forged-header injection is not a vector — see §4 A13) |
| I3 | A compromised container or action (via SSRF, §2) reaches cloud metadata or internal admin APIs | Information disclosure / EoP |
| I4 | App container runs with unnecessary capabilities, a writable root filesystem, or as the host root user | EoP |
| I5 | No per-Quadlet resource limits → a runaway app crowds out the other env or Caddy | DoS |
| I6 | OAuth2 client secret or SSH private key committed to `.tfvars` or rendered into tofu state | Information disclosure |
| I7 | Caddy accepts weak TLS ciphers or outdated TLS versions | Tampering / eavesdropping |
| I8 | Self-signed dev cert served in production by mistake | Spoofing |
| I9 | The `deploy` SSH key (held by GitHub Actions) is leaked, granting shell + scoped systemctl on the production VPS | EoP |
| I10 | Events stored on local disk in plaintext, containing secrets that leaked via action env vars | Information disclosure |
| I11 | Host kernel exploit escapes the rootless Podman boundary, granting host root and crossing the prod ↔ staging trust line (now enforced only by the kernel, not by namespace isolation) | EoP |
| I12 | An attacker brute-forces `deploy` over SSH on the non-default port | EoP |
| I13 | Bad Quadlet content (e.g. `Volume=/:/host`) committed to the repo lands on the box on the next `apply-infra` with no admission-time policy gate | EoP |

### Mitigations (current)

The full posture is captured in `openspec/specs/host-security-baseline/spec.md`. Highlights:

- **Rootless Podman + per-Quadlet subuid mapping** — every container (Caddy, `wfe-prod`, `wfe-staging`) runs as the unprivileged `deploy` user mapped through its own subuid range (`/etc/subuid`). The `deploy` user is not a member of `wheel`, `sudo`, or `docker`. Mitigates **I4**, partially **I11**.
- **Host firewall default-deny inbound** — `ufw` configured with `default deny incoming`; only `80/tcp`, `443/tcp`, and the configured non-default SSH port are reachable from the Internet. Mitigates **I2**, **I3**, **I12** (port 22 is closed).
- **App ports bind only to loopback** — `wfe-prod.container` and `wfe-staging.container` use `PublishPort=127.0.0.1:<port>:8080`. The host firewall would already block external access on those ports, but loopback-only is defence in depth. Mitigates **I2**.
- **Per-Quadlet `MemoryMax=` ceilings** — each app unit caps at `700M`, Caddy at `128M`. A runaway workload OOM-kills its own unit, not its neighbour. Mitigates **I5**.
- **Non-default SSH port** — `Port 2222` (configurable). Eliminates ~99 % of drive-by botnet noise; not a security boundary by itself. Mitigates noise component of **I12**.
- **sshd hardening** — `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `AllowUsers deploy`, `MaxAuthTries 3`, `LoginGraceTime 20s`. Mitigates **I12**.
- **`fail2ban` sshd jail** — 5 failed auths in 10 min → 1-hour ban at the firewall. Mitigates residual **I12** after the above.
- **Scoped NOPASSWD sudo** — `/etc/sudoers.d/deploy` lists each `systemctl <verb> <unit>.service` combination explicitly. No wildcards, no `ALL`. The `deploy` user cannot edit `/etc/`, install packages, or read root-owned files without the root password (which is set, stored in the operator's password manager, used only in genuine emergencies). Mitigates lateral movement after I9.
- **Secret env file modes** — `/etc/wfe/<env>.env` is `0600` `deploy:deploy`; the parent directory `/etc/wfe/` is `0700` `deploy:deploy`. Quadlet `EnvironmentFile=` reads them at unit-start time. Mitigates **I1** at rest.
- **Secrets never enter tofu state** — the `null_resource.wfe_env_file` resource uses `provisioner "file"` with `source = "/tmp/wfe-secrets/<env>.env"` (a runner-local path); only the file's md5 hash and the path string land in state. The bytes are streamed over the encrypted SSH channel and written directly to the host filesystem. The secret-rendering step in `apply-infra.yml` writes via `umask 077` heredoc with no `set -x`. Mitigates **I6**.
- **Public ghcr image** — `workflow-engine` is a public package on ghcr.io; no PAT lives on the VPS. `podman-auto-update` performs anonymous registry HEADs and pulls.
- **TLS at Caddy** — public traffic is HTTPS-only on `:443`. Port 80 serves only the LE HTTP-01 challenge and a 301 to HTTPS. Mitigates **I7**, **I8**.
- **Caddy-managed Let's Encrypt** — ACME state persists on the host bind mount `/srv/caddy/data` so cert + account survive container restarts and image upgrades.
- **Distroless non-root base image** — the application image runs as UID 65532 on `gcr.io/distroless/nodejs24-debian13`. No shell, minimal userspace. (`infrastructure/Dockerfile`)
- **Image identity baked in at build time** — the Dockerfile takes `ARG GIT_SHA` and exports `ENV APP_GIT_SHA=$GIT_SHA`. `/readyz` returns this value as `version.gitSha`, which the deploy GHA polls until `=== ${{ github.sha }}` to confirm the auto-update timer has rotated to the new image before running `wfe upload`. Mutable `:release`/`:main` tags are made auditable by branch-protected git history (no force-push on `release`).
- **`Secret` wrapper for env-sourced sensitive fields** — the runtime config schema wraps every secret field in a `Secret` value. `toJSON`, `toString`, and `util.inspect` all return `"[redacted]"`; `reveal()` is the single exit, called only at the boundary that hands cleartext to the receiving client. Mitigates **I1** in the running process. (`packages/runtime/src/config.ts` — `createSecret`)
- **`tofu apply` is operator-driven, never CI-driven** — `apply-infra` is `workflow_dispatch`-only. No PR merge, push, or schedule can ship a Quadlet edit. A bad Quadlet committed to the repo cannot reach the box without a human running apply. Mitigates **I13**.
- **Unattended security upgrades** — Debian's `unattended-upgrades` applies CVE patches automatically from the security suite. Reduces window for **I11** (kernel/runtime exploits).
- **JSON-serializer `toJSON()` contract**: the `Secret` wrapper depends on the in-use JSON serializer honoring `toJSON()`. Verified for pino (current logger). Any future change to the log transport must re-verify redaction before merging.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-I3 | Per-Quadlet `MemoryMax=` ceilings (700M per app, 128M for Caddy) cap memory use; the host has 2 GB physical RAM. CPU is shared (no `CPUQuota=` set yet — could be added if a noisy-neighbour symptom appears). | I5 | **Resolved** for memory; CPU defence-in-depth deferred |
| R-I7 | **No encryption at rest.** Event-store and bundle data live on the local Scaleway block volume in plaintext. A snapshot dump or VPS-loss-with-disk-recovery exposes everything. | I10 | Out of scope for v1; see §2 R-S6 |
| R-I8 | **No secret-management integration** (Vault, SOPS, external-secrets). Secrets are GitHub Actions secrets piped through tofu's `file` provisioner with `source =` so they never enter state, but they do live in GHA. | I6 | Acceptable; GHA's secret store is the standard pattern |
| R-I12 | **AWS-SDK-shaped error messages** in unrelated code paths may contain credential identifiers verbatim. Low impact (key ID alone cannot authenticate). | I1 partial | Accepted |
| R-I13 | **App is structurally single-process per env** because the session-sealing password lives in memory (`packages/runtime/src/auth/key.ts`). Each env has exactly one Quadlet unit; there is no orchestrator that could spawn a second concurrent process. The constraint is now enforced by the deployment shape itself, not by policy. Adding a second concurrent app process for the same env is a structural change requiring a session-key migration. See §4 A15 and the `auth` spec's "Single-replica invariant" requirement. | I-auth | Accepted (structural) |
| R-I15 | **Silent invocation loss on sustained storage outage.** When DuckLake commit retries are exhausted (default 5 attempts, ~30 s exponential backoff), the EventStore logs `event-store.commit-dropped` and evicts the invocation from RAM. The runtime continues serving (does not exit), trading durability for availability under transient backend pressure. Observable via the structured log stream. SIGKILL/OOM/kernel-panic during an in-flight invocation also loses everything in the in-memory accumulator (no per-event WAL); SIGTERM still drains gracefully. See `event-store/spec.md` § "Bounded retry then drop on commit failure". | I10 (loss of audit trail) | Accepted |
| R-I16 | **No backups.** Local-disk persistence at `/srv/wfe/<env>` and Caddy's ACME state at `/srv/caddy/data` have no off-box copy. A VPS-loss event is total data loss for both envs until users re-upload bundles via `wfe upload`. | I-data-loss | **High priority follow-up** — track as a separate change adding restic snapshots to a small bucket |
| R-I17 | **No rollback strategy.** Cutover is one-way; if `apply-infra` produces a broken state, the only recovery is fix-forward. Mitigated by the apply being operator-driven (no automatic mutation in CI) and by `apply-infra` supporting partial re-runs (Quadlet edit → restart without re-provisioning). | I-availability | Accepted |
| R-I18 | **Host kernel is the only isolation boundary between prod and staging.** Both run as `deploy`-mapped subuids on the same host; a kernel privilege-escalation CVE crosses the trust line. Mitigated by `unattended-upgrades` keeping the kernel patched. | I11 | Accepted |
| R-I19 | **`deploy` SSH private key is a high-value GHA secret.** Leak yields shell + scoped systemctl on production. Mitigated by scoped sudo (no broad host edits possible), key rotation on a 90-day cadence (operator runbook), and the absence of an SSH path that allows arbitrary commands. GH OIDC → short-lived SSH cert is a v2 follow-up if the threat model warrants. | I9 | Accepted |
| R-I20 | **No admission-time policy enforcement** for Quadlet content. A bad commit (e.g. `Volume=/:/host:rw`) cannot ship without a human running `apply-infra`, which is the gate. PR review is the only check between repo and box. | I13 | Accepted (operator gate is the control) |

### Production deployment notes

The current production target is a single Scaleway VPS. Posture summary:

1. **Host firewall** — DONE. `ufw` default-deny inbound; only 80/tcp, 443/tcp, and the configured non-default SSH port are open. Resolves the perimeter half of I2 / I3 / I12.
2. **Rootless Podman + per-Quadlet subuids** — DONE. All workloads run as the `deploy` user mapped through container-private subuid ranges. Mitigates I4 / I11.
3. **Per-Quadlet resource limits** — DONE for memory (`MemoryMax=` per unit). CPU pinning is deferred — add `CPUQuota=` if a noisy-neighbour symptom appears. Resolves R-I3.
4. **Real TLS** — DONE. Caddy obtains and renews Let's Encrypt certs via HTTP-01 ACME; state lives on the host bind mount `/srv/caddy/data`. Resolves I7 / I8.
5. **Sandbox egress** — `hardenedFetch` (§2 R-S4) blocks RFC1918 and metadata egress at the app layer. Internal SSRF (S5) is mitigated end-to-end. Public-URL allowlist for exfiltration (S8 / §2 R-S12) remains deferred.
6. **Backups** — **NOT YET.** R-I16 is the highest-priority follow-up. Until added, treat the VPS as the sole copy of every event-store row and bundle.
7. **Secret rotation procedure** — to rotate `GITHUB_OAUTH_CLIENT_SECRET`: update the GHA secret, re-run `apply-infra`. The `null_resource.wfe_env_file` `filemd5` trigger detects the change and the `remote-exec` provisioner restarts the affected unit. The in-memory session-sealing password rotates implicitly on every container restart (which happens on every secret rotation, and on every auto-update tick).
8. **SSH key rotation** — rotate `TF_VAR_DEPLOY_SSH_PRIVATE_KEY` + `TF_VAR_DEPLOY_SSH_PUBLIC_KEY` together every 90 days (or on suspected compromise). The new key takes effect on the next `apply-infra` (cloud-init re-runs the deploy-user authorized_keys write). Old key is invalidated as soon as the new authorized_keys lands.

### Rules for AI agents

1. **NEVER commit a `.tfvars` file containing real secrets.** Use the GHA-secret → `apply-infra` workflow path. If a local `.tfvars` is needed for ad-hoc operator runs, it MUST be `.gitignore`d.
2. **NEVER open a new inbound port** on the host firewall (`ufw`). The public surface is currently exactly `80`, `443`, and the configured SSH port. Adding a new public port requires §3 / §4 treatment.
3. **NEVER add an app `PublishPort=` that binds anywhere other than `127.0.0.1`.** App units MUST publish on loopback only; Caddy is the sole `0.0.0.0` listener.
4. **NEVER use the `file` provisioner with `content =` for secrets.** Use `source = "<runner-local-path>"` so bytes never enter tofu state. The single resource pattern is `null_resource.wfe_env_file` in `infrastructure/apps.tf`. Do not introduce alternatives.
5. **NEVER use `local_sensitive_file` or `remote-exec` with `inline = ["echo '${secret}' > ..."]`** — both persist secret bytes in state.
6. **NEVER hardcode a secret** in Terraform, Quadlet templates, or container images. Secret values come from GitHub Actions secrets, render to `/tmp/wfe-secrets/<env>.env` on the runner, copy via the file-provisioner pattern (Rule 4) to `/etc/wfe/<env>.env` (mode 0600), and arrive in the container via `EnvironmentFile=/etc/wfe/<env>.env`. Non-secret config (`AUTH_ALLOW`, `BASE_URL`, `AUTH_PROVIDER`, log levels) is rendered into the same env file but is also acceptable in plain Quadlet `Environment=` lines.
7. **NEVER downgrade to HTTP** for any route. Cookies rely on `COOKIE_SECURE=true`; serving plain HTTP breaks session security.
8. **NEVER add or broaden a sudoers rule** for `deploy` beyond the explicit allowlist in `infrastructure/cloud-init.yaml`. No wildcards, no `ALL`. If a new privileged operation is genuinely needed, name the exact `systemctl <verb> <unit>.service` form and justify it in the PR.
9. **NEVER add a new environment variable that holds a secret without wrapping it in `Secret`.** The end-to-end chain is:
   (a) add the secret to GHA secrets and reference it in `apply-infra.yml`'s heredoc that renders `/tmp/wfe-secrets/<env>.env`;
   (b) the `null_resource.wfe_env_file` `filemd5` trigger detects the change automatically (no edit needed there);
   (c) in the runtime config schema, compose the field's Zod schema with `.transform(createSecret)` so the value self-redacts on `JSON.stringify`, `String()`, and `util.inspect` (canonical examples: `GITHUB_OAUTH_CLIENT_SECRET` in `packages/runtime/src/config.ts`);
   (d) reveal only at the boundary that hands the cleartext to the receiving client; never log the cleartext.
10. **Assume "internal" is not a perimeter.** Any new component on the box must justify its own auth / isolation story, not rely on "it's only on the loopback".
11. **When adding a new long-running workload**, add a Quadlet `.container` template under `infrastructure/files/`, render it from a `null_resource` in the appropriate `.tf` file, set `MemoryMax=` and bind to `127.0.0.1` (unless it's a public-facing ingress). Containers MUST run rootless under the `deploy` user; never set `User=root` or use `--privileged`.
12. **NEVER raise the per-env app process count above 1** without first migrating the auth sealing password out of in-memory state (see §4 A15, R-I13, and the `auth` capability's "Single-replica invariant" requirement). The constraint is structurally enforced by having one Quadlet unit per env — a change that adds a second concurrent process for the same env (HPA-equivalent, second `wfe-prod-2.container`, etc.) silently breaks auth.
13. **NEVER read `X-Auth-Request-*`** on any code path (see §4 A13). The forward-auth mechanism that produced those headers does not exist; reading them reintroduces the forged-header class.

### Workflow secret-key management

Owner-authored workflows may declare sealed env bindings (`env({name, secret: true})` per the `workflow-secrets` change). The server holds an X25519 keypair list in the `SECRETS_PRIVATE_KEYS` env var; the public key is derivable from any secret key via `crypto_scalarmult_base` and is exposed by `GET /api/workflows/:owner/public-key` so the CLI can seal values before upload. Decryption happens twice: once at upload for fail-fast validation, and once per invocation inside the executor to hand plaintexts to the future consumer plugin. Plaintext bytes are `fill(0)`-wiped after use and never logged.

**Key location.** The `SECRETS_PRIVATE_KEYS` value is generated by the operator (e.g. `openssl rand -base64`-style) and stored as a GHA secret per env (`SECRETS_PRIVATE_KEYS_PROD`, `SECRETS_PRIVATE_KEYS_STAGING`). `apply-infra.yml` writes it into the corresponding `/tmp/wfe-secrets/<env>.env` heredoc; tofu's file-provisioner copies it to `/etc/wfe/<env>.env` on the VPS. The bytes never enter tofu state. Rotating the key list rotates the GHA secret + re-runs `apply-infra`.

**Rotation.** Prepend a new id to the env's `SECRETS_PRIVATE_KEYS` value (comma-separated keypair list), update the GHA secret, re-run `apply-infra`. New uploads seal against the new primary; existing bundles still decrypt against retained keys. Retire an old id only once no uploaded bundle references it — the upload decrypt-verify fails fast with `unknown_secret_key_id` when an owner's bundle references a retired keyId.

**Security property.** The app container is the only place the secret key material exists in plaintext. The on-disk persistence (`/srv/wfe/<env>/`) sees only ciphertexts. The `/etc/wfe/<env>.env` file holds the keys at mode 0600 owned by `deploy`. The `Secret` wrapper (`createSecret()`) redacts `SECRETS_PRIVATE_KEYS` from any log or JSON serialization.

### Trigger-config secret references

Workflow authors may reference a sealed secret inside a trigger's configuration (e.g. `cronTrigger({ schedule: wf.env.SECRET_SCHEDULE })`, or future consumers like IMAP credentials, HMAC-webhook signing keys). At build time the SDK's `resolveEnvRecord` emits a shared-format sentinel string `\x00secret:NAME\x00` (from `@workflow-engine/core`'s `encodeSentinel`) wherever `wf.env.<SECRET>` appears in author source. The sentinel survives the `wf.env` record into trigger descriptors and through the manifest serialization; `wfe upload` seals the corresponding env values into `manifest.secrets` exactly as it does for handler-body secrets.

At workflow-registration time, the runtime registry decrypts `manifest.secrets` (via the existing `decryptWorkflowSecrets` helper) and walks every trigger descriptor, replacing every `\x00secret:NAME\x00` occurrence with the corresponding plaintext before dispatching entries to each `TriggerSource.reconfigure(owner, repo, entries)`. A sentinel whose name is not present in the decrypted store fails the entire workflow's registration with a structured `secret_ref_unresolved` error — HTTP 400 at upload, per-workflow skip during persistence replay (other workflows recover normally).

**Plaintext surface.** This flow places decrypted secret plaintext on the **main thread**, not only inside the sandbox worker. Plaintext lives:

- transiently inside `packages/runtime/src/triggers/resolve-secret-sentinels.ts`'s deep-walk call stack,
- inside the resolved descriptor objects passed to `TriggerSource.reconfigure`,
- inside each `TriggerSource` implementation's long-lived in-memory state (e.g. the cron source's schedule string bound into its timer, a future IMAP source's credentials held by an open connection, a future HMAC verifier's signing key in a closure),
- and — unavoidably — wherever a third-party trigger-backend library stashes it (socket buffers, connection objects, internal caches).

Engine-level lifetime guarantees end at the `TriggerSource` → third-party-library boundary; memory handling inside a library is out-of-scope.

The worker-side `secrets` plugin's outbound scrubber (§2) continues to redact plaintext literals from `WorkerToMain` messages, but does not help here: `TriggerSource` implementations run main-side and never cross that boundary. The invariants below are therefore enforced only by code review and by the confinement rule.

### Rules for AI agents

Additional main-thread secrets rules on top of the K8s-centric rules above:

10. **NEVER log, emit, serialise, or include decrypted secret plaintext on the main thread** in:
    - log lines (any level, any logger),
    - event payloads published on the bus (including `trigger.request`, `trigger.response`, `trigger.error`),
    - error messages, `Error.cause` chains, or stack traces formatted for user display,
    - HTTP response bodies, headers, or server-sent-event streams,
    - dashboard rendered output,
    - any code path whose purpose is not to implement a `TriggerSource` backend.
    Plaintext is permitted (a) transiently inside `resolveSecretSentinels` and the resolved entries it hands to `reconfigure`; (b) inside `TriggerSource` instance state set via `reconfigure`; (c) at the boundary where a `TriggerSource` hands a value to a third-party library — memory-lifetime past that boundary is explicitly out-of-scope.
11. **NEVER call `TriggerSource.reconfigure` with entries that contain unresolved `\x00secret:NAME\x00` sentinels.** Resolution SHALL go through `packages/runtime/src/triggers/resolve-secret-sentinels.ts`. `TriggerSource` implementations MUST NOT parse or pattern-match sentinels themselves.
12. **NEVER re-implement the `\x00secret:NAME\x00` encoding.** All producers (the SDK's build-time env resolver) and all consumers (the runtime's main-side trigger-config resolver) MUST import `encodeSentinel` and `SENTINEL_SUBSTRING_RE` from `@workflow-engine/core`. The worker-side plaintext scrubber is a separate mechanism keyed on plaintext bytes (not sentinels) and is not a consumer of this format.

### Imap trigger source addenda

13. **Imap-source plaintext credential carve-out.** The imap `TriggerSource` (`packages/runtime/src/triggers/imap.ts`) is permitted to hold the resolved IMAP `user` and `password` plaintext on its long-lived per-entry descriptor state (and to pass them into `ImapFlow`'s `auth.user` / `auth.pass` per poll). This mirrors the existing carve-out for the cron source's resolved schedule string and is covered by Rule 10's `(b)` clause ("inside `TriggerSource` instance state set via `reconfigure`"). The constructed `ImapFlow` auth object's lifetime past `client.logout()` falls under the `(c)` third-party-library boundary clause.

14. **No sentinel resolution on handler outputs.** The imap source MUST NOT run `resolveSecretSentinels` (or any equivalent walk) over the handler's returned `{ command?: string[] }` envelope or over any value originating from `entry.fire`'s output. Sentinel substitution applies only to manifest-sourced strings consumed at `reconfigure` time. Treating handler output as a sentinel-bearing surface would re-introduce sealed plaintext into runtime-author-controlled code paths that the threat model excludes.

15. **`auth-failed` log lines may echo credentials.** When IMAP authentication fails, the imap source surfaces the server's response text (including any `imapText` field) via `deps.logger.warn` with `reason: "auth-failed"`. (Per the Group 5 deviation noted in `add-imap-trigger/tasks.md` §5.5, source-level failures are logged rather than emitted as `trigger.error` events.) A misbehaving IMAP server that echoes LOGIN arguments in its `NO`/`BAD` response text could therefore leak the plaintext password into the structured log stream. This is a documented tradeoff in favour of operator debugging — a generic "auth failed" without server text is markedly harder to triage against the long tail of real-world IMAP server quirks. Operators MUST treat the runtime log stream as credential-grade when imap triggers are in use.

### File references

- Server + IP + firewall: `infrastructure/main.tf`
- Cloud-init (deploy user, sshd, sudoers, ufw, fail2ban, sysctl, podman-auto-update timer override): `infrastructure/cloud-init.yaml`
- App Quadlets + env-file delivery: `infrastructure/apps.tf`, `infrastructure/files/wfe.container.tmpl`
- Caddy Quadlet + Caddyfile: `infrastructure/caddy.tf`, `infrastructure/files/caddy.container.tmpl`, `infrastructure/files/Caddyfile.tmpl`
- Dynu A records: `infrastructure/dns.tf`
- Apply workflow (operator): `.github/workflows/apply-infra.yml`
- Plan gate: `.github/workflows/plan-infra.yml`
- Build + push (no infra side effects): `.github/workflows/deploy-prod.yml`, `.github/workflows/deploy-staging.yml`
- Dockerfile: `infrastructure/Dockerfile`
- OpenSpec specs: `openspec/specs/infrastructure/spec.md`, `openspec/specs/host-security-baseline/spec.md`

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
- Headers are uniform across all route families served by the app:
  `/livez`, `/webhooks/*`, `/api/*`, `/dashboard*`, `/trigger*`,
  `/auth/*`, `/static/*`. The OAuth handshake (`/auth/github/*`) and
  logout (`POST /auth/logout`) all render through the same
  `secureHeadersMiddleware`, so no gap exists on the auth surface.

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
  that if Alpine directives are ever added, Alpine's expression
  evaluator never reaches `new Function()` and therefore does not need
  `'unsafe-eval'` in CSP. The runtime currently ships no `x-data`
  directives and no `Alpine.data(...)` registrations — all interactive
  behaviour lives in plain JS event listeners (see next bullet) — but
  the CSP build is loaded as a guardrail so any future directive
  cannot silently require loosening CSP. If Alpine directives are
  reintroduced, any `:style` binding MUST use object form (Alpine sets
  object-form styles via `el.style.setProperty`; string form sets the
  inline `style` attribute and is blocked by `style-src 'self'`), and
  any component MUST be pre-registered via `Alpine.data(...)` in a
  `/static/*.js` file rather than inlined as an `x-data` object literal.
- **No inline handlers, scripts, or styles in rendered HTML.** All
  behaviour lives in `/static/*.js` files (currently
  `flamegraph.js`, `local-time.js`, `result-dialog.js`,
  `owner-selector.js`, `trigger-forms.js`) bound via
  `addEventListener` over `data-*` hooks on rendered HTML.
  `html-invariants.test.ts` asserts no inline `<script>`, no `on*=`
  handler attributes, no `style=` attributes, and no `javascript:` URLs
  across every HTML surface.
- **HSTS.** `Strict-Transport-Security: max-age=31536000;
  includeSubDomains` on every response in production. Gated off in
  local via `LOCAL_DEPLOYMENT=1` to prevent developer browsers from
  pinning HSTS on `localhost` (a self-signed kind cert would then
  cause unrecoverable `NET::ERR_CERT_AUTHORITY_INVALID` on any
  localhost service for a year).
- **X-Content-Type-Options: nosniff.** Prevents MIME sniffing.
- **X-Frame-Options: DENY** and **CSP `frame-ancestors 'none'`.** Two
  layers against clickjacking (H6). Gated off in local via
  `LOCAL_DEPLOYMENT=1`: `X-Frame-Options` is omitted and CSP relaxes to
  `frame-ancestors 'self' vscode-webview:` so the VS Code Simple Browser
  webview (used by the `/preview` slash command) can iframe local pages
  to support sign-in flows. Production keeps both layers intact —
  `LOCAL_DEPLOYMENT=1` is set only by `scripts/dev.ts` and the kind
  cluster, never in staging or prod.
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
   method body.** The runtime currently ships no Alpine directives;
   prefer plain `addEventListener` wiring in a new `/static/*.js`
   file, hooked to rendered HTML via `data-*` attributes (see
   `owner-selector.js`, `trigger-forms.js`). If Alpine is genuinely
   needed for a new component, register it via
   `Alpine.data('<name>', () => ({...}))` in a new `/static/*.js`
   module and reference it by bare identifier (`x-data="myComponent"`)
   — never inline the component body on the element.
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
- Static JS behaviour (plain `addEventListener` over `data-*` hooks):
  `packages/runtime/src/ui/static/{flamegraph,local-time,result-dialog,owner-selector,trigger-forms}.js`
- Static middleware (serves `/static/*` incl. vendored `alpine.js`,
  `htmx.js`, `jedison.js` from `@alpinejs/csp`):
  `packages/runtime/src/ui/static/middleware.ts`
- Local-deployment toggle: `LOCAL_DEPLOYMENT=1` env var (set by `pnpm dev` only — never on the VPS deployment)
- OpenSpec spec: `openspec/specs/http-security/spec.md`
