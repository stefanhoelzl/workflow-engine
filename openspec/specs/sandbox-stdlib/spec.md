# sandbox-stdlib Specification

## Purpose

Own every guest-visible global installed at sandbox Phase 2 that is NOT a VM-level quickjs-wasi extension. Packages the web-platform plugin (EventTarget, Event, ErrorEvent, AbortController, AbortSignal, DOMException Proxy wrapper, reportError + microtask routing, structuredClone override, queueMicrotask wrap, URLPattern, Response/Request/Body mixin, Blob/File/FormData, streams + queuing strategies + TextEncoder/TextDecoderStream + Compression/DecompressionStream, indexedDB, User Timing `performance.mark`/`measure`, scheduler + TaskController/TaskSignal, Observable + Subscriber), the fetch plugin (`createFetchPlugin` with `hardenedFetch` default), the timers plugin (`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` — the only `public: true` descriptors in the codebase), the console plugin (`console.log`/`info`/`warn`/`error`/`debug` with one private `__console_<method>` descriptor per method, captured into a closure-bound `console` by the plugin's `guest()` export), and the WPT compliance test harness plugin (`createWptHarnessPlugin`).

`sandbox-stdlib` is the library every production sandbox composition imports; `sandbox` itself installs no plugin-style guest globals. The split between `sandbox` (VM-level baseline from quickjs-wasi extensions + plugin mechanism) and `sandbox-stdlib` (plugin catalogue) is documented in `sandbox`'s "Isolation — no Node.js surface" and "VM-level web-platform surface via quickjs-wasi extensions" requirements.
## Requirements
### Requirement: sandbox-stdlib package

The system SHALL provide a workspace package `@workflow-engine/sandbox-stdlib` at `packages/sandbox-stdlib`. The package SHALL ship TypeScript source directly (no build step), matching conventions of `@workflow-engine/sandbox`. The package SHALL depend on `@workflow-engine/sandbox` (for plugin types) and on `zod` + polyfill libraries as needed (event-target-shim, urlpattern-polyfill, web-streams-polyfill, fake-indexeddb, scheduler-polyfill, observable-polyfill, fflate).

#### Scenario: Package exists as a workspace member

- **GIVEN** the monorepo at `packages/`
- **WHEN** a developer runs `pnpm install`
- **THEN** `packages/sandbox-stdlib` SHALL be discovered as a workspace package
- **AND** its `package.json` SHALL declare `name: "@workflow-engine/sandbox-stdlib"`

#### Scenario: Runtime depends on sandbox-stdlib

- **GIVEN** `packages/runtime/package.json`
- **WHEN** inspecting the `dependencies` field
- **THEN** it SHALL declare `"@workflow-engine/sandbox-stdlib": "workspace:*"`

### Requirement: createWebPlatformPlugin factory

The sandbox-stdlib package SHALL export a `createWebPlatformPlugin(): Plugin` factory. The returned plugin's source file SHALL export a `guest(): void` function bundled into `PluginDescriptor.guestSource` by the `?sandbox-plugin` vite transform. The `guest()` function SHALL install WebIDL polyfills as writable/configurable globals: `EventTarget`, `Event`, `ErrorEvent`, `AbortController`, `AbortSignal`, `URLPattern`, `CompressionStream`, `DecompressionStream`, `scheduler`, `TaskController`, `TaskSignal`, `Observable`, `Subscriber`, `ReadableStream`, `WritableStream`, `TransformStream`, `indexedDB`, `performance.mark`, `performance.measure`, `performance.getEntries`, `queueMicrotask` (wrapped to route uncaught exceptions through `reportError`), `reportError` (dispatches cancelable ErrorEvent, forwards to a captured-and-deleted `__reportErrorHost` private guest function if not preventDefault'd). The plugin SHALL register `__reportErrorHost` as a private guest function descriptor (`public` unset) whose handler emits a leaf event with kind `uncaught-error`. The polyfill `guest()` SHALL capture `__reportErrorHost` into an IIFE closure; the sandbox SHALL auto-delete the global after phase-2 evaluation. The plugin SHALL set `navigator.userAgent = "WorkflowEngine"` (no version suffix).

#### Scenario: WebIDL globals installed and writable

- **GIVEN** a sandbox composed with only `createWebPlatformPlugin()`
- **WHEN** guest code evaluates `Object.getOwnPropertyDescriptor(globalThis, "EventTarget")`
- **THEN** the descriptor SHALL have `writable: true` and `configurable: true`

#### Scenario: Microtask exception routes through reportError

- **GIVEN** a guest that calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** an `uncaught-error` leaf event SHALL be emitted if the dispatched `ErrorEvent` was not default-prevented

#### Scenario: __reportErrorHost is not guest-visible

- **GIVEN** a sandbox with `createWebPlatformPlugin()` composed
- **WHEN** user source (phase 4) evaluates `typeof globalThis.__reportErrorHost`
- **THEN** the result SHALL be `"undefined"`

