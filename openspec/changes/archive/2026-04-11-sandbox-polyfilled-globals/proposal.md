## Why

Actions running in the QuickJS sandbox lack standard Web API globals (URL, TextEncoder, fetch, Headers, etc.), which prevents npm libraries from working inside action handlers. Currently `ctx.fetch` is a manually bridged method with a custom Response marshaller. Replacing it with standard globals backed by polyfills enables library imports and eliminates ~70 lines of custom marshalling code.

## What Changes

- Add polyfill packages bundled at build time into action modules: `mock-xmlhttprequest`, `whatwg-fetch`, `url-polyfill`, `fast-text-encoding`, `abort-controller`, `blob-polyfill`, `abab`, `@ungap/structured-clone`, `web-streams-polyfill`
- Create a virtual module (`@workflow-engine/sandbox-globals`) that sets up all polyfilled globals on `globalThis`, injected into every workflow build
- Add a single `__hostFetch` async bridge function that performs real HTTP via Node.js `fetch`, replacing the direct `ctx.fetch` bridge + `marshalResponse` + `marshalHeaders`
- Wire `mock-xmlhttprequest`'s `onSend` hook to call `__hostFetch`, enabling `whatwg-fetch` to work as a fully functional `fetch` polyfill
- Remove `bridgeFetch`, `marshalResponse`, `marshalHeaders` from bridge.ts
- Move `btoa`/`atob` from runtime bridge to build-time polyfill (via `abab`)
- Remove `fetch` method from `ActionContext` (logging replaced by bridge factory auto-logging)
- **BREAKING**: `ctx.fetch(url, init)` → `fetch(url, init)` in action handler code

## Capabilities

### New Capabilities

(None — all polyfill requirements are part of the existing `action-sandbox` capability)

### Modified Capabilities

- `action-sandbox`: Polyfill virtual module, `__hostFetch` bridge replaces `ctx.fetch` bridge, `marshalResponse`/`marshalHeaders` removed, btoa/atob moved to polyfill, tree-shaking
- `vite-plugin`: Virtual module plugin for `@workflow-engine/sandbox-globals`, injected into workflow build via `buildWorkflowModule()`
- `context`: `fetch` method removed from ActionContext
- `sdk`: ActionContext type updated — `fetch` removed from ctx

## Impact

- **Runtime sandbox** (`packages/runtime/src/sandbox/`): bridge.ts loses ~70 lines (bridgeFetch, marshalResponse, marshalHeaders), gains ~15 lines (__hostFetch bridge)
- **Runtime context** (`packages/runtime/src/context/`): fetch method and its logging wrapper removed
- **Vite plugin** (`packages/vite-plugin/`): new virtual module plugin, polyfill packages as devDependencies
- **SDK** (`packages/sdk/`): ActionContext type loses `fetch` property
- **Workflows**: All action handlers using `ctx.fetch` must change to `fetch` (breaking change)
- **Dependencies**: 9 new devDependencies on vite-plugin package (all pure JS, zero transitive Node.js deps)
