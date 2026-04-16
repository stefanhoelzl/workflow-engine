## MODIFIED Requirements

### Requirement: Sandbox package

The system SHALL provide a workspace package `@workflow-engine/sandbox` at `packages/sandbox`. The package SHALL ship TypeScript source directly (no build step), mirroring the conventions of `@workflow-engine/sdk` and `@workflow-engine/vite-plugin`. The package SHALL depend on `quickjs-wasi`; these dependencies SHALL NOT be direct dependencies of `@workflow-engine/runtime`.

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

The sandbox package SHALL export a `sandbox(source, methods, options?)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(
  source: string,
  methods: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: {
    filename?: string;
    fetch?: typeof globalThis.fetch;
    clock?: (clockId: number, precision: bigint) => bigint;
    random?: (bufPtr: number, bufLen: number, memory: WebAssembly.Memory) => void;
    memoryLimit?: number;
    interruptHandler?: () => boolean;
  }
): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint resolved via `new URL('./worker.js', import.meta.url)`.
2. Send the worker an `init` message carrying `source`, the method names of `methods`, `options.filename`, and serializable representations of `options.clock`, `options.random`, `options.memoryLimit`, and `options.interruptHandler`.
3. Register per-method main-side RPC handlers so that every `method` in `methods` is callable from guest code.
4. Inside the worker, instantiate the QuickJS WASM module via `QuickJS.create()` with the provided WASI overrides, memory limit, interrupt handler, and WASM extensions (url, encoding, base64, structured-clone, headers, crypto). Install the crypto Promise shim, the built-in host bridges (console, timers, `__hostFetch`), and the construction-time methods. Evaluate `source` as an IIFE script using `vm.evalCode(source, filename)`.
5. Wait for the worker to reply with a `ready` message confirming WASM initialization and successful source evaluation.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onDied()` calls are routed to the worker.

The returned promise SHALL NOT resolve until the worker has reported `ready`. If source evaluation fails or the worker exits during initialization, the promise SHALL reject with the underlying error and the worker SHALL be terminated before the rejection is raised.

#### Scenario: Construction evaluates source once

- **GIVEN** a valid IIFE source string
- **WHEN** `sandbox(source, {})` is called
- **THEN** the source SHALL be evaluated exactly once inside the worker at construction time
- **AND** the returned `Sandbox` object SHALL expose `run`, `dispose`, and `onDied` methods

#### Scenario: Construction rejects on source parse error

- **GIVEN** a source string with a syntax error
- **WHEN** `sandbox(source, {})` is called
- **THEN** the returned promise SHALL reject with an error describing the syntax failure
- **AND** the spawned worker SHALL be terminated before the rejection resolves

#### Scenario: Construction-time methods are installed as globals

- **GIVEN** `sandbox(source, { hello: async (n) => n * 2 })`
- **WHEN** source code inside the sandbox calls `hello(21)`
- **THEN** the guest call SHALL resolve to `42` via an RPC round-trip between the worker and the main thread

#### Scenario: Worker fails to spawn

- **GIVEN** a host environment where `new Worker(...)` throws synchronously
- **WHEN** `sandbox(source, {})` is called
- **THEN** the returned promise SHALL reject with the spawn error

### Requirement: Source evaluated as IIFE script

The sandbox SHALL evaluate `source` as a script (not an ES module) using `vm.evalCode(source, filename)`. The source SHALL be an IIFE bundle produced by the vite-plugin with `format: "iife"`. Named exports SHALL be accessible from the IIFE's global namespace object via `vm.getProp(vm.global, namespaceName)`.

#### Scenario: Named export handler

- **GIVEN** a source bundled as an IIFE that exposes `handler` on its namespace object
- **WHEN** `sb.run("handler", ctx)` is called
- **THEN** the `handler` function SHALL be extracted from the namespace and called

#### Scenario: Bundled IIFE with dependencies

- **GIVEN** a workflow bundle that includes npm packages resolved by vite-plugin, output as IIFE
- **WHEN** the sandbox evaluates the bundled script
- **THEN** evaluation SHALL succeed and named exports SHALL be callable

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals: the host methods registered via `methods` / `extraMethods`, the built-in host-bridged globals (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `__hostFetch`), and the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`).

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

#### Scenario: WASM extension globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `structuredClone`
- **THEN** each SHALL be a defined global provided by the WASM extensions

### Requirement: WebCrypto surface

The sandbox SHALL expose the W3C WebCrypto API: `crypto.randomUUID`, `crypto.getRandomValues`, and the `crypto.subtle` surface (`digest`, `importKey`, `exportKey`, `sign`, `verify`, `encrypt`, `decrypt`, `generateKey`, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey`).

