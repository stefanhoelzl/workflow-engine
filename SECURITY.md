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
                     │   Traefik Ingress    │  TLS termination
                     │   (websecure :443)   │
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
| 2 | Webhook ingress | **PUBLIC** (intentionally unauthenticated) | `POST /webhooks/<tenant>/<workflow>/<trigger>` | None — payload-schema validation only | §3 |
| 3 | UI / API | **AUTHENTICATED** | `/dashboard`, `/trigger`, `/login`, `/auth/*`, `/api/*` | In-app OAuth (sealed session cookie) for UI; Bearer (GitHub) for API. Both gated by `AUTH_ALLOW`. `/login` is the provider-agnostic sign-in page; `/auth/github/*` is the GitHub-specific handshake. | §4 |
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

### Tenant isolation invariants

**I-T2** — No caller (authenticated or not) SHALL read, modify, or execute
another tenant's workflows or invocation events.

Enforcement is distributed across several mechanisms; each is
load-bearing and documented in its own section or capability spec. The
table below is the navigation map:

| Data path                              | Enforcement mechanism                                       | Documented in                      |
|----------------------------------------|-------------------------------------------------------------|------------------------------------|
| `POST /api/workflows/:tenant`          | Tenant regex + `isMember(user, tenant)` gate; identical 404 | §4, threat A12                     |
| Invocation event reads                 | `EventStore.query(tenant)` pre-binds `.where("tenant", …)`  | `event-store/spec.md`              |
| Invocation event writes                | Runtime stamps `tenant` in its `sb.onEvent` receiver before forwarding to the bus (the sandbox has no tenant concept) | `executor/spec.md`, §2 R-2 |
| `POST /webhooks/:tenant/:workflow/*`   | Registry lookup by `(tenant, workflow)` pair                | §3, `http-trigger/spec.md`         |
| Workflow bundle storage                | Storage key = `workflows/<tenant>.tar.gz`                   | `workflow-registry/spec.md`        |

