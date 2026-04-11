## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Fetch Response proxy

**Reason**: Replaced by spec-compliant Response objects constructed natively by whatwg-fetch inside QuickJS. The custom marshalResponse/marshalHeaders code is no longer needed.

**Migration**: Response objects are now standard — `.status`, `.statusText`, `.ok`, `.url`, `.headers` (real Headers object with `.get()`, `.has()`, etc.), `.json()`, `.text()` all work per spec. `response.headers` is a real `Headers` instance, not a `Map`.
