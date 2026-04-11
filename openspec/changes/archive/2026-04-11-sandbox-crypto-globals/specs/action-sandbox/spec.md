## ADDED Requirements

### Requirement: crypto.randomUUID sync bridge

The sandbox SHALL expose `crypto.randomUUID()` as a sync bridge that delegates to Node.js `crypto.randomUUID()`. The return value SHALL be a string in UUID v4 format.

#### Scenario: Generate a UUID

- **GIVEN** action code that calls `crypto.randomUUID()`
- **WHEN** the action executes in the sandbox
- **THEN** the result is a string matching the pattern `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
- **AND** a LogEntry is pushed with `method: "randomUUID"` and `status: "ok"`

### Requirement: crypto.getRandomValues sync bridge

The sandbox SHALL expose `crypto.getRandomValues(typedArray)` as a sync bridge. The argument SHALL be a JSON number array representing the typed array. The bridge SHALL fill it with cryptographically secure random bytes via Node.js `crypto.getRandomValues()` and return the filled array as a JSON number array.

#### Scenario: Fill array with random bytes

- **GIVEN** action code that calls `crypto.getRandomValues(new Array(16).fill(0))`
- **WHEN** the action executes in the sandbox
- **THEN** the result is an array of 16 numbers
- **AND** the array is not all zeros (with overwhelming probability)
- **AND** a LogEntry is pushed with `method: "getRandomValues"` and `status: "ok"`

### Requirement: crypto.subtle.digest async bridge

The sandbox SHALL expose `crypto.subtle.digest(algorithm, data)` as an async bridge. The `algorithm` argument SHALL be a JSON object (e.g., `"SHA-256"` or `{ name: "SHA-256" }`). The `data` argument SHALL be a JSON number array representing bytes. The bridge SHALL delegate to Node.js `crypto.subtle.digest()` and return the hash as a JSON number array.

#### Scenario: Compute SHA-256 digest

- **GIVEN** action code that calls `await crypto.subtle.digest("SHA-256", [104, 101, 108, 108, 111])`
- **WHEN** the action executes in the sandbox
- **THEN** the result is a 32-element number array matching the SHA-256 hash of "hello"
- **AND** a LogEntry is pushed with `method: "crypto.subtle.digest"` and `status: "ok"`

#### Scenario: Digest with algorithm object

- **GIVEN** action code that calls `await crypto.subtle.digest({ name: "SHA-512" }, data)`
- **WHEN** the action executes
- **THEN** the result is a 64-element number array

### Requirement: crypto.subtle.importKey async bridge

The sandbox SHALL expose `crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages)` as an async bridge. For `"raw"`, `"pkcs8"`, and `"spki"` formats, `keyData` SHALL be a JSON number array converted to `Uint8Array`. For `"jwk"` format, `keyData` SHALL be a JSON object passed directly. The bridge SHALL delegate to Node.js `crypto.subtle.importKey()` and return a frozen CryptoKey handle object.

#### Scenario: Import raw HMAC key

- **GIVEN** action code that imports a raw key for HMAC-SHA256
- **WHEN** `await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])` resolves
- **THEN** the result is a frozen object with `type: "secret"`, `algorithm.name: "HMAC"`, `extractable: false`, `usages: ["sign", "verify"]`, and a numeric `__opaqueId`

#### Scenario: Import JWK key

- **GIVEN** action code that imports a JWK-format key
- **WHEN** `await crypto.subtle.importKey("jwk", jwkObject, algorithm, extractable, usages)` resolves
- **THEN** the result is a frozen CryptoKey handle object
- **AND** the JWK object is passed directly to Node.js without buffer conversion

### Requirement: crypto.subtle.sign async bridge

The sandbox SHALL expose `crypto.subtle.sign(algorithm, key, data)` as an async bridge. The `key` argument SHALL be a CryptoKey handle (object with `__opaqueId`). The bridge SHALL dereference the opaque handle to obtain the real CryptoKey, convert `data` from JSON number array to `Uint8Array`, delegate to Node.js `crypto.subtle.sign()`, and return the signature as a JSON number array.

#### Scenario: Sign data with HMAC key

- **GIVEN** an imported HMAC key handle and data bytes
- **WHEN** `await crypto.subtle.sign("HMAC", key, data)` resolves
- **THEN** the result is a number array containing the HMAC signature
- **AND** a LogEntry is pushed with `method: "crypto.subtle.sign"` and `status: "ok"`

#### Scenario: Sign with invalid key handle

- **GIVEN** action code that passes an invalid key reference to sign
- **WHEN** the bridge attempts to dereference the key
- **THEN** the promise rejects with an error
- **AND** a LogEntry is pushed with `status: "failed"`

### Requirement: crypto.subtle.verify async bridge

The sandbox SHALL expose `crypto.subtle.verify(algorithm, key, signature, data)` as an async bridge. The bridge SHALL dereference the key handle, convert `signature` and `data` from JSON number arrays to `Uint8Array`, delegate to Node.js `crypto.subtle.verify()`, and return a boolean.

#### Scenario: Verify valid signature

- **GIVEN** an HMAC key, data bytes, and a valid signature produced by `sign()`
- **WHEN** `await crypto.subtle.verify("HMAC", key, signature, data)` resolves
- **THEN** the result is `true`

#### Scenario: Verify tampered data

- **GIVEN** an HMAC key, a signature, and different data than what was signed
- **WHEN** `await crypto.subtle.verify("HMAC", key, signature, wrongData)` resolves
- **THEN** the result is `false`

### Requirement: crypto.subtle.encrypt and decrypt async bridges

The sandbox SHALL expose `crypto.subtle.encrypt(algorithm, key, data)` and `crypto.subtle.decrypt(algorithm, key, data)` as async bridges. The bridge SHALL dereference the key handle, resolve algorithm buffer fields (`iv`, `counter`, `additionalData`) from JSON number arrays to `Uint8Array`, convert `data`, delegate to Node.js, and return the result as a JSON number array.

#### Scenario: AES-GCM encrypt and decrypt round-trip

- **GIVEN** an AES-GCM key and plaintext bytes
- **WHEN** `await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, key, plaintext)` resolves
- **AND** `await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ciphertext)` resolves
- **THEN** the decrypted result matches the original plaintext

#### Scenario: Decrypt with wrong key fails

- **GIVEN** ciphertext encrypted with key A
- **WHEN** `await crypto.subtle.decrypt(algo, keyB, ciphertext)` is called
- **THEN** the promise rejects with an error
- **AND** a LogEntry is pushed with `status: "failed"`

### Requirement: crypto.subtle.generateKey async bridge

The sandbox SHALL expose `crypto.subtle.generateKey(algorithm, extractable, keyUsages)` as an async bridge. When the algorithm produces a single key (AES, HMAC), the bridge SHALL return a frozen CryptoKey handle. When the algorithm produces a key pair (RSA, EC), the bridge SHALL return a plain object with `publicKey` and `privateKey` fields, each a frozen CryptoKey handle.

#### Scenario: Generate AES-GCM key

- **GIVEN** action code that calls `await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])`
- **WHEN** the action executes
- **THEN** the result is a frozen CryptoKey handle with `type: "secret"` and a numeric `__opaqueId`

#### Scenario: Generate ECDSA key pair

- **GIVEN** action code that calls `await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])`
- **WHEN** the action executes
- **THEN** the result is `{ publicKey: { type: "public", ..., __opaqueId: N }, privateKey: { type: "private", ..., __opaqueId: M } }`
- **AND** both key objects are frozen

### Requirement: crypto.subtle.exportKey async bridge

The sandbox SHALL expose `crypto.subtle.exportKey(format, key)` as an async bridge. The bridge SHALL dereference the key handle and delegate to Node.js. For `"raw"`, `"pkcs8"`, `"spki"` formats, the result SHALL be a JSON number array. For `"jwk"` format, the result SHALL be a JSON object.

#### Scenario: Export raw key

- **GIVEN** an extractable AES key imported from raw bytes
- **WHEN** `await crypto.subtle.exportKey("raw", key)` resolves
- **THEN** the result is a number array matching the original key bytes

#### Scenario: Export as JWK

- **GIVEN** an extractable key
- **WHEN** `await crypto.subtle.exportKey("jwk", key)` resolves
- **THEN** the result is a JWK object with `kty`, `k`, and other fields

#### Scenario: Export non-extractable key fails

- **GIVEN** a key imported with `extractable: false`
- **WHEN** `await crypto.subtle.exportKey("raw", key)` is called
- **THEN** the promise rejects with an error

### Requirement: crypto.subtle.deriveBits and deriveKey async bridges

The sandbox SHALL expose `crypto.subtle.deriveBits(algorithm, baseKey, length)` and `crypto.subtle.deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages)` as async bridges. The bridge SHALL dereference the `baseKey` handle, resolve algorithm buffer fields (`salt`, `info`) and key fields (`public` for ECDH) via `resolveAlgo`, and delegate to Node.js. `deriveBits` SHALL return a JSON number array. `deriveKey` SHALL return a frozen CryptoKey handle.

#### Scenario: PBKDF2 deriveBits

- **GIVEN** a PBKDF2 base key, salt bytes, and iteration count
- **WHEN** `await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, baseKey, 256)` resolves
- **THEN** the result is a 32-element number array

#### Scenario: ECDH deriveKey with public key reference

- **GIVEN** an ECDH key pair where the algorithm references `{ name: "ECDH", public: otherPublicKey }`
- **WHEN** `deriveKey` is called with the algorithm containing an opaque key reference in the `public` field
- **THEN** the bridge dereferences the `public` field's opaque handle before calling Node.js

### Requirement: crypto.subtle.wrapKey and unwrapKey async bridges

The sandbox SHALL expose `crypto.subtle.wrapKey(format, key, wrappingKey, wrapAlgo)` and `crypto.subtle.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, keyUsages)` as async bridges. `wrapKey` SHALL dereference both `key` and `wrappingKey` handles and return the wrapped key as a JSON number array. `unwrapKey` SHALL dereference the `unwrappingKey` handle, convert `wrappedKey` from a JSON number array, and return a frozen CryptoKey handle.

#### Scenario: Wrap and unwrap key round-trip

- **GIVEN** a key to wrap and a wrapping key (AES-KW)
- **WHEN** `wrapKey("raw", keyToWrap, wrappingKey, "AES-KW")` resolves
- **AND** `unwrapKey("raw", wrappedBytes, wrappingKey, "AES-KW", { name: "AES-GCM", length: 256 }, true, ["encrypt"])` resolves
- **THEN** the unwrapped key is a valid CryptoKey handle

### Requirement: CryptoKey handle is a frozen metadata object

CryptoKey handles returned to the sandbox SHALL be frozen JavaScript objects containing:
- `type`: `"secret"`, `"public"`, or `"private"`
- `algorithm`: a snapshot of the key's algorithm parameters
- `extractable`: boolean
- `usages`: string array of key usages
- `__opaqueId`: numeric identifier referencing the real CryptoKey in the host opaque store

The object SHALL be created via `Object.freeze()` so that all properties are read-only. The actual CryptoKey material SHALL never enter QuickJS memory.

#### Scenario: Key handle properties are readable

- **GIVEN** an HMAC key imported with `extractable: true` and usages `["sign", "verify"]`
- **WHEN** the action inspects the key handle
- **THEN** `key.type` is `"secret"`, `key.extractable` is `true`, `key.usages` contains `"sign"` and `"verify"`, `key.algorithm.name` is `"HMAC"`

#### Scenario: Key handle is immutable

- **GIVEN** a CryptoKey handle in the sandbox
- **WHEN** the action attempts to set `key.__opaqueId = 999`
- **THEN** the assignment has no effect (object is frozen)
- **AND** subsequent use of the key still references the original CryptoKey

#### Scenario: Key material does not leak to guest

- **GIVEN** a non-extractable CryptoKey
- **WHEN** the action inspects all properties of the key handle
- **THEN** no raw key bytes are present — only `type`, `algorithm`, `extractable`, `usages`, and `__opaqueId`

### Requirement: performance.now sync bridge

The sandbox SHALL expose `performance.now()` as a sync bridge. The origin SHALL be captured at action setup time (when `setupPerformance()` is called inside `spawn()`). The return value SHALL be `performance.now() - origin` in milliseconds, representing elapsed time since the action started.

#### Scenario: performance.now returns elapsed time

- **GIVEN** action code that calls `performance.now()` at the start of the handler
- **WHEN** the action executes
- **THEN** the result is a number >= 0
- **AND** a LogEntry is pushed with `method: "performance.now"` and `status: "ok"`

#### Scenario: performance.now increases over time

- **GIVEN** action code that calls `performance.now()` before and after a `setTimeout(resolve, 50)`
- **WHEN** the action executes
- **THEN** the second call returns a value greater than the first

#### Scenario: performance.now origin is per-action

- **GIVEN** two separate `spawn()` calls
- **WHEN** each action calls `performance.now()` immediately
- **THEN** both return values near 0 (not accumulated from previous actions)

### Requirement: Bridge opaque reference store

The `Bridge` SHALL provide an opaque reference store for host objects that cannot be serialized into QuickJS. The store SHALL be scoped to a single bridge instance (one per `spawn()` call).

The `Bridge` interface SHALL expose:
- `storeOpaque(value: unknown): number` — stores a host object and returns a numeric ID
- `derefOpaque<T>(ref: unknown): T` — looks up a stored object by numeric ID or by an object with `__opaqueId` property; throws if the reference is invalid
- `opaqueRef: (value: unknown) => QuickJSHandle` — a marshal function that stores the value and returns `vm.newNumber(id)` (simple numeric handle)
- `dispose(): void` — clears the opaque store, releasing all stored references

#### Scenario: Store and retrieve an opaque reference

- **GIVEN** a bridge instance
- **WHEN** `b.storeOpaque(hostObject)` is called
- **THEN** a numeric ID is returned
- **AND** `b.derefOpaque(id)` returns the same `hostObject`

#### Scenario: Dereference from object with __opaqueId

- **GIVEN** a stored object with ID 1
- **WHEN** `b.derefOpaque({ __opaqueId: 1, type: "secret" })` is called
- **THEN** the stored object is returned

#### Scenario: Dereference invalid reference throws

- **GIVEN** a bridge instance with no stored objects
- **WHEN** `b.derefOpaque(999)` is called
- **THEN** an error is thrown with a message indicating the reference is invalid

#### Scenario: Dispose clears the opaque store

- **GIVEN** a bridge instance with stored objects
- **WHEN** `b.dispose()` is called
- **THEN** all stored references are released
- **AND** subsequent `derefOpaque` calls for those IDs throw

### Requirement: Bridge dispose in sandbox lifecycle

The sandbox `spawn()` method SHALL call `b.dispose()` in its finally block, after timer cleanup and before QuickJS context disposal. This ensures opaque host references are released even if the action fails.

#### Scenario: Dispose called after successful action

- **GIVEN** an action that creates CryptoKey handles
- **WHEN** the action completes successfully
- **THEN** `b.dispose()` is called in the finally block
- **AND** all opaque references are released

#### Scenario: Dispose called after failed action

- **GIVEN** an action that creates CryptoKey handles and then throws
- **WHEN** the action fails
- **THEN** `b.dispose()` is called in the finally block
- **AND** all opaque references are released

## MODIFIED Requirements

### Requirement: Safe globals

The sandbox SHALL expose the following globals and no others:
- `btoa(string): string`
- `atob(string): string`
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

Timer callbacks SHALL trigger `vm.runtime.executePendingJobs()` after execution to pump any pending QuickJS promises.

#### Scenario: btoa/atob encoding

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

#### Scenario: console.warn captures to logs

- **GIVEN** action code that calls `console.warn("slow query")`
- **WHEN** the action executes
- **THEN** `SandboxResult.logs` contains an entry with `method: "console.warn"` and `args: ["slow query"]`

#### Scenario: console.error captures to logs

- **GIVEN** action code that calls `console.error("failed:", { code: 500 })`
- **WHEN** the action executes
- **THEN** `SandboxResult.logs` contains an entry with `method: "console.error"` and `args: ["failed:", { code: 500 }]`

#### Scenario: crypto globals are available

- **GIVEN** action code that accesses `crypto.subtle` and `performance`
- **WHEN** the action executes
- **THEN** both are defined objects (not `undefined`)

#### Scenario: performance.now is available

- **GIVEN** action code that calls `performance.now()`
- **WHEN** the action executes
- **THEN** the result is a number >= 0
