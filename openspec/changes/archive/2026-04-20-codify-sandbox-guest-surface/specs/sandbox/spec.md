## ADDED Requirements

### Requirement: Safe globals — fetch

The sandbox SHALL expose `globalThis.fetch` as a WHATWG-compatible `fetch` function installed via `Object.defineProperty` with `writable: false, configurable: false, enumerable: true`. The implementation SHALL be the pure-JS fetch shim compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/fetch.ts`, which routes all calls through the `__hostFetch` bridge captured at init time. The shim SHALL accept `(input, init?)` where `input` is a `RequestInfo | URL` and SHALL return a `Promise<Response>`. Request bodies SHALL be drained to a UTF-8 string before crossing the host bridge; streaming and binary bodies SHALL be decoded as UTF-8 via the `Body` mixin's `.text()` method. The `Request.signal` property SHALL be preserved on the guest `Request` per spec but SHALL NOT be propagated to the host bridge in this revision of the sandbox.

Egress policy (scheme allowlist, DNS resolution, IP blocklist, redirect handling, timeout, error shape, observability) SHALL be governed by the `Hardened outbound fetch` requirement. The guest-facing shim itself performs no validation beyond normalizing input to the bridge wire format.

The `fetch` global SHALL be non-writable and non-configurable. Guest assignment `globalThis.fetch = myFn` SHALL throw a `TypeError` in strict mode or be silently ignored in sloppy mode; in neither case SHALL subsequent `fetch()` calls route to the guest-provided function.

#### Scenario: fetch is a non-writable function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof fetch`
- **THEN** the result SHALL be `"function"`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, 'fetch').writable` SHALL be `false`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, 'fetch').configurable` SHALL be `false`

#### Scenario: fetch accepts a Request object as input

- **GIVEN** a sandbox and a guest-constructed `new Request("https://example.com", { method: "POST", body: "x" })`
- **WHEN** guest code calls `fetch(req)`
- **THEN** the underlying bridge call SHALL receive the method, URL, headers, and drained body from that Request
- **AND** the returned Response SHALL be a constructible WHATWG `Response`

#### Scenario: Guest cannot replace fetch

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `globalThis.fetch = () => "pwned"` in strict mode
- **THEN** a `TypeError` SHALL be thrown
- **AND** subsequent `fetch("https://example.com")` calls SHALL route to the shim installed at init time

### Requirement: Safe globals — Request

The sandbox SHALL expose `globalThis.Request` as a hand-rolled WHATWG-compatible `Request` class compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/request.ts`. The class SHALL support construction via `new Request(input, init?)` where `input` is `RequestInfo | URL` and `init` is a `RequestInit`-shaped dictionary. The class SHALL mix in the shared `Body` mixin from `packages/sandbox/src/polyfills/body-mixin.ts`, providing `.text()`, `.json()`, `.arrayBuffer()`, `.blob()`, `.formData()`, and `.bytes()` body-consumer methods, plus the `bodyUsed` boolean and `body` `ReadableStream` accessors. `Request.signal` SHALL be an `AbortSignal` stored per spec (not propagated to the host bridge). No host bridge SHALL back this class — all state lives in the QuickJS heap.

#### Scenario: Request is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Request("https://example.com", { method: "POST", body: "x" })`
- **THEN** the returned object SHALL be an instance of `Request`
- **AND** its `method` SHALL be `"POST"`
- **AND** its `url` SHALL be `"https://example.com/"`

#### Scenario: Request body can be read as text

- **GIVEN** a `new Request("https://example.com", { method: "POST", body: "hello" })`
- **WHEN** guest code awaits `req.text()`
- **THEN** the result SHALL be `"hello"`
- **AND** `req.bodyUsed` SHALL be `true`

### Requirement: Safe globals — Response

The sandbox SHALL expose `globalThis.Response` as a hand-rolled WHATWG-compatible `Response` class compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/response.ts`. The class SHALL support construction via `new Response(body?, init?)` with body types `null | string | Blob | ArrayBuffer | TypedArray | URLSearchParams | FormData | ReadableStream`. The class SHALL mix in the shared `Body` mixin, providing the same body-consumer surface as `Request`. Static factories `Response.error()`, `Response.redirect(url, status?)`, and `Response.json(data, init?)` SHALL be present. The class SHALL expose `status`, `statusText`, `ok`, `type`, `url`, `redirected`, and `headers` accessors per spec. A `.clone()` method SHALL produce a body-independent copy. No host bridge SHALL back this class.

#### Scenario: Response is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Response("hello", { status: 201 })`
- **THEN** the returned object SHALL be an instance of `Response`
- **AND** its `status` SHALL be `201`
- **AND** its `ok` SHALL be `true`
- **AND** `await res.text()` SHALL be `"hello"`