#### Scenario: navigator.userAgent has no version suffix

- **GIVEN** a sandbox with `createWebPlatformPlugin()` composed
- **WHEN** guest code evaluates `navigator.userAgent`
- **THEN** the value SHALL be exactly `"WorkflowEngine"`

### Requirement: createFetchPlugin factory

The sandbox-stdlib package SHALL export a `createFetchPlugin(opts?: { fetch?: FetchImpl }): Plugin` factory. When `opts.fetch` is omitted, the plugin SHALL close over the `hardenedFetch` export from the same package. The plugin SHALL declare `dependsOn: ["web-platform"]`. The plugin SHALL register a private guest function `$fetch/do` whose handler invokes the bound fetch implementation and returns the serialized response. The plugin's `source` blob SHALL install a WHATWG-compliant `globalThis.fetch` that captures `$fetch/do` and marshals `Request`/`Response` to/from the host. The descriptor SHALL declare `log: { request: "fetch" }` so each fetch call produces `fetch.request`/`fetch.response` or `fetch.error`.

#### Scenario: Production fetch uses hardenedFetch by default

- **GIVEN** `createFetchPlugin()` called with no arguments
- **WHEN** guest code calls `await fetch("https://public.example.com/")`
- **THEN** the host-side handler SHALL invoke `hardenedFetch` (DNS validation, IANA blocklist, redirect re-check, 30s timeout)
- **AND** the request SHALL fail closed if any hardening check rejects

#### Scenario: Test fetch override

- **GIVEN** `createFetchPlugin({ fetch: mockFetch })` with `mockFetch` a test double
- **WHEN** guest code calls `await fetch("https://any/")`
- **THEN** `mockFetch` SHALL be invoked instead of `hardenedFetch`

#### Scenario: Fetch call produces request/response events

- **GIVEN** guest code awaits `fetch("https://public.example.com/")` and the request succeeds
- **WHEN** the call resolves
- **THEN** a `fetch.request` event SHALL be emitted with `createsFrame: true`
- **AND** a `fetch.response` event SHALL be emitted with `closesFrame: true`
- **AND** the response event's `ref` SHALL point to the request event's `seq`

### Requirement: hardenedFetch export

The sandbox-stdlib package SHALL export `hardenedFetch` as a named constant — a fetch implementation that performs IANA special-use blocklist checks on the resolved IP for every DNS resolution, rejects `data:` URLs with an error, re-validates redirect targets (manual follow, limit 5), strips `Authorization` on cross-origin redirects, enforces a 30s wall-clock timeout, and fails closed with a sanitized error on any check failure.

#### Scenario: hardenedFetch rejects IANA special-use CIDR

- **GIVEN** a hostname resolving to an IANA private range (e.g., `10.0.0.1`)
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject with a sanitized error before any socket is opened
- **AND** the error message SHALL NOT leak the resolved IP address

#### Scenario: hardenedFetch enforces 30s timeout

- **GIVEN** an upstream that never responds
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject no later than 30 seconds after the call

### Requirement: createTimersPlugin factory

