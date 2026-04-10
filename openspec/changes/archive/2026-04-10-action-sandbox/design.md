## Context

Actions are user-provided async JavaScript functions that receive a `ctx` object with `event`, `env`, `emit()`, and `fetch()`. They currently execute directly in the Node.js process via `await action.handler(ctx)` in the scheduler, with full access to all Node.js APIs, filesystem, network, and environment variables.

The runtime needs to execute untrusted action code in isolation. The existing sandbox spec proposed `isolated-vm` (V8 isolates), but after evaluation, QuickJS compiled to WASM via `quickjs-emscripten` provides stronger isolation (WASM boundary vs V8 isolate boundary), no native dependencies, and a viable async bridging model.

The current build pipeline (Vite plugin) bundles all actions into a single `actions.js` ES module per workflow, which the loader dynamically imports to get handler function references. With sandboxing, actions must be loaded as source code strings and evaluated inside QuickJS.

## Goals / Non-Goals

**Goals:**

- Execute untrusted action code inside a QuickJS WASM sandbox with no access to host resources
- Expose only `ctx` (event, env, emit, fetch) and a minimal set of safe globals (btoa, atob, timers)
- Use the sync QuickJS variant with deferred promises for async bridging, supporting concurrent async operations (`Promise.all`)
- Design the `Sandbox` interface to support future migration to Worker threads without changing the scheduler
- Preserve the action authoring experience — actions remain `async (ctx) => { ... }` functions

**Non-Goals:**

- Resource limits (memory limits, CPU timeout via interrupt handler) — deferred, interface supports adding later via `AbortSignal`
- Worker thread isolation — deferred, current design runs QuickJS on the main thread
- Console/logging inside sandbox — deferred
- URL/URLSearchParams globals — deferred
- Streaming response bodies — `ctx.fetch()` returns a simplified Response proxy, no ReadableStream support

## Decisions

### Decision: QuickJS (WASM) over isolated-vm

QuickJS compiled to WASM via `quickjs-emscripten` provides the sandbox runtime.

**Alternatives considered:**
- `isolated-vm`: Strong V8 isolate, but requires native C++ addon (build issues on Alpine/ARM/CI), no native async/await (must use `applySyncPromise`), in maintenance mode
- `vm` module: Not a security boundary — trivially escapable, ruled out for untrusted code
- SES/Compartments: Same V8 heap — V8 bug = full escape, no memory/CPU limits
- Subprocess + seccomp: Strongest isolation but ~50-100ms startup, complex IPC, overkill for current needs