The regex-validated tenant identifier is NOT a permission check — it is
a format check. Every mechanism above is load-bearing; weakening any one
of them breaks I-T2. Threats that specifically target I-T2 are
enumerated in §4 (A12, A13, A14) alongside their mitigations.
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
action` (Ajv input validation, exports `validateAction` to dependents),
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
  spawns a new worker. Tenant-scoped sandbox reuse is owned by
  `SandboxStore` (`packages/runtime/src/sandbox-store.ts`), keyed by
  `(tenant, workflow.sha)`.
- `Sandbox.run(name, input)` — invokes a named export from the workflow
  module. Runtime metadata (tenant/workflow/workflowSha/invocationId) is
  NOT passed into `run` — the runtime stamps those fields on events in
  its `sb.onEvent` receiver after the sandbox emits them (see R-2 below).
- `Sandbox.onEvent(cb)` — registers a callback invoked for each
  `InvocationEvent` the worker streams. Events carry only intrinsic
  fields (`id`, `seq`, `ref`, `ts`, `at`, `kind`, `name`, `input?`,
  `output?`, `error?`). Downstream consumers see identical shape to
  pre-plugin-architecture events because the runtime stamps metadata
  post-hoc.

### Boot sequence (phases 0-5)

Every `create()` runs deterministically through:

0. Module load + WASM instantiation. Each plugin descriptor's
   `workerSource` is dynamic-imported from a `data:` URI to resolve the
   host-side `worker` function.
1. `plugin.worker(ctx, deps, config)` for each plugin in topo order;
   returns a `PluginSetup` (exports, guestFunctions, wasiHooks,
   lifecycle hooks).
2. Phase-2 evaluation of each plugin descriptor's `guestSource` IIFE
   (produced at build time by the `?sandbox-plugin` transform from the
   plugin file's optional `guest()` export). The IIFE captures private
   descriptors into closures and installs guest-facing globals (e.g.
   `globalThis.fetch`, `globalThis.console`). Descriptors without
   `guestSource` are skipped.
3. **Private-binding auto-deletion.** The sandbox iterates every
   registered `GuestFunctionDescription` and `delete globalThis[name]` for
   every entry with `public !== true`. This is structural enforcement,
   not review discipline.
4. Phase-4: user source evaluation (the tenant bundle IIFE).
5. Ready. Subsequent `run()` calls invoke exports.

Failures in any phase dispose the bridge, post `init-error`, and
`process.exit(0)`.

### Globals surface (post-init guest-visible)

The surface below is contributed by the v1 plugin catalog. Adding a new
global requires adding or extending a plugin AND extending the list here.

- From `web-platform`: `console.*` (via console plugin), `self` (identity
  shim with EventTarget), `navigator` (frozen `{userAgent}`),
  `reportError`, `queueMicrotask`, `EventTarget`, `Event`, `ErrorEvent`,
  `AbortController`, `AbortSignal`, `URLPattern`, `CompressionStream`,
  `DecompressionStream`, `scheduler`, `TaskController`, `TaskSignal`,
  `TaskPriorityChangeEvent`, `Observable`, `Subscriber`,
  `EventTarget.prototype.when`, the WHATWG Streams family, IndexedDB
  family, User Timing Level 3 entries, `structuredClone` override, and
  the fetch interfaces (`Blob`, `File`, `FormData`, `Request`, `Response`).
  Pinned polyfills: `event-target-shim@^6`, `urlpattern-polyfill@10.0.0`,
  `fflate@^0.8.2`, `web-streams-polyfill@^4.2.0`, `fetch-blob@^4.0.0`,
  `formdata-polyfill@^4.0.10`, `@ungap/structured-clone@^1.3.0`,
  `fake-indexeddb@^6.2.5`, `scheduler-polyfill@^1.3.0`,
  `observable-polyfill@^0.0.29`. Version bumps require a §2 re-audit PR.
- From `fetch`: `globalThis.fetch` (WHATWG shape around the private
  dispatcher `$fetch/do`). Default implementation closes over
  `hardenedFetch` (see R-4 below).
- From `timers`: `setTimeout`, `setInterval`, `clearTimeout`,
  `clearInterval`.
- From `sdk-support`: `__sdk` — locked via
  `Object.defineProperty(globalThis, "__sdk", {writable: false,
  configurable: false})` wrapping an `Object.freeze`d inner
  `{dispatchAction}` object. This is the sole `__`-prefixed global that
  remains on `globalThis` post-init. The underlying
  `__sdkDispatchAction` private descriptor is captured by the plugin's
  IIFE and auto-deleted in phase 3.
- **WASM extension globals** (contributed by quickjs-wasi extensions
  loaded at VM creation): `URL`, `URLSearchParams`, `TextEncoder`,
  `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`
  (including `crypto.subtle.*` with a JS Promise shim), `performance`,
  `DOMException`. These live inside WASM linear memory; they are not
  host bridges and consume no host capability.

No other globals are present. `process`, `require`, `fs`, and Node APIs
are absent.

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
  with `{fd, text}`. **`fd_write` bytes never become tenant-visible
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
sandbox does NOT know tenant/workflow/workflowSha/invocationId; those
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
| S13 | A plugin with long-lived state (timers, pending `Callable`s) fails to clean up on `onRunFinished`, leaking state across runs or firing callbacks after the run closed | Tampering (cross-run state) / DoS |
| S14 | A plugin emits events with hand-crafted `seq`/`ref`/`ts` values (via direct `bridge.*` mutation) that desync the event stream | Tampering (audit-log integrity) |

### Mitigations (current)

- **Fresh VM per workflow module load.** `QuickJS.create()` is called
  once when the workflow registry first instantiates a workflow. The VM
  is reused across `run()` calls for that workflow; module-level state
  persists across runs within the same workflow. Cross-workflow leakage
  is physically impossible: separate VMs, separate WASM memory, separate
  env records.
  (`packages/sandbox/src/index.ts`, `packages/runtime/src/sandbox-store.ts`)
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
  per-run `AbortController` aborts in-flight requests. Cleanup runs
  inside the run's refStack frame so audit events parent correctly.
- **ctx-only emission (S14).** All events flow through `ctx.emit` /
  `ctx.request`. `seq`/`ref`/`ts`/`at`/`id` are stamped internally and
  never exposed to plugin code. Direct `bridge.*` mutation from plugin
  code is prohibited by convention and reviewed per plugin (catalog is
  small — ~8 plugins).
- **Reserved event prefixes.** `trigger`, `action`, `fetch`, `timer`,
  `console`, `wasi`, `uncaught-error` are reserved for stdlib / runtime
  plugins. Third-party plugins use domain-specific prefixes to avoid
  conflating with core audit categories.
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
- **Action input validation via `host-call-action`.** Ajv validators are
  compiled per action from the manifest at plugin boot. The plugin
  exports `validateAction(name, input)`; `sdk-support` calls it inside
  `__sdk.dispatchAction` before invoking the handler. Validation
  failures throw back into the guest with the Ajv `issues` array
  preserved. Input validation is host-authoritative.
- **Action output validation host-side via `host-call-action`.** The
  plugin also exports `validateActionOutput(name, raw)`, compiled from
  the manifest's output schema. `sdk-support`'s dispatcher handler
  invokes it after `await handler(input)` resolves, on the host side,
  before returning to the guest caller. The `__sdk.dispatchAction`
  bridge takes three positional args (`name, input, handler`) — there is
  no guest-supplied `completer`, so a tampered SDK cannot substitute a
  lenient output validator. Output validation is host-authoritative,
  parallel to input validation.
- **Trigger handler output validation host-side in `buildFire`.** After
  `executor.invoke` resolves with `{ok:true, output}`, `buildFire` runs
  Ajv against `descriptor.outputSchema`. Mismatches surface as
  `{ok:false, error:{message:"output validation: …"}}` with no `issues`
  field — the HTTP source maps `no-issues → 500` (handler bug, not
  client fault). Structured per-field issues are logged via
  `trigger.output-validation-failed` for dashboards/archives.
- **Worker-thread isolation of plugin runtime.** QuickJS, plugin code,
  `hardenedFetch`, and Ajv validators all run inside a dedicated
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
| R-S4 | `hardenedFetch` is the structural default in `createFetchPlugin` (closes over it; override requires replacing the entire plugin via `__pluginLoaderOverride`, which is a test-only path). | S5 closed | **Resolved** |
| R-S5 | K8s `NetworkPolicy` on the runtime pod restricts cross-pod traffic and blocks RFC1918 + link-local egress. Defence-in-depth under R-S4. | S5 defence-in-depth | **Resolved** (see §5 R-I1 / R-I9) |
| R-S12 | **No public-URL allowlist.** Guest code can still `fetch()` any public URL the pod can reach. This mitigates S5 (internal SSRF) but leaves S8 (exfiltration to attacker-controlled public endpoint) unaddressed. Closing S8 requires a per-tenant host allowlist in the tenant manifest, enforced at upload-time + in `hardenedFetch`. | S8 deferred | **Deferred** (separate change) |
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
   wrapping an `Object.freeze`d inner object. Canonical example: `__sdk`.
   Rationale: tenant code cannot replace the dispatcher with a stub that
   bypasses `action.*` emission. Adding a new top-level host-callable
   global without this structural lock is forbidden.
3. **R-3 Hardened fetch default.** `createFetchPlugin` closes over
   `hardenedFetch` as the structural production default (scheme
   allowlist + IANA blocklist + DNS validation + redirect re-check +
   30 s timeout). Overriding requires replacing the entire plugin via
   `__pluginLoaderOverride` — a test-only path. Production composition
   MUST NOT pass a fetch override; tests that need a mock replace the
   plugin, not its default.
4. **R-4 Per-run cleanup.** Plugins with long-lived state (timers,
   pending `Callable`s, in-flight fetches, etc.) MUST implement
   `onRunFinished` to release / dispose that state. Cleanup MUST route
   through the same code paths as guest-initiated teardown so audit
   events fire (e.g. the `timers` plugin emits a `timer.clear` leaf per
   pending timer at run end). Skipping this rule leaks state across runs
   and de-correlates the event stream.
5. **R-5 ctx-only emission.** All events flow through `ctx.emit` /
   `ctx.request`. Direct `bridge.*` mutation from plugin code is
   prohibited. `seq`, `ref`, `ts`, `at`, and `id` are stamped by the
   sandbox; plugin authors never construct these fields. A plugin that
   needs a frame-producing event uses `createsFrame: true` /
   `closesFrame: true` options on `ctx.emit`; it never computes a ref
   value itself.
6. **R-6 Worker-only execution.** Plugin code executes in the Node
   worker thread exclusively. No cross-thread method calls. Plugin
   configs passed to `descriptor.config` MUST be JSON-serializable
   (verified by `assertSerializableConfig` at sandbox construction).
   Main-thread state (connection pools, persistent caches) cannot live
   in a plugin — it must be passed in as serialized config or reached
   via a descriptor-bridged guest function that the plugin registers.
7. **R-7 Reserved prefixes.** Event prefixes `trigger`, `action`,
   `fetch`, `timer`, `console`, `wasi`, and `uncaught-error` are
   reserved for stdlib / runtime plugins. Third-party plugins use
   domain-specific prefixes (e.g. `mypkg.request` /
   `mypkg.response`) to avoid conflating with core audit categories.
8. **R-8 No runtime metadata in the sandbox.** The sandbox stamps only
   intrinsic event fields: `kind`, `name`, `id`, `seq`, `ref`, `ts`,
   `at`, and `input?` / `output?` / `error?`. Tenant, workflow,
   workflowSha, and invocationId are stamped by the runtime in its
   `sb.onEvent` receiver before forwarding events to the bus. A plugin
   that needs to attach a tenant or workflow label is doing something
   wrong — that labelling belongs on the runtime side.
9. **R-9 Runtime-only dispatch provenance.** `InvocationEvent.meta` and
   every field nested under it (including `meta.dispatch`, which carries
   `{ source: "trigger" | "manual", user? }` on `trigger.request`) are
   stamped exclusively by the runtime in its `sb.onEvent` widener. The
   sandbox and plugin code MUST NOT emit, read, or construct `meta` — it
   has no guest-side entry point by design. Parallels R-8; the dispatch
   source and dispatching user are runtime concerns, never guest-visible.

Additional standing rules that predate the plugin rewrite:

- **Sandbox-related changes MUST include security tests** covering
  escape attempts, global visibility, sandbox disposal, and any new
  plugin's failure modes. Private-descriptor deletion, `__sdk` lock
  semantics, and `hardenedFetch` defaults each have dedicated probes.
- **Every new host-callable descriptor MUST validate its input** before
  acting on it (the guest's Zod copy is untrusted). `host-call-action`'s
  Ajv pipeline is the canonical pattern; new descriptors either reuse it
  or follow the same shape, and SHALL be covered by a prototype-
  pollution test.
- **When adding an outbound capability (fetch, action call, etc.),
  explicitly consider SSRF and exfiltration.** If no URL allowlist
  applies, say so in the change proposal; do not claim the sandbox
  "prevents" reaching an internal service beyond what `hardenedFetch`
  structurally blocks.

### File references

- Sandbox factory + `run()`: `packages/sandbox/src/index.ts`
- Plugin types + composition: `packages/sandbox/src/plugin.ts`,
  `packages/sandbox/src/plugin-compose.ts`
- Worker boot phases + WASI dispatch: `packages/sandbox/src/worker.ts`,
  `packages/sandbox/src/wasi.ts`
- Guest function install (arg/result marshaling, `Callable`):
  `packages/sandbox/src/guest-function-install.ts`
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
- Sandbox store (per-`(tenant, sha)` sandbox cache + plugin composition):
  `packages/runtime/src/sandbox-store.ts`
- Workflow registry (metadata + per-tenant trigger index):
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

**Cron triggers are NOT on this surface.** `cronTrigger(...)` fires from the
runtime's internal scheduler (`packages/runtime/src/triggers/cron.ts`) —
there is no external caller, no external URL, and no untrusted input crosses
a network boundary at fire time (the handler receives an empty payload `{}`).
Cron triggers are exposed only via the authenticated `/trigger` UI's
"Run now" affordance, which sits behind `sessionMiddleware` +
`requireTenantMember` (§4).

### Entry points

- `POST /webhooks/{tenant}/{workflow}/{trigger_name}` (or whatever `method` the
  trigger declares; default POST) with JSON body.
- `{tenant}` and `{workflow}` are validated against the tenant identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`); `{trigger_name}` is validated against
  the trigger-name regex (`^[A-Za-z_][A-Za-z0-9_]{0,62}$`); non-matching values
  receive 404.
