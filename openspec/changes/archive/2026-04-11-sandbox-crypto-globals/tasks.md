## 1. Bridge Factory — Opaque Reference Store

- [x] 1.1 Add `storeOpaque`, `derefOpaque`, `opaqueRef`, `dispose` to Bridge interface in `bridge-factory.ts`
- [x] 1.2 Implement opaque store (Map + counter), `storeOpaque`, `derefOpaque` (handle both number and `{__opaqueId}` shapes), `opaqueRef` marshal, and `dispose` inside `createBridge` closure
- [x] 1.3 Add `b.dispose()` call in `index.ts` finally block (before `vm.dispose()`)

## 2. Crypto Globals

- [x] 2.1 Create `crypto.ts` with `setupCrypto(b: Bridge)` scaffold — crypto object, subtle object, global registration, handle disposal
- [x] 2.2 Implement `marshalCryptoKey` helper — reads CryptoKey metadata (type, algorithm, extractable, usages), stores via `storeOpaque`, returns `Object.freeze`d handle with `__opaqueId`
- [x] 2.3 Implement buffer helpers — `toBuffer(data)`, `fromBuffer(buf)`, `resolveAlgo(algo, deref)` for iv/counter/salt/info/label/additionalData/public fields
- [x] 2.4 Implement `crypto.randomUUID` and `crypto.getRandomValues` sync bridges
- [x] 2.5 Implement `crypto.subtle.digest` async bridge
- [x] 2.6 Implement `crypto.subtle.importKey` async bridge (raw/pkcs8/spki buffer conversion, jwk passthrough, marshalCryptoKey)
- [x] 2.7 Implement `crypto.subtle.exportKey` async bridge (deref key, fromBuffer for non-jwk)
- [x] 2.8 Implement `crypto.subtle.sign` and `crypto.subtle.verify` async bridges
- [x] 2.9 Implement `crypto.subtle.encrypt` and `crypto.subtle.decrypt` async bridges (resolveAlgo for iv/counter)
- [x] 2.10 Implement `crypto.subtle.generateKey` async bridge with custom marshal (single key vs key pair)
- [x] 2.11 Implement `crypto.subtle.deriveBits` and `crypto.subtle.deriveKey` async bridges (resolveAlgo for salt/info/public)
- [x] 2.12 Implement `crypto.subtle.wrapKey` and `crypto.subtle.unwrapKey` async bridges

## 3. Performance Global

- [x] 3.1 Add `setupPerformance(b: Bridge)` in `globals.ts` — capture origin, sync bridge for `now()`
- [x] 3.2 Wire up `setupCrypto` and `setupPerformance` calls in `setupGlobals`

## 4. Tests

- [x] 4.1 Test `crypto.randomUUID` returns valid UUID format
- [x] 4.2 Test `crypto.getRandomValues` returns filled array of correct length
- [x] 4.3 Test `crypto.subtle.digest` SHA-256 produces correct hash
- [x] 4.4 Test `crypto.subtle.importKey` + `sign` + `verify` round-trip (HMAC)
- [x] 4.5 Test `crypto.subtle.verify` returns false for tampered data
- [x] 4.6 Test `crypto.subtle.generateKey` returns single key (AES-GCM) and key pair (ECDSA)
- [x] 4.7 Test `crypto.subtle.encrypt` + `decrypt` AES-GCM round-trip
- [x] 4.8 Test `crypto.subtle.exportKey` matches original imported bytes
- [x] 4.9 Test CryptoKey handle is frozen object with metadata, not raw key material
- [x] 4.10 Test invalid opaque reference produces failed log entry
- [x] 4.11 Test `performance.now` returns number >= 0 and increases over time
- [x] 4.12 Run `pnpm validate` — lint, format, typecheck, tests all pass
