## Why

Sandbox plugin handlers run inside the `worker_threads` worker and today reach only external resources they can open themselves (sockets, files). A growing class of host-backed APIs needs a **main-thread-only singleton** — e.g. the DuckDB instance, the workflow registry, cross-invocation coordination — which physically lives in the host process and cannot be reached from the worker's separate heap. There is currently no worker→main request/response channel: the worker only emits one-way `event`/`log` messages and the `done` run result. This change adds that missing channel as a generic primitive so future host-backed APIs can be built on it without inventing a bespoke transport each time.

## What Changes

- Add a generic, async **host-call channel** so a plugin's worker-side handler can invoke a named handler on the main thread and `await` the result. Vocabulary: this is the **host-call channel** (`callHost` / "host handlers"); it is distinct from the existing guest↔worker **bridge RPC** and the term "RPC" is intentionally avoided to prevent collision.
- **Protocol (sandbox):** `WorkerToMain` gains `{type:"host-call-request"; id; method; args}`; `MainToWorker` gains `{type:"host-call-response"; id; ok; result?; error?}`. Correlation is by monotonic per-run `id`; transport is async over the existing worker port (no `SharedArrayBuffer`/`Atomics`).
- **Sandbox factory surface:** `sandbox()` / `factory.create()` gains an optional `hostHandlers` map (`{ method → (args) => Promise<unknown> }`). The sandbox core stays method-agnostic — it routes by string and never interprets the payload.
- **Plugin surface:** the plugin context gains `callHost(method, args): Promise<unknown>`, generic over a per-plugin `HostApi` type (default: no host calls). Calling an unregistered method rejects.
- **Typing convention:** a host-backed capability declares a **contract module** (Zod `{args, result}` per method; `z.infer` yields the `HostApi` type). The worker imports the type only (`import type`, so no Zod enters the worker bundle); the runtime imports the schema values to build validated handlers. A thin `defineHostMethod(name, contract, handler)` runtime helper wraps each handler with main-side `args` validation.
- **Lifecycle:** pending host-calls are **rejected on the worker side at run end** (mirroring the existing dispose semantics for in-flight bridge calls); main-side handlers run to completion and their results are dropped. No `AbortSignal`, no per-RPC timeout (the existing run watchdog bounds a hung call), no dedicated payload cap (relies on `memoryLimit` + watchdog).
- **Observability:** the transport emits no events; observability rides the guest-facing descriptor's existing `pluginRequest` framing when a real consumer adds one.
- **Tests:** ship a test-only plugin + test `hostHandlers` map exercising a full worker→main→worker round-trip (happy path, error path, run-end rejection), plus targeted unit tests for correlation/serialization.
- **Out of scope (future consumers):** no DuckDB API, no real host methods, no DB file layout, no guest-facing surface. This change builds only the channel + typing convention. No SDK or `demo.ts` change is triggered (the guest never sees `callHost`).

## Capabilities

### New Capabilities
<!-- none; the host-call surface is the existing plugin contract, extended in place -->

### Modified Capabilities
- `sandbox`: add the `host-call-request`/`host-call-response` protocol messages, the `hostHandlers` factory option, and the run-end rejection requirement for in-flight host-calls.
- `sandbox-plugin`: add `callHost` to the plugin context (generic over `HostApi`), the contract-module + main-side-validation convention, and the unknown-method rejection rule.
- `host-security-baseline`: treat the worker→main host-call as a new trust boundary — args validated main-side, handlers scoped to `(owner, workflow)`, `callHost` not guest-reachable (worker-plugin-only). Reflected in `SECURITY.md §2`.

## Impact

- **Code:** `packages/sandbox/src/protocol.ts` (message unions), `sandbox.ts` (`onPersistentMessage` response branch, `hostHandlers` wiring, run-end pending rejection), `factory.ts` (`hostHandlers` plumbed through `create`), `plugin.ts` (`callHost` on context, `PluginContext<HostApi>` generic), `worker.ts` (worker-side pending map + request post). `packages/runtime/src/sandbox-store.ts` (builds the per-sandbox `hostHandlers` map) and a new `defineHostMethod` helper + contract-module convention in the runtime.
- **APIs:** new optional `hostHandlers` on the sandbox factory; new `ctx.callHost`. Both additive — existing plugins and callers are unaffected.
- **Security:** new worker→main boundary; `SECURITY.md §2` updated.
- **No changes** to manifest format, SDK author surface, `demo.ts`, the event/audit pipeline, or persistence.
