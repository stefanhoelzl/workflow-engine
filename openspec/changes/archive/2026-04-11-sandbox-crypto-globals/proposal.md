## Why

Actions running in the QuickJS sandbox cannot generate UUIDs, compute hashes, sign/verify data, or measure execution time. These are common needs for webhook signature verification, HMAC authentication, and performance monitoring. Adding `crypto` and `performance` bridged globals removes the need for authors to work around missing APIs or delegate crypto to external services.

## What Changes

- Expose `crypto.subtle.*` (all 12 WebCrypto methods) as async bridges delegating to Node.js `crypto.subtle`
- Expose `crypto.randomUUID()` and `crypto.getRandomValues()` as sync bridges
- Expose `performance.now()` as a sync bridge with origin = action start time
- Add opaque reference store to the bridge factory for CryptoKey handles (keys cannot cross the WASM boundary)
- Add `dispose()` to the bridge lifecycle for opaque store cleanup

## Capabilities

### New Capabilities

None — all new requirements fit within the existing `action-sandbox` capability.

### Modified Capabilities

- `action-sandbox`: Safe globals list expands to include `crypto` and `performance` objects; bridge factory gains opaque reference store; bridge lifecycle gains `dispose()` step

## Impact

- `packages/runtime/src/sandbox/bridge-factory.ts` — new opaque store primitives (`storeOpaque`, `derefOpaque`, `opaqueRef`, `dispose`)
- `packages/runtime/src/sandbox/globals.ts` — wires up crypto and performance setup
- `packages/runtime/src/sandbox/crypto.ts` — new file with all crypto bridges
- `packages/runtime/src/sandbox/index.ts` — calls `b.dispose()` in finally block
- No API changes, no manifest changes, no EventBus impact
- All changes are additive — existing sandbox behavior is unchanged