The sandbox-stdlib package SHALL export a `createTimersPlugin(): Plugin` factory. The plugin SHALL register public descriptors for `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. The `setTimeout` / `setInterval` descriptors SHALL declare `log: { event: "timer.set" }` emitting a leaf at scheduling time. The `clearTimeout` / `clearInterval` descriptors SHALL declare `log: { event: "timer.clear" }`. When a scheduled timer fires on the host, the plugin SHALL wrap the guest callback execution in `ctx.request("timer", name, { input: { timerId } }, () => callable())`, producing `timer.request`/`timer.response`/`timer.error` events around the callback. The plugin SHALL implement `onRunFinished` to clear any host timers still live at run end, using the same code path that handles guest-initiated `clearTimeout`.

#### Scenario: setTimeout emits timer.set leaf

- **GIVEN** guest code calls `setTimeout(cb, 100)`
- **WHEN** the call returns
- **THEN** a leaf event with kind `timer.set` SHALL have been emitted
- **AND** the event `input` SHALL include `{ delay: 100, timerId: <id> }`

#### Scenario: Timer callback wraps with timer.request/response

- **GIVEN** a setTimeout whose callback returns normally
- **WHEN** the timer fires
- **THEN** `timer.request` (createsFrame) SHALL be emitted
- **AND** the captured callable SHALL be invoked
- **AND** `timer.response` (closesFrame) SHALL be emitted with the response's `ref` equal to `timer.request.seq`

#### Scenario: Unfired timer cleared at run end

- **GIVEN** a setTimeout with 30s delay scheduled inside a 1s run
- **WHEN** the run completes
- **THEN** the plugin's `onRunFinished` SHALL invoke the same cleanup as guest-called `clearTimeout`
- **AND** a `timer.clear` leaf event SHALL be emitted for the still-live timer
- **AND** the host-side `setTimeout` SHALL be cleared before the next run starts against the same sandbox

### Requirement: createConsolePlugin factory

The sandbox-stdlib package SHALL export a `createConsolePlugin(): Plugin` factory. The plugin SHALL install `globalThis.console` as an object containing methods `log`, `info`, `warn`, `error`, `debug`. Each method call SHALL emit a leaf event of kind `console.log` / `console.info` / `console.warn` / `console.error` / `console.debug` respectively, with `input` carrying the argument list. The console globals SHALL be writable/configurable per WebIDL.

#### Scenario: console.log emits console.log leaf

- **GIVEN** guest code calls `console.log("hello", { x: 1 })`
- **WHEN** the call returns
- **THEN** a leaf event with kind `console.log` and `input: ["hello", { x: 1 }]` SHALL be emitted

### Requirement: Bundled polyfill source via rollup

The web-platform plugin's `guestSource` SHALL be produced by the `?sandbox-plugin` vite transform's guest pass, which rollup-bundles the `guest()` function exported from the plugin source file plus its transitive imports into a single IIFE. Cross-file module imports between polyfill installer files (e.g., `installStreams` → `installBlob`) SHALL resolve at build time. The `fetch-blob` dependency SHALL be installed with a `pnpm patch` that removes its module-level top-level-await block (the block is dead code in the sandbox because `ReadableStream` is installed by the streams installer before `fetch-blob` loads).

#### Scenario: Polyfill bundle is a single IIFE

- **GIVEN** the shipped sandbox-stdlib package
- **WHEN** inspecting the resolved `createWebPlatformPlugin()` plugin descriptor's `guestSource`
- **THEN** the string SHALL be a single IIFE that invokes the `guest()` function at its end

#### Scenario: Cross-installer imports resolve

- **GIVEN** installer file A imports a helper from installer file B
- **WHEN** the guest-pass bundle is built
- **THEN** the resulting IIFE SHALL have the cross-file dependency resolved inline with no `require`/`import` statements remaining

#### Scenario: fetch-blob TLA block is absent from the installed module

- **GIVEN** the pnpm-patched `fetch-blob` package in `node_modules`
- **WHEN** inspecting the patched `index.js`
- **THEN** the `if (!globalThis.ReadableStream) { await import(...) }` top-level-await block SHALL be absent

### Requirement: web-platform plugin — self and navigator

`createWebPlatformPlugin()`'s guest IIFE (from `trivial.ts`) SHALL install `globalThis.self` as a reference to `globalThis` itself (`self === globalThis`). Because `globalThis` inherits `EventTarget.prototype` (see EventTarget requirement), `self instanceof EventTarget === true` with `self.addEventListener` / `self.removeEventListener` / `self.dispatchEvent` available as non-enumerable own-properties.

The plugin SHALL also install `globalThis.navigator` as a frozen object with a single string property `userAgent` whose value is exactly `"WorkflowEngine"` (no version suffix per `unify-sandbox-plugin-transform`). The object SHALL be non-extensible.

#### Scenario: self reflects globalThis

- **WHEN** guest code evaluates `self === globalThis`
- **THEN** the result SHALL be `true`

#### Scenario: self is an EventTarget

- **WHEN** guest code evaluates `self instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: EventTarget methods on self are non-enumerable own-properties

- **WHEN** guest code evaluates `Object.keys(globalThis)`
- **THEN** the result SHALL NOT include `addEventListener`, `removeEventListener`, or `dispatchEvent`
- **AND** `Object.getOwnPropertyNames(globalThis)` SHALL include all three

#### Scenario: navigator.userAgent has no version suffix

- **WHEN** guest code evaluates `navigator.userAgent`
- **THEN** the value SHALL be exactly `"WorkflowEngine"`

#### Scenario: navigator is frozen

- **WHEN** guest code attempts `navigator.foo = "x"`
- **THEN** the assignment SHALL fail (silently in sloppy mode, TypeError in strict)

### Requirement: web-platform plugin — EventTarget, Event, ErrorEvent

The plugin SHALL install `globalThis.EventTarget` as a WHATWG EventTarget (from `event-target-shim`) with no host-bridge method; all listener state lives in the QuickJS heap. `globalThis.Event` SHALL be constructible with `(type, init?)` exposing read-only `type`, `bubbles`, `cancelable`, `defaultPrevented`, `target`, `currentTarget`, `timeStamp`, and methods `preventDefault()`, `stopPropagation()`, `stopImmediatePropagation()`. `globalThis.ErrorEvent` SHALL be constructible with `(type, init?)` exposing `message`, `filename`, `lineno`, `colno`, `error`.

#### Scenario: new EventTarget() is constructible

