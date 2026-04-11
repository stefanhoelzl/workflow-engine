## Context

The sandbox bridge factory (`bridge-factory.ts`) provides a declarative API for registering sync/async bridges with auto-logging. Globals (`globals.ts`) registers btoa/atob, console, and timers. The sandbox lifecycle creates a fresh QuickJS context per action, runs the handler, and disposes everything in a finally block.

Actions need crypto for webhook signature verification (HMAC-SHA256), token generation (randomUUID), and general cryptographic operations. They need `performance.now()` for timing measurements. Neither is available in QuickJS by default.

CryptoKey objects from Node's WebCrypto are opaque host objects that cannot be serialized across the WASM boundary. This requires a reference-passing mechanism in the bridge factory.

## Goals / Non-Goals

**Goals:**
- Expose the full WebCrypto `crypto.subtle` API surface inside the sandbox
- Expose `crypto.randomUUID()` and `crypto.getRandomValues()` for non-subtle crypto
- Expose `performance.now()` with per-action origin for timing measurements
- Add a generic opaque reference store to the bridge factory for host objects
- Maintain sandbox isolation: no key material leaks into guest memory

**Non-Goals:**
- TextEncoder/TextDecoder (separate change)
- Streaming crypto APIs (e.g., DigestStream)
- Polyfilling full CryptoKey property access (type, algorithm, usages are metadata-only in guest)
- Limiting which crypto algorithms are available (delegate to Node's WebCrypto for policy)

## Decisions

### 1. CryptoKey representation in guest: frozen metadata object with `__opaqueId`

CryptoKey handles in the sandbox are frozen objects with read-only metadata and a numeric `__opaqueId` field:

```
┌─ QuickJS (guest) ────────────────────┐    ┌─ Node.js (host) ──────────┐
│                                      │    │                           │
│  key = {                             │    │  opaqueStore: Map<number, │
│    type: "secret",                   │    │    unknown>               │
│    algorithm: { name: "HMAC", ... }, │    │                           │
│    extractable: true,                │    │  1 → CryptoKey (real)     │
│    usages: ["sign", "verify"],       │    │  2 → CryptoKey (real)     │
│    __opaqueId: 1          ───────────┼────┼──▶ lookup by ID           │
│  }                                   │    │                           │
│  Object.freeze(key)                  │    │                           │
└──────────────────────────────────────┘    └───────────────────────────┘
```

**Why over bare numbers:** Faithful to WebCrypto shape — `key.type`, `key.algorithm`, `key.extractable`, `key.usages` are all readable. Helps debugging. `Object.freeze` prevents accidental mutation of `__opaqueId`.

**Why over full CryptoKey emulation:** The metadata is a snapshot, not a live proxy. This is much simpler and sufficient — actions inspect key properties for branching but don't modify them.

**Alternative considered:** Bare numeric handles. Simpler marshalling, but `typeof key === "number"` breaks duck-typing and gives no debugging info.

### 2. Bridge factory opaque store: two-level API

```
Bridge interface (generic):
├── storeOpaque(value) → number          // low-level: store, return ID
├── derefOpaque<T>(ref) → T             // look up by number or { __opaqueId }
├── opaqueRef(value) → QuickJSHandle    // marshal: store + vm.newNumber(id)
└── dispose()                           // clear map

Crypto setup (domain-specific):
└── marshalCryptoKey(b, key)            // storeOpaque + freeze({metadata, __opaqueId})
```

`derefOpaque` accepts both bare numbers and objects with `__opaqueId`, making it forward-compatible:

```ts
const id = typeof ref === "number" ? ref : (ref as {__opaqueId: number}).__opaqueId;
```

**Why two levels:** `opaqueRef` (bare numeric marshal) is useful for simple opaque types. `storeOpaque` is needed when domain code builds richer handles (CryptoKey metadata objects, future types). Exposing both avoids forcing domain code to fight the abstraction.

**Alternative considered:** Single `opaqueRef` that accepts optional metadata. Rejected — mixes marshalling concerns with domain logic in the generic bridge factory.

### 3. File organization: separate crypto.ts

```
sandbox/
├── bridge-factory.ts   ← opaque store added here
├── bridge.ts           ← ctx bridges (unchanged)
├── globals.ts          ← adds setupPerformance, calls setupCrypto
├── crypto.ts           ← NEW: setupCrypto (all subtle methods + randomUUID + getRandomValues)
├── index.ts            ← adds b.dispose() to finally block
└── sandbox.test.ts     ← new test cases
```

**Why separate file:** The 12 subtle methods + helpers + marshalCryptoKey would add ~250 lines to globals.ts. Follows the existing pattern where `bridge.ts` is separate from `globals.ts` despite both being setup functions called from `index.ts`.

### 4. Buffer conversion pattern

All data arguments (plaintext, ciphertext, signatures, IVs) cross the boundary as JSON number arrays and are converted to `Uint8Array` on the host side:

```
Guest: sign(algo, key, [104, 101, 108, 108, 111])
                              └─ JSON array ─────────────▶ Host: new Uint8Array([104,...])
Host:  Array.from(new Uint8Array(result))
                              └─ ArrayBuffer ────────────▶ Guest: [72, 101, ...]
```

Algorithm objects may contain buffer fields (`iv`, `counter`, `salt`, `info`, `label`, `additionalData`) or key fields (`public` for ECDH). A `resolveAlgo` helper shallow-copies the algo and converts known fields:

```ts
function resolveAlgo(algo, deref): object
  → buffer fields: Array → Uint8Array
  → key fields: { __opaqueId } → deref to real CryptoKey
```

**Why known-field approach:** WebCrypto algorithm parameter types are a closed set defined by the spec. Enumerating the buffer/key fields is exhaustive and avoids deep-walking arbitrary objects.

### 5. performance.now() origin

Origin is captured at `setupPerformance()` call time, which happens inside `spawn()` — effectively the action start time. Returns milliseconds elapsed since action start.

**Why per-action origin:** Matches browser behavior where `performance.now()` returns time relative to navigation start. Prevents leaking host uptime information.

## Risks / Trade-offs

**[Algorithm parameter conversion is field-name-based]** → The `resolveAlgo` helper converts a fixed list of known buffer/key fields. If Node.js adds new WebCrypto algorithms with new buffer fields, they won't be auto-converted. Mitigation: the field list covers all current W3C WebCrypto algorithms; new fields are a one-line addition.

**[CryptoKey metadata is a snapshot]** → The frozen metadata object in the guest is created at key creation time. If Node's CryptoKey properties could change (they can't in practice), the guest copy would be stale. Mitigation: CryptoKey properties are immutable by spec.

**[No opaque store size limit]** → A malicious action could generate unlimited keys to exhaust host memory. Mitigation: actions already have a timeout; the opaque store is cleared on dispose. A size limit could be added later if needed.

**[`__opaqueId` is visible in guest]** → Actions can see the numeric ID. This is not a security concern since: (a) the sandbox is already isolated, (b) IDs only reference objects within the same spawn's store, (c) guessing IDs gives no advantage beyond what the action already has access to.
