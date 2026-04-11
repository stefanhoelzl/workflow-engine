## Context

The QuickJS sandbox currently bridges `ctx.fetch` directly — the host marshals Response objects property-by-property across the VM boundary (~70 lines). Actions cannot use npm libraries that expect standard Web API globals (URL, TextEncoder, Headers, fetch, etc.) because those globals don't exist in QuickJS.

Phase 1 (bridge factory) and Phase 2 (per-action Rollup entry points with ES module eval) are complete. The build pipeline now produces self-contained ES module bundles per workflow. This phase adds polyfill packages to those bundles and replaces the direct fetch bridge with an XHR-based approach.

## Goals / Non-Goals

**Goals:**
- Provide standard Web API globals so npm libraries (API clients, etc.) work inside actions
- Replace `ctx.fetch` with a standard global `fetch` backed by polyfilled XHR
- Eliminate custom Response/Headers marshalling code
- Tree-shake unused polyfills per workflow via Rollup

**Non-Goals:**
- Streaming responses (whatwg-fetch uses XHR internally, which buffers the full body)
- Node.js-specific APIs (Buffer, fs, http, child_process)
- Polyfilling ES language features (QuickJS already has ES2023 built-ins)

## Decisions

### 1. XHR bridge via mock-xmlhttprequest + whatwg-fetch

**Decision:** Bridge a single `__hostFetch` function. Polyfill XHR (`mock-xmlhttprequest`) and fetch (`whatwg-fetch`) entirely inside QuickJS. The MockXhr `onSend` hook calls `__hostFetch` to perform real HTTP on the host.

**Alternatives considered:**
- **Bridge fetch directly:** Simpler (~130 lines) but requires custom marshalResponse/marshalHeaders. Libraries using XHR don't work. FormData body serialization needs custom handling. Response/Headers are simplified, not spec-compliant.
- **Bridge XHR manually:** Full spec compliance but ~400-500 lines of stateful bridge code for the XHR lifecycle (open, send, abort, events, readyState).

**Rationale:** mock-xmlhttprequest handles the entire XHR spec as pure JS with an `onSend` interception hook. whatwg-fetch provides spec-compliant fetch/Headers/Request/Response/FormData on top. The bridge collapses to one async function (~15 lines). XHR-based libraries (axios, etc.) also work.

### 2. Virtual module for polyfill injection

**Decision:** Create a `@workflow-engine/sandbox-globals` virtual module resolved by a Vite plugin in `buildWorkflowModule()`. Inject it via `transform()` at the top of the workflow entry.

**Alternatives considered:**
- **Runtime polyfill eval:** eval a polyfill bundle inside QuickJS at spawn time. Simpler but no tree-shaking, every action pays the full polyfill cost.
- **Explicit imports by action authors:** Actions import what they need from `@workflow-engine/globals`. Most explicit but breaks the "just works" goal.

**Rationale:** Build-time injection with tree-shaking gives the best of both worlds — all globals are available, but unused ones are eliminated per workflow. No action author burden.

### 3. Host-side `__hostFetch` uses Node.js `globalThis.fetch`

**Decision:** The `__hostFetch` bridge calls Node.js's native `globalThis.fetch` directly, not `ctx.fetch`.

**Rationale:** `ctx.fetch` no longer exists — fetch is now a polyfill. The ActionContext `fetch` method and its logging wrapper are removed. Logging is handled by the bridge factory's auto-logging on `__hostFetch` invocations.

### 4. btoa/atob move from bridge to polyfill

**Decision:** Replace the bridged `btoa`/`atob` in `globals.ts` with the `abab` polyfill package bundled at build time.

**Rationale:** btoa/atob are pure computation — no host I/O needed. Moving them to polyfills removes bridge overhead and two bridge registrations.

### 5. Import order: mock-xmlhttprequest before whatwg-fetch

**Decision:** The virtual module sets `globalThis.XMLHttpRequest` before importing whatwg-fetch.

**Rationale:** whatwg-fetch auto-installs `fetch`, `Headers`, `Request`, `Response` on `globalThis` at import time (if `fetch` is absent). It checks for `XMLHttpRequest` at call time (inside each `fetch()` invocation), not at import time. So import order technically doesn't matter for correctness, but setting XHR first is clearer and avoids any future edge cases.

## Risks / Trade-offs

**[No streaming support]** → whatwg-fetch buffers the full response body via XHR. Streaming would require replacing whatwg-fetch with a custom fetch implementation using ReadableStream bridges. Acceptable for the API-client use case (small JSON responses). Can be revisited if large-response use cases emerge.

**[Polyfill bundle size]** → ~30KB gzipped across all polyfills added to each workflow bundle. Mitigated by Rollup tree-shaking — unused polyfills are eliminated. Acceptable given that action bundles are evaluated once per sandbox spawn, not served to browsers.

**[Polyfill quirks]** → Third-party polyfills may have edge-case differences from native implementations. Mitigated by choosing well-maintained, high-adoption packages (whatwg-fetch: 18M dl/wk, abort-controller: 40M dl/wk, etc.).

**[Breaking change: ctx.fetch → fetch]** → All existing action handlers must update. Mitigated by the change being a simple find-replace (`ctx.fetch` → `fetch`). Only one workflow exists currently (cronitor).

**[mock-xmlhttprequest onSend is async (microtask)]** → `onSend` fires via `Promise.resolve().then(...)`, not synchronously after `xhr.send()`. This matches whatwg-fetch's expectations since it sets `xhr.onload`/`xhr.onerror` before calling `send()`.