**Rationale:** WASM boundary is fundamentally stronger than V8 isolate boundary (escape requires a bug in V8's WASM runtime, not just the JS engine). No native deps means reliable CI/CD. Async bridging via deferred promises works naturally with the sync variant.

### Decision: Sync variant with deferred promises (not Asyncify)

Use `RELEASE_SYNC` variant with `vm.newPromise()` / `executePendingJobs()` for all async host operations.

**Alternatives considered:**
- Asyncify variant (`RELEASE_ASYNC`): Provides `newAsyncifiedFunction()` for transparent async bridging, but only supports ONE suspended async operation at a time — `Promise.all()` crashes. Also 2x larger WASM bundle and ~40% slower execution.

**Rationale:** The sync variant with deferred promises supports concurrent async operations (`Promise.all([ctx.fetch(...), ctx.fetch(...)])`), is faster, smaller, and uses a generic pattern for all async bridges. The execution model: `evalCode` returns a pending promise handle, `vm.resolvePromise()` converts it to a host promise, and Node.js event loop drives the action forward as host callbacks (fetch, emit, timers) resolve their deferreds and pump `executePendingJobs()`.

### Decision: Generic async bridge pattern

All async host operations (fetch, emit) follow one pattern: create a QuickJS deferred promise, do real async work on the host, resolve the deferred when done, pump `executePendingJobs()`.

Timers (`setTimeout`/`setInterval`) use the same pumping mechanism but aren't promise-based — they register a real Node.js timer, call the QuickJS callback when it fires, and pump pending jobs. Timer IDs are the real Node.js timer IDs passed through directly (no registry/map needed). `clearTimeout`/`clearInterval` pass through to Node.js directly.

### Decision: Sandbox interface with AbortSignal

```
Sandbox.spawn(source: string, ctx: ActionContext, signal?: AbortSignal): Promise<SandboxResult>
```

The scheduler creates an `AbortController` and passes `signal` to `spawn()`. Currently the signal is ignored. Future additions:
- Interrupt handler: `signal.addEventListener("abort", () => setInterruptHandler(() => true))`
- Worker thread: `signal.addEventListener("abort", () => worker.terminate())`
- Timeout: `AbortSignal.timeout(30_000)`

**Rationale:** `AbortSignal` is the standard cancellation primitive. It cleanly separates the "how to cancel" (sandbox internals) from "when to cancel" (scheduler policy).

### Decision: Sandbox injected into scheduler via createScheduler

```
createScheduler(workQueue, source, actions, createContext, sandbox)
```

`main.ts` creates the sandbox via `createSandbox()` and passes it to the scheduler factory. The scheduler calls `sandbox.spawn(action.source, ctx)` instead of `action.handler(ctx)`.

### Decision: SandboxResult as discriminated union (not exceptions)

```
type SandboxResult =
  | { ok: true }
  | { ok: false; error: { message: string; stack: string } }
```

Errors are values, not thrown exceptions. The scheduler pattern-matches on `result.ok` and stores the full error object (message + stack trace) in the event transition.

### Decision: One source file per action with default export

The Vite plugin emits `dist/{workflow}/{actionName}.js` per action, each containing `export default async (ctx) => { ... }`. The manifest's action entries reference individual module paths. The loader reads each file as a string via `readFile`.

**Alternatives considered:**
- Keep single `actions.js`, extract at load time: fragile string parsing at runtime
- Inline source in manifest.json: pollutes manifest with code, harder to debug

### Decision: Fetch Response proxy with Map headers

`ctx.fetch()` inside the sandbox returns a proxied Response with:
- Properties: `status`, `statusText`, `ok`, `url` (set as QuickJS values)
- `headers`: QuickJS `Map` constructed from response headers, keys normalized to lowercase
- `json()`: async host bridge — reads real response body, parses JSON, marshals result into QuickJS
- `text()`: async host bridge — reads real response body as text, returns QuickJS string

Excluded from proxy: `body` (ReadableStream), `blob()`, `arrayBuffer()`, `formData()`, `clone()`, `bodyUsed`, `redirected`, `type`.

### Decision: Fresh QuickJS context per invocation

Each `sandbox.spawn()` call creates a new `QuickJS.newContext()`, sets up globals and ctx bridge, evaluates the action, and disposes the context. No state persists between invocations.

The WASM module itself is instantiated once at `createSandbox()` time (expensive part). Creating a context from the module is cheap (~0.5-1ms).

## Risks / Trade-offs

**[Main thread blocking] → Deferred mitigation via Worker threads**
QuickJS `evalCode` and `executePendingJobs` run synchronously on the main thread. A CPU-intensive action between `await` points blocks Node.js. Current mitigation: none (actions assumed well-behaved). Future mitigation: move QuickJS to a Worker thread, or add interrupt handler with `AbortSignal.timeout()`.

**[QuickJS execution speed] → Acceptable for I/O-bound actions**
QuickJS is an interpreter, ~10-50x slower than V8 JIT for CPU-bound work. For typical actions (parse payload, call fetch, emit event), execution time is dominated by I/O, not computation. If CPU-heavy actions become a use case, Worker thread migration gives back V8 speed via `isolated-vm` or native QuickJS NAPI bindings.

**[Async bridging complexity] → Contained in sandbox module**
The deferred promise pattern requires careful handle management (`.dup()`, `.dispose()`, `executePendingJobs()` after every resolve). A missed dispose leaks memory, a missed pump deadlocks. Mitigation: all bridging logic contained in `sandbox/bridge.ts`, thoroughly tested.

**[Breaking changes] → Single coordinated release**
Action type, error format, manifest format, and build output all change simultaneously. All existing workflows must be rebuilt. Mitigation: no deployed production workflows yet — this is a pre-1.0 change.

**[WASM bundle size] → ~500KB acceptable**
The `RELEASE_SYNC` QuickJS WASM module adds ~500KB to the runtime. Acceptable for a server-side runtime.