- **WHEN** guest code evaluates `new EventTarget() instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: addEventListener delivers dispatched events

- **GIVEN** a fresh EventTarget with a listener `et.addEventListener("x", cb)`
- **WHEN** guest code calls `et.dispatchEvent(new Event("x"))`
- **THEN** `cb` SHALL be invoked with an Event whose `type === "x"`, `target === et`, `currentTarget === et`

#### Scenario: once option auto-removes after first dispatch

- **GIVEN** `et.addEventListener("x", cb, { once: true })`
- **WHEN** `et.dispatchEvent(new Event("x"))` is called twice
- **THEN** `cb` SHALL be invoked exactly once

### Requirement: web-platform plugin — AbortController and AbortSignal

The plugin SHALL install `globalThis.AbortController` with `.signal` and `abort(reason?)`, and `globalThis.AbortSignal` with `.aborted`, `.reason`, `.throwIfAborted()`, and inherited `addEventListener("abort", ...)`. Static factories `AbortSignal.abort(reason?)`, `AbortSignal.timeout(ms)`, and `AbortSignal.any(signals)` SHALL be present.

Default abort `reason` when not provided SHALL be a `DOMException` with `name === "AbortError"`. `AbortSignal.timeout(ms)` SHALL produce a signal that aborts after `ms` using the host-bridged `setTimeout` with a DOMException whose `name === "TimeoutError"`. `AbortSignal.any(signals)` SHALL produce a composite signal that aborts when any input signal aborts, forwarding the first input's `reason`.

#### Scenario: AbortController.abort() synthesizes AbortError

- **GIVEN** `const c = new AbortController()`
- **WHEN** guest code calls `c.abort()` (no reason)
- **THEN** `c.signal.reason` SHALL be a DOMException with `name === "AbortError"`

#### Scenario: throwIfAborted throws the reason

- **GIVEN** an aborted signal
- **WHEN** guest code calls `signal.throwIfAborted()`
- **THEN** the call SHALL throw the signal's `reason`

#### Scenario: AbortSignal.timeout fires after the delay

- **GIVEN** `const s = AbortSignal.timeout(100)`
- **WHEN** 100ms pass
- **THEN** `s.aborted` SHALL be `true`
- **AND** `s.reason` SHALL be a DOMException with `name === "TimeoutError"`

### Requirement: web-platform plugin — DOMException wrapper

The plugin SHALL wrap the VM-native `DOMException` (from quickjs-wasi `structuredCloneExtension`) in a construct-trap `Proxy` so that `throw new SubclassDOMException()` from fake-indexeddb (and other libraries that subclass DOMException) lands as a plain `DOMException` instance. This wrapper MUST run before the indexed-db installer imports `fake-indexeddb`.

The guest-visible `globalThis.DOMException` is the wrapped Proxy, not the raw quickjs-wasi class. Both `new DOMException(...)` and `instanceof DOMException` continue to work transparently.

#### Scenario: Construct-trap makes subclass throws land as plain DOMException

- **GIVEN** a subclass `class DataError extends DOMException { ... }`
- **WHEN** guest code throws `new DataError("...")`
- **THEN** the thrown object's constructor SHALL be `DOMException` (not `DataError`)
- **AND** it SHALL satisfy `instanceof DOMException`

### Requirement: web-platform plugin — reportError and microtask exception routing

The plugin SHALL install `globalThis.reportError` as a function that dispatches a cancelable `ErrorEvent` on `globalThis`; if the event is not default-prevented, the function SHALL forward a serialized payload to the captured private `__reportErrorHost` descriptor, which emits an `uncaught-error` leaf event.

The plugin SHALL also wrap `queueMicrotask` so uncaught exceptions inside a microtask route through `reportError` rather than silently terminating the microtask queue. The wrapped `globalThis.queueMicrotask(callback)` SHALL preserve the WHATWG shape.

`__reportErrorHost` SHALL be a private (non-public) `GuestFunctionDescription`; after Phase 2, the IIFE SHALL have captured it into its closure, and Phase 3 SHALL delete `globalThis.__reportErrorHost` so user source cannot see it.

#### Scenario: Uncaught microtask exception routes through reportError

- **GIVEN** guest code calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** an `uncaught-error` leaf event SHALL be emitted unless a listener called `preventDefault()` on the dispatched ErrorEvent

#### Scenario: __reportErrorHost is not guest-visible

- **WHEN** user source (Phase 4) evaluates `typeof globalThis.__reportErrorHost`
- **THEN** the result SHALL be `"undefined"`

### Requirement: web-platform plugin — structuredClone override

The plugin SHALL install `globalThis.structuredClone` as a pure-JS implementation using `@ungap/structured-clone`, overriding the quickjs-wasi native implementation (which drops wrapper objects, sparse-array length, and non-index array properties). The override SHALL throw a `DataCloneError` DOMException for non-cloneable inputs and SHALL reject any non-empty `transfer` option with `DataCloneError` (QuickJS does not support ArrayBuffer detachment). Errors thrown by user code during serialization (e.g., throwing getters) SHALL propagate unchanged.

#### Scenario: Wrapper object preserves via override

- **GIVEN** a Number wrapper object `o = new Number(42)`
- **WHEN** guest code calls `structuredClone(o)`
- **THEN** the result SHALL be a Number wrapper (not a primitive)
- **AND** `typeof result === "object"`

#### Scenario: Transfer option is rejected

- **WHEN** guest code calls `structuredClone({}, { transfer: [new ArrayBuffer(8)] })`
- **THEN** the call SHALL throw a DOMException with `name === "DataCloneError"`

### Requirement: web-platform plugin — queueMicrotask

The plugin SHALL install (or override) `globalThis.queueMicrotask(callback)` to schedule `callback` on the host microtask queue and to route any uncaught exception from the callback through `reportError` (see "reportError and microtask exception routing").

#### Scenario: Microtask runs after current task

- **GIVEN** guest code at top of a task calls `queueMicrotask(() => { x = 1 })`
- **WHEN** the current synchronous code completes
- **THEN** the callback SHALL run before any macrotask
- **AND** `x` SHALL be `1` by the time observable state is next checked

### Requirement: web-platform plugin — URLPattern

The plugin SHALL install `globalThis.URLPattern` from `urlpattern-polyfill`; the polyfill self-installs via `if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern`. URLPattern SHALL support WinterCG MCA-compatible construction and `.exec(url)` / `.test(url)` methods.

#### Scenario: URLPattern.exec returns named groups

- **GIVEN** `const p = new URLPattern({ pathname: "/users/:id" })`
- **WHEN** `p.exec({ pathname: "/users/42" })` is evaluated
- **THEN** the result SHALL have `pathname.groups.id === "42"`

#### Scenario: URLPattern.test returns false for non-match

- **WHEN** `new URLPattern({ pathname: "/a" }).test({ pathname: "/b" })` is evaluated
- **THEN** the result SHALL be `false`

### Requirement: web-platform plugin — Response, Request, Body mixin

The plugin SHALL install `globalThis.Response` and `globalThis.Request` as hand-rolled WHATWG classes. Both SHALL mix in a shared Body mixin providing `.text()`, `.json()`, `.arrayBuffer()`, `.blob()`, `.formData()`, `.bytes()`, plus `bodyUsed` boolean and `body` `ReadableStream` accessors.

`Request` SHALL construct with `(input, init?)` where `input` is `RequestInfo | URL`. `Request.signal` SHALL be an AbortSignal stored per spec (not propagated to the host bridge in this revision). Body types accepted by both classes SHALL include `null | string | Blob | ArrayBuffer | TypedArray | URLSearchParams | FormData | ReadableStream`.

`Response` SHALL expose `status`, `statusText`, `ok`, `type`, `url`, `redirected`, `headers`, plus static factories `error()`, `redirect(url, status?)`, `json(data, init?)`. `.clone()` SHALL produce a body-independent copy.

No host bridge SHALL back these classes — all state lives in the QuickJS heap.

#### Scenario: Request is constructible from a URL

- **WHEN** guest code evaluates `const r = new Request("https://example.com/")`
- **THEN** `r.url` SHALL be `"https://example.com/"`

#### Scenario: Response.json produces JSON content-type

- **WHEN** `Response.json({ ok: true })` is evaluated
- **THEN** the result's `headers.get("content-type")` SHALL equal `"application/json"`

#### Scenario: Body mixin consumers set bodyUsed

- **GIVEN** `const r = new Response("hi")`
- **WHEN** `await r.text()` completes
- **THEN** `r.bodyUsed` SHALL be `true`
- **AND** a subsequent `.text()` SHALL throw

### Requirement: fetch plugin — global fetch wraps __hostFetch

`createFetchPlugin()` SHALL register a private guest function `__hostFetch` (public unset). The web-platform plugin's `fetch.ts` SHALL install `globalThis.fetch` as a WHATWG-compatible function, installed via `Object.defineProperty` with `writable: false, configurable: false, enumerable: true`, routing every call through the captured `__hostFetch` reference.

The guest-side `fetch(input, init?)` SHALL accept `RequestInfo | URL` and return `Promise<Response>`. Request bodies SHALL be drained to a UTF-8 string before crossing the host bridge; streaming and binary bodies SHALL be decoded as UTF-8 via the Body mixin's `.text()` method. `Request.signal` SHALL NOT be propagated to the host bridge in this revision.

The descriptor SHALL declare `log: { request: "fetch" }` so every call emits `fetch.request` / `fetch.response` or `fetch.error`.

#### Scenario: fetch calls host bridge

- **GIVEN** a sandbox composed with `createFetchPlugin()` + `createWebPlatformPlugin()`
- **WHEN** guest code calls `await fetch("https://example.com/")`
- **THEN** the host-side `__hostFetch` handler SHALL be invoked with the URL + init
- **AND** guest SHALL receive a Response whose body derives from the host response

#### Scenario: fetch call emits request/response events

- **WHEN** guest code awaits a successful fetch
- **THEN** `fetch.request` (createsFrame) and `fetch.response` (closesFrame) SHALL be emitted
- **AND** `fetch.response.ref` SHALL equal `fetch.request.seq`

#### Scenario: Request body drained to UTF-8 before crossing bridge

- **GIVEN** `fetch(url, { method: "POST", body: new Request(url, { body: "hi" }) })`
- **WHEN** the call is issued
- **THEN** the underlying `__hostFetch` SHALL receive `method`, `url`, `headers`, and the drained UTF-8 body from that Request

### Requirement: fetch plugin — hardenedFetch default and override discipline

The fetch plugin SHALL close over `hardenedFetch` (exported from the same package) as its default host-side implementation when `opts.fetch` is omitted. Tests MAY pass `opts.fetch` to override; production compositions SHALL NOT — per `SECURITY.md §2 R-3`, overriding `hardenedFetch` in production is forbidden. The only legitimate override path is the test-only `__pluginLoaderOverride` hook.

#### Scenario: Production uses hardenedFetch

- **GIVEN** a production composition calling `createFetchPlugin()` with no arguments
- **WHEN** guest code calls `fetch("https://public.example.com/")`
- **THEN** the host-side handler SHALL invoke `hardenedFetch`

#### Scenario: Test override accepted via opts

- **GIVEN** `createFetchPlugin({ fetch: mockFetch })` with `mockFetch` a test double
- **WHEN** guest code calls `fetch("https://any/")`
- **THEN** `mockFetch` SHALL be invoked instead of `hardenedFetch`

### Requirement: fetch plugin — hardenedFetch pipeline

`sandbox-stdlib` SHALL export `hardenedFetch` as a named constant implementing the following pipeline, applied to every outbound request (initial URL AND each redirect hop):

1. **Scheme allowlist.** URL scheme SHALL be `http`, `https`, or `data`. Other schemes throw `FetchBlockedError("bad-scheme", …)`. Any port on http/https is permitted. `data:` URLs short-circuit steps 2–6 (no network component per RFC 2397; resolved by undici's native handler).
2. **Hostname resolution + IANA blocklist.** Every resolved IP SHALL be checked against the IANA special-use CIDR blocklist (RFC 6890 + updates: private ranges, loopback, link-local, multicast, unspecified, broadcast). Any block SHALL throw `FetchBlockedError("private-ip", …)` BEFORE any socket is opened.
3. **Zone-ID rejection.** IPv6 addresses carrying a zone-ID (`fe80::1%eth0`) SHALL throw `FetchBlockedError("zone-id", …)`.
4. **Cross-origin Authorization strip.** On cross-origin redirect, the `Authorization` header SHALL be stripped before re-issuing.
5. **30-second wall-clock timeout.** The request SHALL reject no later than 30s after the call.
6. **Manual redirect handling.** Requests SHALL be issued with `redirect: "manual"`. On a 3xx with `Location`, hardenedFetch SHALL re-run steps 1–5 on the resolved URL and re-issue. Redirect chain capped at **5 hops**; exceeding the cap throws `FetchBlockedError("redirect-to-private", …)`.

On failure, the main-thread `forwardFetch` handler SHALL emit a warn-level log with message `"sandbox.fetch.blocked"` and meta `{ invocationId, tenant, workflow, workflowSha, url, reason }` (via the enriched `__hostFetchForward` envelope from the worker). `reason` SHALL be one of `"bad-scheme"`, `"private-ip"`, `"redirect-to-private"`, `"zone-id"`, or `"network-error"`. No new `InvocationEvent` kind is introduced; the existing `system.request host.fetch` and `system.error host.fetch` events continue to fire unchanged.

#### Scenario: hardenedFetch rejects private IP before socket open

- **GIVEN** a hostname resolving to `10.0.0.1` (IANA private range)
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject with a sanitized error before any socket is opened
- **AND** the ops warn log SHALL record `reason: "private-ip"` and the request URL

#### Scenario: hardenedFetch rejects zone-ID

- **GIVEN** a URL like `http://[fe80::1%25eth0]/`
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject with `FetchBlockedError("zone-id", …)`