- Trigger segment matching is **exact**: the URL MUST be exactly three
  regex-constrained segments after `/webhooks/`. No URLPattern, no `:param`
  named segments, no `*wildcard` tail segments. Lookup is a constant-time
  `Map.get()` keyed by `(tenant, workflow, trigger-name)`
  (`packages/runtime/src/triggers/http.ts`). Query strings on the URL are
  tolerated for compatibility with providers that append tracking params
  (AWS signatures, delivery IDs) but are **not parsed** into any structured
  field on the handler's payload.
- Request data delivered to the trigger handler as the `payload`
  argument:

  ```typescript
  { body, headers, url, method }
  ```

  `body` is a JSON-parsed object validated against the trigger's JSON
  Schema (Ajv) before the sandbox is entered. `headers`, `url`, and `method`
  are attacker-controlled metadata — the sandbox sees them as data, not as
  authentication. A handler that needs a query-string value SHALL parse it
  explicitly via `new URL(payload.url).searchParams` and treat the result
  as untrusted.

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
- **Sole invocation path is `entry.fire(input)`.** The HTTP middleware's
  only job after URL routing is to normalize the request into an
  `input` object and call `entry.fire(input)` on the matched
  `TriggerEntry`. The `fire` closure is built by the `WorkflowRegistry`
  (see `packages/runtime/src/triggers/build-fire.ts`) and
  encapsulates Ajv input-schema validation + `executor.invoke`; the
  HTTP source does NOT import or call the executor directly. The
  executor still owns runQueue serialization + lifecycle emission.