WebCrypto SHALL be implemented by the WASM crypto extension running natively inside the QuickJS WASM context. A JS shim SHALL wrap all `crypto.subtle` methods to return Promises (via `Promise.resolve()`) for compatibility with the standard WebCrypto API.

`crypto.subtle.exportKey` SHALL support `"raw"`, `"pkcs8"`, and `"spki"` formats. `"jwk"` format SHALL NOT be supported in this version.

#### Scenario: crypto globals available

- **GIVEN** a sandbox
- **WHEN** guest code invokes `crypto.randomUUID()`, `crypto.getRandomValues(new Uint8Array(16))`, and `await crypto.subtle.digest("SHA-256", data)`
- **THEN** each call SHALL return a result consistent with the W3C WebCrypto specification

#### Scenario: crypto.subtle methods return Promises

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const p = crypto.subtle.digest("SHA-256", data); typeof p.then`
- **THEN** the result SHALL be `"function"` (the return value is a Promise)

#### Scenario: JWK export is not supported

- **GIVEN** a sandbox
- **WHEN** guest code calls `crypto.subtle.exportKey("jwk", key)`
- **THEN** the call SHALL reject with an error indicating unsupported format

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` via the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall. When a clock override is provided, `performance.now()` SHALL reflect the overridden clock. When no override is provided, `performance.now()` SHALL return real monotonic time.

#### Scenario: performance.now returns valid value

- **GIVEN** a sandbox
- **WHEN** guest code calls `performance.now()` twice
- **THEN** the second value SHALL be >= the first value

#### Scenario: performance.now respects clock override

- **GIVEN** a sandbox with a clock override that advances by 100ms between calls
- **WHEN** guest code calls `performance.now()` twice
- **THEN** the difference SHALL be approximately 100

### Requirement: Key material lives in WASM

`CryptoKey` objects inside the sandbox SHALL be native WASM crypto extension objects backed by PSA key handles in the WASM linear memory. Key material SHALL NOT cross the host/guest boundary. No opaque reference store SHALL be used for crypto keys.

The `CryptoKey` object SHALL expose read-only properties: `type`, `algorithm`, `extractable`, `usages`.

#### Scenario: CryptoKey metadata is readable

- **GIVEN** a CryptoKey generated inside the sandbox
- **WHEN** guest code reads `key.type`, `key.algorithm`, `key.extractable`, `key.usages`
- **THEN** the values SHALL match the generation parameters

#### Scenario: Non-extractable key cannot be exported

- **GIVEN** a CryptoKey with `extractable: false`
- **WHEN** guest code calls `crypto.subtle.exportKey(...)` on it
- **THEN** the operation SHALL reject

### Requirement: Residual risk — opaque store growth

This requirement is removed. The opaque reference store is no longer needed because CryptoKey objects live inside the WASM linear memory, managed by the WASM crypto extension. Key memory is freed when the VM is disposed. Residual risk R-S7 is eliminated.

## ADDED Requirements

### Requirement: Caller-provided clock override

The sandbox factory SHALL accept an optional `clock` function in the options parameter. When provided, the sandbox SHALL pass it to the WASI `clock_time_get` override at VM creation. The function SHALL receive a clock ID and precision, and SHALL return a bigint representing nanoseconds since the Unix epoch. When not provided, the default WASI clock behavior SHALL apply (real wall-clock time).

The clock override SHALL control `Date.now()`, `new Date()`, `Math.random()` seeding (QuickJS seeds its xorshift64* PRNG from the clock at context creation), and `performance.now()` (via the QuickJS performance intrinsic).

#### Scenario: Deterministic Date.now with clock override

- **GIVEN** a sandbox created with a clock override that returns a fixed time of 1700000000000ms
- **WHEN** guest code evaluates `Date.now()`
- **THEN** the result SHALL be `1700000000000`

#### Scenario: Deterministic Math.random with clock override

- **GIVEN** two sandboxes created with identical clock overrides
- **WHEN** both evaluate `Math.random()` immediately after creation
- **THEN** both SHALL return the same value

#### Scenario: Real clock when no override provided

- **GIVEN** a sandbox created without a clock option
- **WHEN** guest code evaluates `Date.now()`
- **THEN** the result SHALL approximate the host's current wall-clock time

### Requirement: Caller-provided randomness override

The sandbox factory SHALL accept an optional `random` function in the options parameter. When provided, the sandbox SHALL pass it to the WASI `random_get` override at VM creation. The function SHALL receive a pointer and length into the WASM linear memory and SHALL fill the specified region with bytes. When not provided, the default WASI random behavior SHALL apply (host crypto randomness).