#### Scenario: Response.json produces a JSON response

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `Response.json({ a: 1 })`
- **THEN** the result SHALL be a `Response` with `headers.get("content-type")` equal to `"application/json"`
- **AND** `await res.json()` SHALL deep-equal `{ a: 1 }`

### Requirement: Safe globals — Blob

The sandbox SHALL expose `globalThis.Blob` as the WHATWG `Blob` implementation from the `fetch-blob` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/blob.ts`. No host bridge SHALL be used; all blob state lives in the QuickJS heap and does not outlive one sandbox run. `Blob` SHALL support the spec constructor, `.size`, `.type`, `.slice()`, `.stream()`, `.arrayBuffer()`, `.text()`, and `.bytes()`.

`Blob.stream()` SHALL return a `ReadableStream<Uint8Array>` created via `globalThis.ReadableStream`; the `blob.ts` polyfill runs after `streams.ts` has installed that global, and the `fetch-blob` top-level `if (!globalThis.ReadableStream)` fallback that dynamic-imports `node:stream/web` SHALL be stripped by the vite plugin's polyfill transform to keep the bundle IIFE-compatible.

#### Scenario: Blob is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Blob(["hello"], { type: "text/plain" })`
- **THEN** the returned object SHALL be an instance of `Blob`
- **AND** its `size` SHALL be `5`
- **AND** its `type` SHALL be `"text/plain"`

#### Scenario: Blob can be read as text

- **GIVEN** `const b = new Blob(["a", "b", "c"])`
- **WHEN** guest code awaits `b.text()`
- **THEN** the result SHALL be `"abc"`

### Requirement: Safe globals — File

The sandbox SHALL expose `globalThis.File` as the `File` subclass from `fetch-blob/file.js` compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/blob.ts`. `File` SHALL extend `Blob` and add `.name`, `.lastModified`, and `.webkitRelativePath` accessors per spec.

#### Scenario: File extends Blob

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const f = new File(["x"], "a.txt", { type: "text/plain", lastModified: 1000 })`
- **THEN** `f instanceof File` SHALL be `true`
- **AND** `f instanceof Blob` SHALL be `true`
- **AND** `f.name` SHALL be `"a.txt"`
- **AND** `f.lastModified` SHALL be `1000`

### Requirement: Safe globals — FormData

The sandbox SHALL expose `globalThis.FormData` as the `FormData` implementation from the `formdata-polyfill` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/form-data.ts`. The polyfill depends on `globalThis.Blob` and `globalThis.File` being installed first. No host bridge is used. `FormData` SHALL support `.append()`, `.set()`, `.get()`, `.getAll()`, `.has()`, `.delete()`, `.entries()`, `.keys()`, `.values()`, and iteration.

#### Scenario: FormData supports append and get

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const fd = new FormData(); fd.append("k", "v"); fd.get("k")`
- **THEN** the result SHALL be `"v"`