- **Payload scope reaches the sandbox only as the handler's `payload`
  argument** — a JSON snapshot. Any downstream code that consumes the
  payload runs in the sandbox with no host APIs (see §2).
- **TLS termination at Traefik** (HTTPS only on the websecure
  entrypoint).
- **Closed URL vocabulary.** The three URL segments
  (`<tenant>/<workflow>/<trigger-name>`) are all regex-constrained identifiers
  set at workflow build time (the trigger name IS the export identifier,
  enforced by the vite plugin) and validated at upload (the manifest Zod
  schema's `.regex()` constraints). There is no author-controlled URL
  fragment; there are no param placeholders; there is no URL-derived data
  structured onto the handler's payload. A request URL either matches
  exactly one registered `(tenant, workflow, trigger-name)` triple or
  returns **404**. This is strictly stricter than URLPattern-based matching
  and eliminates any `payload.params` / `payload.query` injection surface
  entirely — the handler receives `{ body, headers, url, method }` and
  nothing else. Collisions within a workflow are impossible by
  construction (JS rejects duplicate export names at parse time; the
  manifest schema requires unique trigger names per workflow; the
  workflow manifest schema requires unique workflow names per tenant).
- **Separate trust domain** — webhook handlers cannot read the session
  cookies or bearer tokens used by the UI / API routes, because those
  headers are not forwarded to this route family.
- **Global request body size cap of 10 MiB** via Hono's `bodyLimit`
  middleware mounted at `*` in `createApp`. Oversize requests short-
  circuit with **413** `{ "error": "payload_too_large" }` before any
  route handler runs. Applies to webhooks and the `/api/workflows`
  upload path alike.
  (`packages/runtime/src/services/server.ts`)

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-W1 | **No signature verification** on incoming payloads (HMAC, GitHub signature, Stripe signature, etc.) | W4 unmitigated | v1 limitation; add per-integration |
| R-W2 | ~~No payload size limit~~ — Mitigated by a global 10 MiB Hono `bodyLimit` in `createApp` (`packages/runtime/src/services/server.ts`). A tenant tarball is additionally bounded to 10 MiB decompressed inside `extractTenantTarGz` (`packages/runtime/src/workflow-registry.ts`). | W2 mitigated | Resolved |
| R-W3 | **No rate limiting** at the application or Traefik level | W3, W7 unmitigated | v1 limitation |
| R-W4 | **All request headers are forwarded verbatim** into the payload's `headers` field, including any `Authorization` / `Cookie` the caller sent | W5 unmitigated | **High priority** — move to per-trigger header allowlist |
| R-W5 | Trigger names are reflected in 404 vs 422 vs 200 response differences, enabling enumeration | W6 low | Accepted; triggers are not secret |

### Implementation guidance for signed webhooks

When adding signature verification for a specific integration (e.g.
GitHub webhooks, Stripe webhooks), implement the verifier as a
**pre-validation step in the HTTP trigger middleware** — before the
registry-built `fire` closure runs Ajv input-schema validation and
dispatches to the executor — and reject unsigned or incorrectly
signed requests with 401 before any sandbox entry. Store the signing
secret as a K8s Secret per §5, never in the trigger definition. The
verifier must not skip the schema check; a valid signature on a
schema-violating payload still returns 422.

### Rules for AI agents

1. **NEVER add authentication to `/webhooks/*` without an explicit
   OpenSpec proposal.** Public ingress is deliberate.
2. **NEVER strip the Ajv input-schema validation step** between the
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
behaviour — same end result, different mechanism. Tenant scope for writes
runs through `isMember(user, tenant)`, unchanged from prior revisions.

**Manual-fire dispatch through `/trigger/*`.** The operator "fire this
trigger now" UI submits every kind (HTTP, cron, future kinds) to the
authenticated endpoint `POST /trigger/<tenant>/<workflow>/<name>`, which
sits behind `sessionMiddleware` + `requireTenantMember`. HTTP descriptors
are server-wrapped into the `HttpTriggerPayload` shape before dispatch
(`{ body, headers: {}, url: "/webhooks/<tenant>/<workflow>/<name>",
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
| A12 | Allow-listed user uploads to a tenant they are not a member of (or enumerates tenants) to discover tenant names | EoP (cross-tenant) / Information disclosure |
| A13 | *(Eliminated.)* Historical: allow-listed Bearer caller on `/api/*` forges `X-Auth-Request-*` headers to impersonate membership in another tenant. No code path reads those headers; kept here as a reminder. | n/a |
| A14 | Authenticated caller reads workflow or invocation-event data by id or name on a surface whose handler omits the tenant scope (breaks I-T2) | EoP (cross-tenant) / Information disclosure |
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
- **Tenant membership enforcement via `requireTenantMember()` middleware
  (R-A12).** A single Hono middleware factory is the sole enforcement
  point for the `:tenant` authorization invariant. It validates
  `<tenant>` against the identifier regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), then evaluates
  `isMember(user, tenant) := user.orgs.includes(tenant) || user.name === tenant`.
  Both failures return `404 Not Found` with an identical JSON body
  (`{"error":"Not Found"}`) sourced from each sub-app's
  `app.notFound(...)` handler. Teams are not consulted (and are no
  longer part of `UserContext`). The membership check applies to every
  authenticated caller regardless of which provider minted the
  identity — there is no longer an "open mode" bypass. The middleware
  is mounted on `/api/workflows/:tenant` and on the `/trigger`-basePath
  sub-app's `/:tenant/*` subtree. Inline `validateTenant` +
  `isMember`/`tenantSet` checks in individual route handlers are
  prohibited; any new route that accepts a `:tenant` path parameter
  MUST mount `requireTenantMember()` on its subpath.
  (`packages/runtime/src/auth/tenant.ts`,
  `packages/runtime/src/auth/tenant-mw.ts`,
  `packages/runtime/src/api/index.ts`,
  `packages/runtime/src/ui/trigger/middleware.ts`)
- **No code path reads `X-Auth-Request-*` (A13 eliminated).** The
  `headerUserMiddleware` reader and all references to those headers
  were deleted. `apiAuthMiddleware` reads only the
  `X-Auth-Provider` header and then delegates `Authorization` /
  credential parsing to the selected provider's `resolveApiIdentity`;
  `sessionMiddleware` reads only the `session` cookie. Forged
  `X-Auth-Request-*` headers have no handler to trust them. The
  Traefik `strip-auth-headers` middleware is therefore removed — no
  upstream produces those headers, and no downstream consumes them.
- **Startup-logged registered providers.** The runtime emits a log
  record at init listing the registered provider ids and the per-provider
  entry counts (not the entries themselves). When `LOCAL_DEPLOYMENT=1`
  is set, the presence of `local` in the registry is logged at `warn`
  level to make accidental enablement visible.
  (`packages/runtime/src/main.ts`)
- **POST-only logout.** `POST /auth/logout` clears the session cookie
  and 302s to `/`. Any other method returns 405 — prevents cross-site
  logout CSRF via `<img src>` / `<a>` / navigation.
- **TLS termination at Traefik.** Session cookies, Bearer tokens, and
  the GitHub access token stored inside the sealed cookie are not in
  cleartext on the wire.
- **Tenant-scoped query API (A14).** Unchanged. `EventStore.query(tenant)`
  pre-binds `.where("tenant", "=", tenant)`; no unscoped read path
  against the `events` table exists. Workflow bundles are tenant-keyed
  at the storage layer (`workflows/<tenant>.tar.gz`).

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
| R-A14 | Unchanged from prior revisions; `EventStore.query(tenant)` pre-binds the tenant predicate. | High | **Resolved** |

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
14. **NEVER read or list workflow or invocation-event data without a
    tenant scope.** `EventStore.query(tenant)` is the only scoped read
    API. For workflows, route through `WorkflowRegistry`, which is
    keyed by tenant. Format validation of a tenant identifier (the
    regex) is NOT a permission check and does NOT substitute for a
    tenant-scoped query (A14, R-A14, §1 I-T2).
15. **NEVER enforce the `:tenant` authorization invariant inline in a
    route handler.** `requireTenantMember()` is the sole enforcement
    point and MUST be mounted on every subpath that accepts a
    `:tenant` path parameter (today: `/api/workflows/:tenant` and
    `/trigger/:tenant/*`). Inline `validateTenant(tenant)` +
    `isMember(user, tenant)` / `tenantSet(user).has(tenant)` checks in
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
- Tenant predicate + regex: `packages/runtime/src/auth/tenant.ts`
- Tenant-authorization middleware: `packages/runtime/src/auth/tenant-mw.ts`
- Deny banner template: `packages/runtime/src/ui/auth/login-page.ts`
- Config / env (AUTH_ALLOW, OAuth creds, BASE_URL): `packages/runtime/src/config.ts`
- App wiring (route ordering): `packages/runtime/src/main.ts`
- Tenant predicate: `packages/runtime/src/auth/tenant.ts`
- Routes chart (no auth middlewares): `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml`
- OpenSpec spec: `openspec/specs/auth/spec.md` (created by change `replace-oauth2-proxy`)
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
| App (runtime) | In-cluster Service | 8080 | per-instance (e.g. `prod`) | Traefik (cross-namespace, NP-enforced) — serves `/dashboard`, `/trigger`, `/auth/*`, `/api/*`, `/webhooks/*`, `/static/*`, `/livez`, `/healthz`, plus the OAuth handshake |
| S2 (S3-compatible storage) | In-cluster Service | 9000 | `default` (local only) | App pod (NP-enforced) |
| cert-manager controllers | In-cluster Service (webhook) | 9402 | `cert-manager` | kube-apiserver (admission webhooks) |
| DuckDB | Process-local | — | — | App process only (in-memory) |
| GitHub API | External egress | 443 | — | App pod (auth validation) |
| Let's Encrypt ACME (egress) | External egress | 443 | — | cert-manager (prod only, issuance + renewal) |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| I1 | K8s Secret is leaked via logs, etcd snapshots, or a pod with broad RBAC read | Information disclosure |
| I2 | A compromised pod or sidecar reaches the app pod's `:8080` directly, bypassing Traefik | EoP (note: no code path reads `X-Auth-Request-*`, so forged-header injection is no longer a vector — see §4 A13) |
| I3 | A compromised pod or action (via SSRF, §2) reaches cloud metadata endpoints (e.g. `169.254.169.254`) or internal admin APIs | Information disclosure / EoP |
| I4 | App container runs with unnecessary capabilities, a writable root filesystem, or as a privileged user | EoP |
| I5 | No resource limits → a runaway action or memory leak crashes the node, not just the pod | DoS |
| I6 | OAuth2 client secret or S3 credentials committed to a `.tfvars` file checked into git | Information disclosure |
| I7 | Traefik accepts weak TLS ciphers or outdated TLS versions | Tampering / eavesdropping |
| I8 | Self-signed dev cert used in production by mistake | Spoofing |
| I9 | S3 bucket policy permits unintended readers (production deployment) | Information disclosure |
| I10 | Events stored to S3 / filesystem in plaintext, containing secrets that leaked via action env vars | Information disclosure |
| I11 | Default ServiceAccount token auto-mounted into a pod becomes a latent `kube-apiserver` bearer credential. A sandbox escape, RCE, or future RoleBinding to `default` converts it into active cluster access. Amplified by R-I1 (no NetworkPolicy blocks pod → apiserver); the app-layer `hardenedFetch` (§2 R-S4) blocks private-range egress from inside the sandbox but does not affect an out-of-sandbox compromise. | EoP / Information disclosure |

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
- **Secrets in K8s Secret objects** — the GitHub OAuth App client
  secret (`GITHUB_OAUTH_CLIENT_SECRET`) and S3 credentials are stored
  as Kubernetes Secrets and injected via `envFrom.secretRef`. None are
  baked into images or committed to source. The session-cookie sealing
  password is intentionally NOT a K8s Secret — it is generated
  in-memory at pod start (see §4 A15, R-I13).
  (`infrastructure/modules/app-instance/secrets.tf`;
  `infrastructure/modules/object-storage/s2/s2.tf`)
- **Terraform `sensitive = true`** on all secret variables; values are
  expected in `dev.secrets.auto.tfvars` which is gitignored.
- **Distroless non-root base image** — the application runs as UID
  65532 on `gcr.io/distroless/nodejs24-debian13`. No shell, minimal
  userspace. Numeric UID for PodSecurity admission static validation.
  (`infrastructure/Dockerfile`)
- **Internal-only services** — S2 and the app's business-logic port
  are not published via NodePort; only Traefik is.
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
  the app pod and S2 pods suppress the projected SA token. Mitigates
  **I11**.
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
| R-I1 | Namespace-wide default-deny `NetworkPolicy` plus per-workload allow-rules: app ingress restricted to Traefik (+ node CIDR for probes); Traefik ingress restricted to `0.0.0.0/0:80,443` + node CIDR; cross-pod traffic otherwise dropped. | I2, I3 | **Resolved** (production enforcement via Cilium; kindnet silently no-ops locally, accepted) |
| R-I2 | ~~App pod has no `securityContext`~~ — **Resolved**: all workloads now set explicit securityContext (runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation=false, capabilities.drop=[ALL]), enforced by PodSecurity admission `restricted` at namespace level. | I4 | **Resolved** |
| R-I3 | **No resource `requests` / `limits`** on the app or S2 pods — a runaway process can starve the whole node. | I5 (amplifies §2 R-S1 / R-S2) | **High priority** |
| R-I4 | ~~S2 container has no user specified~~ — **Resolved**: S2 now runs as UID 65532 with full securityContext. Data writes use emptyDir at `/data`. | I4 | **Resolved** |
| R-I5 | ~~TLS cert source not pinned in IaC~~ — **Resolved**: cert-manager codified in `infrastructure/modules/cert-manager/`; prod uses Let's Encrypt (HTTP-01), local uses a cluster-internal self-signed CA chain. Chart version is pinned. | I7, I8 | Resolved |
| R-I10 | **cert-manager has cluster-wide RBAC** — creates/manages Secrets cluster-wide and reconciles ClusterIssuer/Certificate resources. Compromise of the cert-manager controller pod grants broad Secret read/write. | I1, EoP | Accepted — standard upstream Helm-chart RBAC; chart version pinned; runs in `cert-manager` namespace. Revisit if narrower scope becomes available. |
| R-I7 | **No encryption at rest** — the event store and S3 objects are plaintext JSON. Any secret leaked through an action payload (e.g. via emit) is stored in readable form. | I10 | Out of scope for v1; see §2 R-S6 |
| R-I8 | **No secret-management integration** (Vault, SOPS, external-secrets). Secrets live in `terraform.tfvars` files on operator workstations. | I6 | Acceptable for small teams; revisit for production |
| R-I9 | Egress `ipBlock` `0.0.0.0/0` with `except = [10/8, 172.16/12, 192.168/16, 169.254/16]` blocks cluster pod/service CIDRs, the UpCloud node network, and cloud metadata (IMDS `169.254.169.254`). Public Internet egress remains open — public-URL scoping of the sandbox `fetch` plugin (S8 exfiltration, §2 R-S12) is out of scope here and deferred. The internal-range block is now defence-in-depth behind the app-layer control in §2 R-S4 (`hardenedFetch` structural default). | I3 (defence-in-depth under §2 R-S4) | **Resolved** for metadata/RFC1918 (public-URL allowlist deferred under §2 R-S12) |
| R-I11 | **Traefik's SA token remains mounted** because the controller watches `Ingress` / `IngressRoute` via the K8s API. The Helm chart's ClusterRole has not been audited for least privilege; it may grant verbs/resources wider than ingress watching requires. | I11 partial | **Follow-up: audit Traefik chart RBAC scope** |
| R-I12 | **AWS SDK error messages** surfaced via `main.service-failed` may contain the S3 access key ID verbatim (e.g. `InvalidAccessKeyId`). The secret key is never echoed by the SDK. Impact: low — the access key ID alone cannot authenticate. | I1 partial | Accepted |
| R-I13 | **App Deployment is locked to `replicas = 1`** because the auth subsystem's session-cookie sealing password lives in memory (`packages/runtime/src/auth/key.ts`) and is not shared across pods. A second replica would sign cookies with a different password, causing deterministic decryption failures whenever a request lands on the pod that did not seal the cookie. Raising replicas above 1 requires first migrating the password to a shared mechanism (e.g. a K8s Secret generated once with `ignore_changes`, or a KMS-backed KEK) in the same change. See §4 A15 and the `auth` spec's "Single-replica invariant" requirement. | I-auth | Accepted |

### Production deployment notes

When deploying to the production UpCloud K8s target, treat the
following as **must-have** before exposing to real traffic:

1. **NetworkPolicy** — DONE. Namespace-wide default-deny plus per-workload
   allow-rules: Traefik → app:8080, app → Internet (RFC1918 + IMDS
   blocked) + CoreDNS, Traefik → Internet + CoreDNS. Resolves R-I1 and
   the infrastructure half of R-I9 / §2 R-S4. Note: auth runs in-process;
   the app reaches `github.com` + `api.github.com` through the
   `egress_internet` egress rule for the OAuth handshake and for
   `/api/*` token validation.
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
5. **Egress policy** — NetworkPolicy half DONE (see item 1). Private-range
   filtering inside the sandbox `fetch` plugin's structural `hardenedFetch`
   default (§2 R-S4) now closes the app-layer half — internal SSRF (S5)
   is mitigated end-to-end. Public-URL allowlist for exfiltration (S8 /
   §2 R-S12) remains deferred pending UX design.
6. **Encrypted event storage** — if UpCloud Object Storage is used,
   enable server-side encryption. Document the key custody model.
7. **Secret rotation procedure** — document how to rotate the
   `GITHUB_OAUTH_CLIENT_SECRET` and the S3 credentials without downtime.
   The in-memory session-cookie sealing password rotates implicitly on
   every pod restart; no explicit rotation procedure is needed as long
   as `replicas = 1` (R-I13).

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
10. **NEVER raise the `workflow-engine` app Deployment replicas above 1**
    without first migrating the auth sealing password out of in-memory
    state (see §4 A15, R-I13, and the `auth` capability's
    "Single-replica invariant" requirement). A change that sets
    `replicas > 1` without this migration silently breaks the auth
    subsystem — cookies sealed on one pod fail decryption on another,
    bouncing users through login on every alternating request.

### File references

- App deployment: `infrastructure/modules/app-instance/workloads.tf`
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