#### Scenario: data: URL resolves inline without network egress

- **GIVEN** `data:text/plain;base64,aGVsbG8=`
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the response SHALL resolve to text `"hello"` without any DNS resolution or TCP connection

#### Scenario: Redirect to private IP fails

- **GIVEN** a response 302 to `http://127.0.0.1/admin`
- **WHEN** `hardenedFetch(url)` follows the redirect
- **THEN** the promise SHALL reject with `FetchBlockedError("redirect-to-private", …)`
- **AND** the warn log SHALL record `reason: "redirect-to-private"` and `url: "http://127.0.0.1/admin"`

#### Scenario: hardenedFetch enforces 30s timeout

- **GIVEN** an upstream that never responds
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject no later than 30 seconds after the call

#### Scenario: Cross-origin redirect strips Authorization

- **GIVEN** a 302 redirect from origin A to origin B with an Authorization header on the original request
- **WHEN** `hardenedFetch` follows the redirect
- **THEN** the request issued to B SHALL NOT carry the Authorization header

### Requirement: web-platform plugin — Blob, File, FormData

The plugin SHALL install `globalThis.Blob` and `globalThis.File` from `fetch-blob@4` (with the pnpm-patched top-level-await strip so the package bundles correctly). `File` SHALL subclass `Blob`. The plugin SHALL install `globalThis.FormData` from `formdata-polyfill@4` which provides WHATWG FormData; the polyfill's transitive `fetch-blob@3` dependency SHALL operate as a no-op once `globalThis.ReadableStream` is present.