#### Scenario: FormData accepts File entries

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const fd = new FormData(); fd.append("f", new File(["x"], "a.txt")); fd.get("f").name`
- **THEN** the result SHALL be `"a.txt"`

### Requirement: Safe globals — ReadableStream / WritableStream / TransformStream

The sandbox SHALL expose `globalThis.ReadableStream`, `globalThis.WritableStream`, and `globalThis.TransformStream` as the implementations from the `web-streams-polyfill` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. Alongside these three base classes, the sandbox SHALL also expose `ReadableByteStreamController`, `ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest`, `ReadableStreamDefaultController`, `ReadableStreamDefaultReader`, `TransformStreamDefaultController`, `WritableStreamDefaultController`, and `WritableStreamDefaultWriter` — all pulled from the same ponyfill export. No host bridge is used.

`ReadableStream.prototype.tee()`, `ReadableStream.prototype.pipeTo()`, `ReadableStream.prototype.pipeThrough()`, and `ReadableStream.prototype.getReader({ mode: "byob" })` SHALL be supported. `TransformStream` SHALL accept a custom `transformer` with `start`, `transform`, and `flush` callbacks.

#### Scenario: ReadableStream can be read via a default reader

- **GIVEN** a sandbox
- **WHEN** guest code runs `const s = new ReadableStream({ start(c) { c.enqueue("a"); c.close(); } }); const r = s.getReader(); await r.read()`
- **THEN** the read result SHALL have `{ value: "a", done: false }`
- **AND** a subsequent `r.read()` SHALL resolve with `{ value: undefined, done: true }`

#### Scenario: TransformStream chains readable and writable

- **GIVEN** a sandbox
- **WHEN** guest code constructs `const ts = new TransformStream({ transform(chunk, c) { c.enqueue(chunk.toUpperCase()); } })` and writes `"a"` through it
- **THEN** reading from `ts.readable` SHALL yield `"A"`

### Requirement: Safe globals — Queuing strategies

The sandbox SHALL expose `globalThis.ByteLengthQueuingStrategy` and `globalThis.CountQueuingStrategy` as the implementations from `web-streams-polyfill`, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. Both classes SHALL be constructible with `{ highWaterMark: number }` and SHALL expose the spec-required `size()` method.

#### Scenario: CountQueuingStrategy returns size 1

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new CountQueuingStrategy({ highWaterMark: 3 }).size()`
- **THEN** the result SHALL be `1`

### Requirement: Safe globals — TextEncoderStream / TextDecoderStream

The sandbox SHALL expose `globalThis.TextEncoderStream` and `globalThis.TextDecoderStream` as hand-rolled `TransformStream` wrappers around the WASM-native `TextEncoder` / `TextDecoder`, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. `TextDecoderStream` SHALL accept `(label?, options?)` matching the `TextDecoder` constructor and SHALL expose `encoding`, `fatal`, and `ignoreBOM` accessors. Both classes SHALL expose `readable` and `writable` accessors. State SHALL be held in a module-scope `WeakMap` keyed by the instance; calling an accessor on a non-instance receiver SHALL throw a `TypeError("Illegal invocation")`.

#### Scenario: TextDecoderStream decodes streamed UTF-8

- **GIVEN** a sandbox
- **WHEN** guest code pipes the bytes `[0x68, 0x69]` through a `new TextDecoderStream()`
- **THEN** reading from its `readable` SHALL yield `"hi"`

### Requirement: Safe globals — CompressionStream / DecompressionStream

The sandbox SHALL expose `globalThis.CompressionStream` and `globalThis.DecompressionStream` as pure-JS `TransformStream` wrappers around the streaming compressors from the `fflate` npm package, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/compression.ts`. The `format` constructor argument SHALL accept exactly `"gzip"` (RFC 1952), `"deflate"` (RFC 1950 zlib), and `"deflate-raw"` (RFC 1951 raw); any other value SHALL throw a `TypeError`. Chunks written to the writable side MUST be `BufferSource` (`ArrayBuffer` or `ArrayBufferView`); non-BufferSource chunks and chunks backed by `SharedArrayBuffer` SHALL reject with a `TypeError`. `DecompressionStream` SHALL report `TypeError` on additional input received after the compressed stream terminated and on flush when no input was received or the input did not terminate.

#### Scenario: Unsupported compression format throws

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new CompressionStream("brotli")`
- **THEN** a `TypeError` SHALL be thrown naming the supported formats

#### Scenario: gzip round-trip

- **GIVEN** a sandbox
- **WHEN** guest code compresses UTF-8 bytes for `"hello"` through `new CompressionStream("gzip")` and pipes the output through `new DecompressionStream("gzip")`
- **THEN** the final decoded bytes SHALL equal the original UTF-8 bytes for `"hello"`

### Requirement: Safe globals — Observable