The randomness override SHALL control `crypto.getRandomValues()`, `crypto.randomUUID()`, and all internal cryptographic randomness (key generation, IV generation, nonce generation) because the WASM crypto extension delegates all randomness to the WASI `random_get` syscall.

#### Scenario: Deterministic crypto.getRandomValues with random override

- **GIVEN** a sandbox created with a random override that fills buffers with incrementing bytes
- **WHEN** guest code evaluates `crypto.getRandomValues(new Uint8Array(4))`
- **THEN** the result SHALL be `Uint8Array([0, 1, 2, 3])`

#### Scenario: Deterministic crypto.randomUUID with random override

- **GIVEN** two sandboxes created with identical random overrides
- **WHEN** both evaluate `crypto.randomUUID()`
- **THEN** both SHALL return the same UUID string

#### Scenario: Deterministic key generation with random override

- **GIVEN** two sandboxes created with identical random overrides
- **WHEN** both evaluate `crypto.subtle.generateKey({name: "AES-GCM", length: 256}, true, ["encrypt"])` and export the key as raw bytes
- **THEN** both SHALL produce identical raw key bytes

#### Scenario: Real randomness when no override provided

- **GIVEN** a sandbox created without a random option
- **WHEN** guest code evaluates `crypto.getRandomValues(new Uint8Array(16))`
- **THEN** the result SHALL contain cryptographically random bytes from the host

### Requirement: Override options follow existing patterns

The clock and random overrides SHALL be accepted in the same options parameter as `filename` and `fetch`. They SHALL be optional and independent — a caller MAY provide one, both, or neither.

#### Scenario: Clock override without random override

- **GIVEN** a sandbox created with `{ clock: fixedClock }` but no `random` option
- **WHEN** guest code evaluates `Date.now()`
- **THEN** the result SHALL be controlled by the clock override
- **AND** `crypto.getRandomValues()` SHALL use real host randomness

#### Scenario: Both overrides provided

- **GIVEN** a sandbox created with `{ clock: fixedClock, random: seededRandom }`
- **WHEN** guest code evaluates `Date.now()` and `crypto.getRandomValues(...)`
- **THEN** both SHALL be controlled by their respective overrides

### Requirement: Memory limit configuration

The sandbox factory SHALL accept an optional `memoryLimit` number (in bytes) in the options parameter. When provided, the sandbox SHALL pass it to `QuickJS.create({ memoryLimit })`. Guest code that exceeds the limit SHALL trigger an out-of-memory error inside the QuickJS context.

#### Scenario: Memory limit enforced

- **GIVEN** a sandbox created with `{ memoryLimit: 1024 * 1024 }` (1 MB)
- **WHEN** guest code attempts to allocate memory exceeding 1 MB
- **THEN** the allocation SHALL fail with an error inside the QuickJS context
- **AND** the run SHALL return `{ ok: false, error: { message: ... } }`

#### Scenario: No memory limit by default

- **GIVEN** a sandbox created without a memoryLimit option
- **WHEN** guest code allocates memory
- **THEN** the default WASM linear memory limits SHALL apply

### Requirement: Interrupt handler configuration

The sandbox factory SHALL accept an optional `interruptHandler` function in the options parameter. When provided, the sandbox SHALL pass it to `QuickJS.create({ interruptHandler })`. The handler SHALL be called periodically during execution. If it returns `true`, execution SHALL be interrupted.

#### Scenario: Execution interrupted by handler

- **GIVEN** a sandbox created with an interrupt handler that returns `true` after 10000 calls
- **WHEN** guest code runs an infinite loop
- **THEN** execution SHALL be interrupted
- **AND** the run SHALL return `{ ok: false, error: { message: ... } }`

#### Scenario: No interrupt handler by default

- **GIVEN** a sandbox created without an interruptHandler option
- **WHEN** guest code runs a long computation
- **THEN** execution SHALL proceed without interruption

## REMOVED Requirements

### Requirement: Source evaluated as ES module

**Reason**: quickjs-wasi does not expose the ES module namespace from `evalCode`. Source is now evaluated as an IIFE script.
**Migration**: The vite-plugin outputs `format: "iife"` instead of `format: "es"`. The sandbox reads exports from the IIFE's global namespace object.

### Requirement: Key material never crosses the boundary

**Reason**: Replaced by "Key material lives in WASM". Keys no longer cross any boundary because they live entirely inside the WASM linear memory. The opaque reference store mechanism is removed.
**Migration**: Remove `storeOpaque` / `derefOpaque` and the opaque reference store from the bridge factory. The WASM crypto extension manages keys internally.