#### Scenario: Blob construction + .text()

- **WHEN** guest code evaluates `await new Blob(["hi"]).text()`
- **THEN** the result SHALL be `"hi"`

#### Scenario: File subclass of Blob

- **WHEN** guest code evaluates `new File(["hi"], "a.txt") instanceof Blob`
- **THEN** the result SHALL be `true`

#### Scenario: FormData append/get

- **GIVEN** `const f = new FormData(); f.append("x", "1")`
- **WHEN** guest code reads `f.get("x")`
- **THEN** the value SHALL be `"1"`

### Requirement: web-platform plugin — streams

The plugin SHALL install `globalThis.ReadableStream`, `globalThis.WritableStream`, `globalThis.TransformStream` from `web-streams-polyfill` (ponyfill form). Queuing strategies `ByteLengthQueuingStrategy` and `CountQueuingStrategy` SHALL be installed. `TextEncoderStream` and `TextDecoderStream` SHALL be hand-rolled TransformStream wrappers around the VM-native `TextEncoder`/`TextDecoder` (see `sandbox` "VM-level web-platform surface via quickjs-wasi extensions"); state SHALL be held in a module-scope WeakMap keyed by instance; calling an accessor on a non-instance receiver SHALL throw `TypeError("Illegal invocation")`.

#### Scenario: ReadableStream is constructible