The sandbox SHALL expose `globalThis.Observable` and `globalThis.Subscriber`, and SHALL patch `EventTarget.prototype.when`, using the `observable-polyfill` npm package (pinned major version 0.0.29, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/observable.ts`. The polyfill SHALL be force-applied via the `/fn` entry point to bypass upstream browser-context detection (the sandbox is not a browser context because `globalThis.Window` is `undefined`). The polyfill depends on already-allowlisted globals: `EventTarget`, `AbortController`, `AbortSignal`, `Promise`, and `queueMicrotask`. No host bridge is used.

#### Scenario: Observable is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof Observable`
- **THEN** the result SHALL be `"function"`
- **AND** `new Observable(subscriber => subscriber.complete()) instanceof Observable` SHALL be `true`

#### Scenario: EventTarget.prototype.when returns an Observable

- **GIVEN** a sandbox and `const et = new EventTarget()`
- **WHEN** guest code evaluates `et.when("custom") instanceof Observable`
- **THEN** the result SHALL be `true`

### Requirement: Safe globals — scheduler

The sandbox SHALL expose `globalThis.scheduler` as a `Scheduler` instance, plus `globalThis.TaskController`, `globalThis.TaskSignal`, and `globalThis.TaskPriorityChangeEvent`, using the `scheduler-polyfill` npm package (pinned major version 1.3, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/scheduler.ts`. The polyfill is a side-effect import that self-installs on `globalThis` when `scheduler` is absent. The implementation SHALL fall back to `setTimeout` (already allowlisted) because `MessageChannel` and `requestIdleCallback` are absent; this fallback SHALL be transparent to guest code. No host bridge is used.

`scheduler.postTask(callback, options?)` SHALL accept `priority` of `"user-blocking" | "user-visible" | "background"` and SHALL accept `signal` as an `AbortSignal` or `TaskSignal`. `scheduler.yield()` SHALL return a `Promise<void>` that resolves on the next macrotask.

#### Scenario: scheduler.postTask returns a Promise

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `scheduler.postTask(() => 42) instanceof Promise`
- **THEN** the result SHALL be `true`
- **AND** awaiting the promise SHALL yield `42`

### Requirement: Safe globals — structuredClone

The sandbox SHALL expose `globalThis.structuredClone` as a pure-JS implementation compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/structured-clone.ts`. The polyfill SHALL use the `@ungap/structured-clone` npm package to run the WHATWG structured-clone algorithm, overriding the quickjs-wasi native implementation that drops wrapper objects, sparse-array length, and non-index array properties. The shim SHALL throw a `DataCloneError` `DOMException` for non-cloneable inputs (matching spec) and SHALL reject any non-empty `transfer` option with `DataCloneError` because QuickJS does not support `ArrayBuffer` detachment. Errors thrown from user code during serialization (e.g., throwing getters) SHALL propagate unchanged.

#### Scenario: Deep clone of nested object

- **GIVEN** a sandbox and `const src = { a: [1, { b: "x" }] }`
- **WHEN** guest code evaluates `const c = structuredClone(src); c.a[1].b`
- **THEN** the result SHALL be `"x"`
- **AND** `c !== src` SHALL be `true`
- **AND** `c.a !== src.a` SHALL be `true`

#### Scenario: Transfer option throws DataCloneError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `structuredClone({}, { transfer: [new ArrayBuffer(8)] })`
- **THEN** a `DOMException` with `name === "DataCloneError"` SHALL be thrown

### Requirement: Safe globals — queueMicrotask

The sandbox SHALL expose `globalThis.queueMicrotask` as a wrapper that routes uncaught exceptions from the callback through `reportError` (which dispatches an `ErrorEvent` on `globalThis`), compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/microtask.ts`. The wrapper SHALL delegate to the native implementation for argument validation (non-callable `cb` SHALL throw a `TypeError` whose message and constructor match the native behaviour).

#### Scenario: Uncaught microtask exception routes through reportError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `queueMicrotask(() => { throw new Error("boom"); })`
- **THEN** within one microtask, `globalThis.dispatchEvent` SHALL be invoked with an `ErrorEvent` whose `error.message` is `"boom"`
- **AND** the uncaught exception SHALL NOT crash the guest

#### Scenario: Non-callable input throws TypeError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `queueMicrotask(null)`
- **THEN** a `TypeError` SHALL be thrown by the native implementation

### Requirement: Safe globals — indexedDB

The sandbox SHALL expose `globalThis.indexedDB` as an in-memory `IDBFactory` and SHALL expose the WebIDL interface classes `IDBFactory`, `IDBDatabase`, `IDBTransaction`, `IDBObjectStore`, `IDBIndex`, `IDBCursor`, `IDBCursorWithValue`, `IDBKeyRange`, `IDBRequest`, `IDBOpenDBRequest`, and `IDBVersionChangeEvent`. The implementation SHALL be the `fake-indexeddb` npm package compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/indexed-db.ts`; class names from `fake-indexeddb` (prefixed `FDB`) SHALL be rewritten to the WebIDL prefix `IDB` on `globalThis`. State SHALL live in a module singleton that does not outlive one sandbox run — each QuickJS VM gets a fresh module evaluation, so databases are ephemeral per-invocation. No host bridge is used; no data is persisted to disk.

The polyfill depends on `globalThis.structuredClone`. A `DOMException`-wrapping polyfill in `packages/sandbox/src/polyfills/idb-domexception-fix.ts` SHALL run before `indexed-db.ts` so `fake-indexeddb`'s subclass-`throw new DataError()` calls surface as plain `DOMException` instances. `instanceof Event` / `instanceof EventTarget` checks on `FDB`-sourced events are NOT guaranteed due to `event-target-shim` prototype conflicts; WPT subtests asserting those checks remain skipped.

#### Scenario: indexedDB is an IDBFactory

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `indexedDB instanceof IDBFactory`
- **THEN** the result SHALL be `true`

#### Scenario: Database opens and persists for the run

- **GIVEN** a sandbox
- **WHEN** guest code opens `indexedDB.open("db", 1)` with an `upgradeneeded` handler that creates an object store `"s"`, then (in a separate transaction) puts `{k:"v"}` and reads it back by key
- **THEN** the read SHALL resolve with `{k:"v"}`

### Requirement: Safe globals — User Timing (performance.mark / measure)

The sandbox SHALL extend `globalThis.performance` with `mark(name, options?)`, `measure(name, startOrOptions?, endMark?)`, `clearMarks(name?)`, `clearMeasures(name?)`, `getEntries()`, `getEntriesByType(type)`, and `getEntriesByName(name, type?)`, and SHALL expose the classes `globalThis.PerformanceEntry`, `globalThis.PerformanceMark`, and `globalThis.PerformanceMeasure`. The implementation SHALL be the pure-JS User Timing Level 3 polyfill compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/user-timing.ts`, built on top of the native `performance.now` provided by the quickjs-wasi monotonic-clock extension. Timeline buffers SHALL be in-process arrays scoped to the VM lifetime. `PerformanceObserver` is NOT in scope.

The `detail` option on `mark()` and `measure()` SHALL be deep-cloned via `structuredClone` at entry-creation time (so subsequent mutations by the caller do not affect the stored entry). Invalid arguments (negative `startTime`, unresolvable mark name, `duration` conflicting with both `start` and `end`) SHALL throw a `TypeError` or `SyntaxError` `DOMException` per spec.

#### Scenario: mark records entry with startTime

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const m = performance.mark("x"); m.name`
- **THEN** the result SHALL be `"x"`
- **AND** `m.entryType` SHALL be `"mark"`
- **AND** `m.startTime` SHALL be a number greater than or equal to zero

#### Scenario: measure between two named marks

- **GIVEN** a sandbox with `performance.mark("a"); performance.mark("b");`
- **WHEN** guest code evaluates `const m = performance.measure("ab", "a", "b"); m.entryType`
- **THEN** the result SHALL be `"measure"`
- **AND** `m.duration` SHALL be a non-negative number

#### Scenario: Unknown mark reference throws

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `performance.measure("m", "nope")`
- **THEN** a `DOMException` with `name === "SyntaxError"` SHALL be thrown

### Requirement: Hardened outbound fetch

The sandbox SHALL route outbound HTTP from `__hostFetch` through a hardened fetch implementation provided by `packages/sandbox/src/hardened-fetch.ts`. `hardenedFetch` SHALL be used as the default value of `SandboxOptions.fetch` whenever the caller omits an explicit override; a single process-wide `undici.Agent` instance SHALL back all sandboxes and SHALL be lazily created on first use. The `ipaddr.js` and `undici` npm packages SHALL be declared as explicit direct dependencies of `packages/sandbox/package.json`.

For every outbound request (initial URL and each redirect hop), `hardenedFetch` SHALL apply the following pipeline in order:

1. **Scheme allowlist.** The request URL's scheme SHALL be one of `http`, `https`, or `data`. Any other scheme SHALL throw `FetchBlockedError("bad-scheme", …)`. Any port number is permitted on http/https. `data:` URLs short-circuit steps 2–6 entirely: they carry no network component (the URL IS the payload per RFC 2397), so there is no DNS resolution, no TCP connection, and no SSRF or exfiltration vector. `data:` URLs SHALL be resolved by undici's native `fetch()` handler, which performs base64 decoding and content-type parsing per spec.

2. **DNS resolution.** The hostname SHALL be resolved via `dns.lookup(host, { all: true })`, returning the complete set of A and AAAA records without any caching layer introduced by this module.

3. **Address normalization.** Each returned address SHALL be parsed via `ipaddr.js`. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) SHALL be unwrapped via `ipaddr.js` and re-classified as IPv4 before the blocklist check. IPv6 zone identifiers (`fe80::1%eth0` and similar) SHALL cause `FetchBlockedError("zone-id", …)`; zone IDs are meaningful only for link-local addresses which are blocked regardless.

4. **IANA special-use blocklist.** If any normalized address falls inside any of the following CIDRs, `hardenedFetch` SHALL throw `FetchBlockedError("private-ip", …)` without attempting the connection:

   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`.
   - IPv6: `::1/128`, `::/128`, `fe80::/10`, `fc00::/7`, `100::/64`.

   The check SHALL fail-closed: if **any** returned address is in the blocklist, the entire request SHALL be refused — no attempt SHALL be made to pick a public address from the set.

5. **IP-bound connection.** The TCP connection SHALL be opened by passing the resolved IP address directly to the socket. For HTTPS, the TLS `servername` SHALL be the original hostname (preserving SNI and cert validation). For HTTP, the `Host` header SHALL remain the original hostname. No second DNS lookup SHALL occur between validation and connection — the resolved address set reached in step 2 is the address set used in step 5.

6. **Manual redirect handling.** Requests SHALL be issued with `redirect: "manual"`. On a 3xx response carrying a `Location` header, `hardenedFetch` SHALL parse the new URL against the previous URL, re-run the full pipeline (steps 1–5) on the resolved URL, and re-issue the request. The redirect chain SHALL be capped at **5 hops**; exceeding the cap SHALL throw `FetchBlockedError("redirect-to-private", …)` (or another reason if the subsequent hop fails validation). Cross-origin redirects SHALL strip the `Authorization` header before re-issuing.

7. **Timeout.** The total wall-clock time per top-level `fetch` call SHALL be capped at **30 seconds** via `AbortSignal.timeout(30000)`, composed with any caller-supplied `AbortSignal` via `AbortSignal.any([…])`. Exceeding either signal SHALL cancel the request.

**Error surface.** `hardenedFetch` SHALL export a `FetchBlockedError` class extending `Error` with a `reason` field of type `"bad-scheme" | "private-ip" | "redirect-to-private" | "zone-id"`. The main-thread `forwardFetch` handler in `packages/sandbox/src/index.ts` SHALL catch errors from the underlying fetch call, discriminate `FetchBlockedError`, and emit a pino warn log (see **Observability** below).

When the hardened default is in use (no `SandboxOptions.fetch` override was supplied), the handler SHALL sanitize the error reply returned to the worker to exactly `{ name: "TypeError", message: "fetch failed", stack: "" }` for every failure mode (policy block, DNS failure, TCP/TLS error, timeout, `AbortError`). Guest code SHALL NOT be able to distinguish a policy block from an unrelated network failure via the error object visible to it.

When a caller supplies `SandboxOptions.fetch` as a test override, the handler SHALL NOT sanitize: the raw error thrown by the custom fetch SHALL be serialized and delivered to the guest unchanged, so test-authored mocks can exercise specific error-path assertions. Custom overrides are a test-only surface; the security invariant (guest cannot probe private networks) holds because the caller of `sandbox(...)` with a custom fetch is not running adversarial workflow code.

**Observability.** When the main-thread `forwardFetch` handler catches a failure and a `SandboxOptions.logger` was injected at sandbox construction, the handler SHALL emit a warn-level log with message `"sandbox.fetch.blocked"` and meta fields `{ invocationId, tenant, workflow, workflowSha, url, reason }`. The `invocationId`, `tenant`, `workflow`, and `workflowSha` fields SHALL come from the enriched `__hostFetchForward` envelope sent by the worker (the worker already holds these from the `run` init message). The `reason` field SHALL be one of `"bad-scheme"`, `"private-ip"`, `"redirect-to-private"`, `"zone-id"`, or `"network-error"` (the last being a catch-all for non-`FetchBlockedError` failures). The URL field SHALL be the request URL at the point of failure (for redirect-to-private, the offending `Location` URL).

**No new invocation-event kind.** `hardenedFetch` failures SHALL NOT emit a new `InvocationEvent` kind. The existing `system.request host.fetch` event (with the URL captured in `input`) and the existing `system.error host.fetch` event (with the sanitized `TypeError`) SHALL continue to be emitted by the bridge-factory unchanged. The block reason SHALL appear only in the pino warn log.

**Test override.** A caller that passes a custom `SandboxOptions.fetch` SHALL bypass `hardenedFetch` entirely. Custom fetch implementations MAY throw `FetchBlockedError` to exercise the sanitization and logging paths; they MAY also throw any other error to exercise the network-error path.

#### Scenario: Private IPv4 address is blocked

- **GIVEN** a sandbox constructed without overriding `options.fetch`
- **AND** the hostname `internal.local` resolves to `10.0.0.1`
- **WHEN** guest code calls `fetch("http://internal.local/foo")`
- **THEN** the fetch SHALL reject with a `TypeError` whose `message` is `"fetch failed"`
- **AND** no TCP connection SHALL be opened to `10.0.0.1`
- **AND** if `options.logger` was provided, a warn log `"sandbox.fetch.blocked"` SHALL be emitted with `reason: "private-ip"`

#### Scenario: Cloud metadata endpoint is blocked

- **GIVEN** a sandbox constructed without overriding `options.fetch`
- **WHEN** guest code calls `fetch("http://169.254.169.254/latest/meta-data")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the ops warn log SHALL record `reason: "private-ip"` and the full URL

#### Scenario: IPv4-mapped IPv6 address is blocked after unwrap

- **GIVEN** a sandbox
- **AND** the hostname `spoof.example` resolves to `::ffff:169.254.169.254`
- **WHEN** guest code calls `fetch("http://spoof.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "private-ip"`

#### Scenario: IPv6 zone identifier is rejected

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("http://[fe80::1%eth0]/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "zone-id"`

#### Scenario: Non-http/https/data scheme is rejected

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("file:///etc/passwd")` or `fetch("ftp://example.com/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "bad-scheme"`

#### Scenario: data: URL resolves inline without network egress

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("data:text/plain,hello")`
- **THEN** the fetch SHALL resolve with a `Response` whose `status` is `200`
- **AND** the response body SHALL be `"hello"`
- **AND** no DNS lookup or TCP connection SHALL be performed
- **AND** no `sandbox.fetch.blocked` warn log SHALL be emitted

#### Scenario: Redirect to private address is blocked

- **GIVEN** a sandbox
- **AND** `https://public.example/` responds `302 Location: http://127.0.0.1/admin`
- **WHEN** guest code calls `fetch("https://public.example/")`
- **THEN** the redirect SHALL be followed manually with validation re-run
- **AND** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "redirect-to-private"` and `url: "http://127.0.0.1/admin"`

#### Scenario: Redirect cap blocks runaway chains

- **GIVEN** a sandbox
- **AND** a redirect chain of 6 hops, all to public addresses
- **WHEN** guest code calls `fetch("https://chain.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")` after 5 hops

#### Scenario: Public hostname resolves to mixed private and public addresses

- **GIVEN** a sandbox
- **AND** `dual.example` resolves to `[203.0.113.10, 8.8.8.8]`
- **WHEN** guest code calls `fetch("https://dual.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")` because the first address is in the IANA blocklist (TEST-NET-3)
- **AND** no connection SHALL be attempted to either address

#### Scenario: Request exceeds 30s timeout

- **GIVEN** a sandbox
- **AND** a public server that never responds
- **WHEN** guest code calls `fetch("https://slow.example/")`
- **THEN** within 30 seconds the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "network-error"`

#### Scenario: Test override bypasses hardenedFetch

- **GIVEN** a sandbox constructed with `options.fetch = (url, init) => new Response("ok")`
- **WHEN** guest code calls `fetch("http://127.0.0.1/")`
- **THEN** the custom fetch SHALL receive the URL
- **AND** the returned `Response` body SHALL be `"ok"`
- **AND** no policy block SHALL fire

#### Scenario: hardenedFetch is the default when options.fetch is omitted

- **GIVEN** `sandbox(source, methods)` called without `options.fetch`
- **WHEN** the sandbox-package default is installed on the main-thread forwardFetch handler
- **THEN** subsequent guest `fetch(url)` calls SHALL route through `hardenedFetch`
- **AND** a single process-wide `undici.Agent` SHALL be shared across all sandboxes

#### Scenario: Reason is not visible to guest code

- **GIVEN** a sandbox where `fetch("http://127.0.0.1/")` is about to be blocked
- **WHEN** guest code catches the rejection
- **THEN** the caught error SHALL be `TypeError`
- **AND** `err.message` SHALL be `"fetch failed"`
- **AND** the string `"private-ip"` SHALL NOT appear in `err.message`, `err.stack`, or any enumerable property on `err`

## MODIFIED Requirements

### Requirement: __hostFetch bridge

The sandbox SHALL install `globalThis.__hostFetch(method, url, headers, body)` at initialization time as an async host-bridged function that performs an HTTP request using the fetch implementation resolved at sandbox construction: either the `SandboxOptions.fetch` override supplied by the caller, or — when no override is supplied — the `hardenedFetch` default exported by `packages/sandbox/src/hardened-fetch.ts` (see the `Hardened outbound fetch` requirement for egress policy). The response SHALL be a JSON object `{ status, statusText, headers, body }` where `body` is the response text.

`__hostFetch` is the target of the sandbox's in-worker `fetch` shim, which builds a WHATWG-compatible `fetch` on top of the bridge. The worker SHALL install `__hostFetch` **before** evaluating the `fetch` shim IIFE. The `fetch` shim IIFE SHALL capture a reference to `globalThis.__hostFetch` into its closure at evaluation time, install the guest-facing `fetch` global via `Object.defineProperty` with `writable: false, configurable: false`, and then `delete globalThis.__hostFetch` so that by the time workflow source evaluation begins, the bridge name is not present on `globalThis`. The captured reference inside the `fetch` shim closure SHALL be used for all subsequent `fetch()` calls.

The worker-to-main `__hostFetchForward` request envelope SHALL carry the fields `{ method, url, headers, body, invocationId, tenant, workflow, workflowSha }`. The worker SHALL populate `invocationId`, `tenant`, `workflow`, and `workflowSha` from the `run` init message it received at run start. The main-thread handler SHALL use these fields exclusively for warn-log enrichment when an outbound fetch is blocked or fails (see `Hardened outbound fetch`); the fields SHALL NOT be reflected back to the guest or included in the response envelope.

In-flight `__hostFetch` requests initiated by the guest during a `run()` SHALL be threaded with an `AbortSignal` scoped to that run. When the exported function resolves or throws, the worker SHALL abort the signal before posting `done`. Outstanding requests SHALL reject inside the guest with an `AbortError`; the guest's `done` report SHALL still be delivered.

#### Scenario: __hostFetch is not guest-visible post-init

- **GIVEN** a sandbox whose initialization has completed
- **WHEN** guest code evaluates `typeof globalThis.__hostFetch`
- **THEN** the result SHALL be `"undefined"`
- **AND** guest assignment `globalThis.__hostFetch = myFn` SHALL NOT affect the behavior of subsequent `fetch(...)` calls

#### Scenario: fetch routes through captured bridge

- **GIVEN** guest code that calls `fetch("https://example.com/data")`
- **WHEN** the `fetch` shim resolves the call via its captured `__hostFetch` reference
- **THEN** the underlying HTTP request SHALL be performed by the host-side fetch implementation (either an `options.fetch` override or `hardenedFetch`)
- **AND** the response SHALL be returned to guest code as a WHATWG `Response`-shaped object

#### Scenario: In-flight fetch is aborted on run end

- **GIVEN** guest code that calls `fetch("https://slow.example")` without awaiting it
- **WHEN** the exported function returns before the response arrives
- **THEN** the worker SHALL abort the per-run `AbortSignal` before posting `done`
- **AND** the underlying network request SHALL be cancelled

#### Scenario: Forward envelope carries run labels

- **GIVEN** a sandbox running a workflow with `invocationId = "evt_1"`, `tenant = "acme"`, `workflow = "notify"`, `workflowSha = "abc123"`
- **WHEN** guest code calls `fetch("https://example.com/")`
- **THEN** the worker-to-main `__hostFetchForward` envelope SHALL include these four fields as populated strings
- **AND** the response sent back to the worker SHALL NOT include them