- **WHEN** guest code evaluates `const rs = new ReadableStream({ start(c) { c.enqueue("x"); c.close(); } })`
- **THEN** `await rs.getReader().read()` SHALL return `{ value: "x", done: false }`

#### Scenario: TextDecoderStream decodes streamed UTF-8

- **WHEN** guest code pipes the bytes `[0x68, 0x69]` through a `new TextDecoderStream()`
- **THEN** the resulting string stream SHALL yield `"hi"`

### Requirement: web-platform plugin — CompressionStream / DecompressionStream

The plugin SHALL install `globalThis.CompressionStream` and `globalThis.DecompressionStream` as pure-JS TransformStream wrappers around `fflate`'s streaming `Gzip`/`Deflate`/`Inflate` classes. Supported formats SHALL be `"gzip"`, `"deflate"`, and `"deflate-raw"`.

#### Scenario: Compression round-trips data

- **GIVEN** input bytes via a ReadableStream piped through `new CompressionStream("gzip")` then `new DecompressionStream("gzip")`
- **WHEN** the output is collected
- **THEN** it SHALL equal the original input bytes

### Requirement: web-platform plugin — indexedDB

The plugin SHALL install `globalThis.indexedDB` via `fake-indexeddb` (in-memory). This depends on the structuredClone override (structured clone is used to serialize values into the store) and on the DOMException Proxy wrapper (so `fake-indexeddb`'s subclass throws land as plain DOMException).

#### Scenario: Open + put + get round-trip

- **GIVEN** an indexedDB database with one object store
- **WHEN** guest code writes a value and reads it back
- **THEN** the read value SHALL deep-equal the written value

### Requirement: web-platform plugin — User Timing (performance.mark / measure)

The plugin SHALL extend `globalThis.performance` with `mark(name, options?)`, `measure(name, startOrOptions?, endMark?)`, `clearMarks(name?)`, `clearMeasures(name?)`, `getEntries()`, `getEntriesByType(type)`, `getEntriesByName(name, type?)`, and install classes `globalThis.PerformanceEntry`, `globalThis.PerformanceMark`, `globalThis.PerformanceMeasure`. The implementation SHALL be a pure-JS User Timing Level 3 polyfill built on top of the VM-native `performance.now()` (see `sandbox` "Safe globals — performance.now"). Timeline buffers SHALL be in-process arrays scoped to the VM lifetime. `PerformanceObserver` is out of scope.

#### Scenario: mark + measure records entry

- **GIVEN** `performance.mark("a"); performance.mark("b"); performance.measure("a-to-b", "a", "b")`
- **WHEN** guest code evaluates `performance.getEntriesByType("measure")`
- **THEN** the result SHALL include one entry with `name: "a-to-b"` and a non-negative `duration`

### Requirement: web-platform plugin — scheduler

The plugin SHALL install `self.scheduler`, `TaskController`, `TaskSignal`, and `TaskPriorityChangeEvent` from `scheduler-polyfill`. Depends on AbortController/AbortSignal + Event from event-target, plus setTimeout from the timers plugin.

#### Scenario: scheduler.postTask runs the task

- **GIVEN** `let x = 0; await scheduler.postTask(() => { x = 1 })`
- **THEN** `x` SHALL be `1` after the await resolves

### Requirement: web-platform plugin — Observable

The plugin SHALL install `globalThis.Observable` + `globalThis.Subscriber` and augment `EventTarget.prototype` with `.when(type)` from `observable-polyfill`. Depends on EventTarget, AbortController/AbortSignal, Promise, queueMicrotask.

#### Scenario: Observable subscribe + next

- **GIVEN** `const o = new Observable(s => { s.next(1); s.complete() })`
- **WHEN** guest code does `const vals = []; o.subscribe({ next: v => vals.push(v) })`
- **THEN** `vals` SHALL equal `[1]`

### Requirement: console plugin — log methods emit leaf events

The console plugin SHALL install `globalThis.console` with methods `log`, `info`, `warn`, `error`, `debug`. Each method SHALL emit a leaf event of kind `console.<method>` with `input` carrying the argument list. The `console` object SHALL be writable and configurable (per WebIDL). The plugin SHALL register a private `__console_<method>` descriptor for each method, routing host-side dispatch; the guest-visible `console` methods close over the captured references (via the plugin's `guest()` export, bundled as `descriptor.guestSource`) and survive Phase 3 auto-delete because they are closure-bound.

#### Scenario: console.log emits leaf

- **GIVEN** guest code calls `console.log("hello", { x: 1 })`
- **WHEN** the call returns
- **THEN** a leaf event with kind `console.log` and `input: ["hello", { x: 1 }]` SHALL be emitted

#### Scenario: Each method produces its own kind

- **WHEN** guest code calls `console.warn("w")` and `console.error("e")`
- **THEN** two leaf events SHALL be emitted — one `console.warn`, one `console.error`

### Requirement: timers plugin — setTimeout / setInterval / clearTimeout / clearInterval

`createTimersPlugin()` SHALL register public descriptors (the ONLY `public: true` descriptors across the codebase) for `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. `setTimeout`/`setInterval` SHALL declare `log: { event: "timer.set" }` emitting a leaf at scheduling time with `{ delay, timerId }`. `clearTimeout`/`clearInterval` SHALL declare `log: { event: "timer.clear" }`.

When a scheduled timer fires host-side, the plugin SHALL wrap the guest callback execution in `ctx.request("timer", name, { input: { timerId } }, () => callable())`, producing `timer.request` (createsFrame) → callable execution → `timer.response` (closesFrame) or `timer.error` events.

The plugin SHALL implement `onRunFinished` to clear any host timers still live at run end via the same code path as guest-initiated `clearTimeout`, emitting a `timer.clear` leaf for each.

#### Scenario: setTimeout emits timer.set

- **WHEN** guest code calls `setTimeout(cb, 100)`
- **THEN** a `timer.set` leaf event with `input: { delay: 100, timerId: <id> }` SHALL be emitted at scheduling time

#### Scenario: Timer callback wraps with timer.request/response

- **GIVEN** a setTimeout whose callback returns normally
- **WHEN** the timer fires
- **THEN** `timer.request` (createsFrame) SHALL be emitted
- **AND** the callable SHALL run
- **AND** `timer.response` (closesFrame) SHALL follow with `ref === timer.request.seq`

#### Scenario: Unfired timer cleared at run end

- **GIVEN** `setTimeout(cb, 30000)` scheduled inside a 1s run
- **WHEN** the run completes
- **THEN** `onRunFinished` SHALL clear the host timer via the same path as `clearTimeout`
- **AND** a `timer.clear` leaf SHALL be emitted for it
- **AND** no callback SHALL fire in subsequent runs against the same sandbox

### Requirement: timers correlate via timerId

The `timer.set` leaf's `input.timerId` SHALL match the `timer.request`'s `input.timerId` for the same scheduled callback. `clearTimeout` / `clearInterval` leaf events SHALL carry `input.timerId` matching the cleared timer. This correlation is the basis for the dashboard's "Timer connectors" flamegraph rendering (see `dashboard-list-view`).

#### Scenario: Matching timerIds across events

- **GIVEN** `const id = setTimeout(cb, 100)` followed by the callback firing
- **WHEN** the event stream is inspected
- **THEN** the `timer.set` and `timer.request` events SHALL share a single `timerId`
- **AND** that `timerId` SHALL equal `id`

