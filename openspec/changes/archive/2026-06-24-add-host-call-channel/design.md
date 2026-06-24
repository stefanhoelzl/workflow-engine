## Context

The runtime nests three layers: **host** (main thread — HTTP server, executor, EventStore, registry), **worker** (one `worker_threads` Worker per sandbox, holding the host-bridge + QuickJS context), and **sandbox** (the QuickJS WASM VM running guest code inside the worker). Today every host-backed plugin (`fetch`, `mail`, `sql`, `queue`) runs its handler **inside the worker** and opens its own sockets/files; the only worker→main traffic is the one-way `event`/`log` stream and the `done` run result (`packages/sandbox/src/protocol.ts`). There is no worker→main request/response channel.

A new class of API needs a **main-thread singleton** — the motivating case is a per-workflow DuckDB table, where the DuckDB instance is owned by the main process (`packages/runtime/src/event-store.ts`, single connection, writes serialized through a `writeChain` promise). The worker cannot reach it. This change adds the missing channel as a **generic primitive**, leaving the first real consumer (DuckDB) to a follow-up change.

Vocabulary note: the existing guest↔worker host-bridge is already called "bridge RPC" in the `sandbox` spec. To avoid collision, the new worker↔main arrow is the **host-call channel** (`callHost` / "host handlers"); the term "RPC" is avoided throughout.

## Goals / Non-Goals

**Goals:**
- A generic, reusable worker→main call mechanism: a worker plugin handler invokes a named main-thread handler and `await`s the result.
- Keep the sandbox package a pure, method-agnostic transport; the runtime owns handler implementations and their scoping.
- Compile-time typing and runtime validation via a per-capability contract module, with no new runtime dependency and zero weight added to the worker bundle.
- Prove the channel end-to-end with a test-only plugin, no real consumer.

**Non-Goals:**
- No DuckDB API, no real host methods, no DB file layout / keying, no guest-facing surface (the guest never sees `callHost`).
- No synchronous-from-guest host calls (`SharedArrayBuffer`/`Atomics`).
- No new observability events, no per-call timeout, no dedicated payload cap, no `AbortSignal`.
- No SDK or `demo.ts` change.

## Decisions

### D1 — Async correlation-id transport, not synchronous blocking
Worker posts `{type:"host-call-request"; id; method; args}`; main replies `{type:"host-call-response"; id; ok; result?|error?}` over the existing worker port. The worker keeps a per-run `Map<id, {resolve, reject}>`.
**Why:** the worker already pumps its event loop mid-run for async host work (`fetch`/`mail`/`sql` all `await` I/O), and the bridge already returns `Promise<CallableResult>`. A handler can simply `await ctx.callHost(...)`.
**Alternative — `SharedArrayBuffer` + `Atomics.wait`:** rejected. It blocks the worker loop (killing in-flight timers/fetches, deadlock risk) for no benefit, since nothing here needs synchronous semantics. Reserved for a separate proposal if a future API genuinely cannot be async.

### D2 — Sandbox core is a method-agnostic transport; runtime injects handlers
The sandbox factory gains `hostHandlers: { [method: string]: (args: unknown[]) => Promise<unknown> }`; the worker context gains `callHost(method, args)`. The sandbox never interprets method names or payloads.
**Why:** handlers are live main-thread closures over singletons — they cannot be esbuild-serialized into a plugin's `workerSource` string the way plugins are today. The runtime (`sandbox-store.ts`) already holds the main-thread singletons and constructs sandboxes per `(owner, workflow.sha)`, so it is the natural place to build a per-sandbox handler map bound to `(owner, workflow)`.
**Alternative — plugin gains a `main()` half** the composer imports and calls: rejected. It mixes serialized worker source and live main code in one descriptor and forces every plugin to be host-aware.

### D3 — Typing via a per-capability contract module (no co-location of the implementation)
A capability declares a contract module (plain `.ts`): Zod `{args, result}` schemas per method, with `z.infer` producing the `HostApi` type. The worker `import type`s the `HostApi` to type `ctx.callHost` (`PluginContext<HostApi>`, default = no host calls); the runtime imports the schema values to build validated handlers via a `defineHostMethod(name, contract, handler)` helper.
**Why:** the `?sandbox-plugin` vite query erases per-plugin types — `vite/virtual.d.ts` declares one wildcard ambient module, so every plugin import resolves to the same fixed shape with no generic parameter. A phantom `HostApi` cannot ride the plugin import. A shared contract module is the single source of truth that both ends reference; the host satisfies a *published interface* rather than receiving an implementation co-located with the plugin. Using `import type` keeps Zod and the contract values out of the worker bundle entirely.
**Alternative — full array inference** (phantom `HostApi` on `PluginDescriptor`, `create<P extends Plugin[]>()` intersecting all plugins' `HostApi`): rejected as too costly. Because the vite query erases the type, each plugin would need a localized `as PluginDescriptor<_, XHostApi>` re-attach plus fragile heterogeneous-tuple generics. Accepted residual seam: nothing *automatically* proves the runtime wired a handler for every loaded plugin; a forgotten contract surfaces at runtime via the unknown-method rejection (D5), which thus doubles as the safety net.

### D4 — Validation runs main-side only
`args.parse` runs on the main thread before the handler touches any singleton (the trust boundary into the host process); `result.parse` runs main-side before posting back (where a future consumer can also coerce non-JSON types, e.g. DuckDB `BIGINT`/`Date`). The worker uses types only.
**Why:** worker-side arg validation would be redundant (the guest-facing descriptor already validated guest input) and would pull Zod into the worker bundle. Keeping Zod main-only matches how `host-call-action` already lives on the main thread.

### D5 — Errors and unknown methods
A handler throw or an unregistered method produces `{ok:false, error: SerializedError}`; the worker rejects the `callHost` promise; the error surfaces to the guest as a thrown error. Reuses the existing `SerializedError` round-trip.

### D6 — Run-end lifecycle: reject-in-worker, results dropped
At run end, the worker rejects any still-pending `callHost` promises; main-side handlers run to completion and their results are silently dropped (a fire-and-forget write still lands).
**Why:** this exactly mirrors the existing dispose semantics (`sandbox` spec: in-flight bridge calls are "abandoned on the worker side; any side effect on the main side remains committed"). The pending-`callHost` `Map` is worker-side state that is **not** captured in the VM snapshot (per the workflow-scoped VM lifecycle requirement), so it MUST be cleared at the run boundary or a stale response would bleed across the restore into the next run. No `AbortSignal` is passed to handlers.

### D7 — No timeout, no payload cap, invisible transport
No per-call timeout: the main-thread wall-clock `armCpuBudget` watchdog (`worker-termination.ts`) already terminates the worker if a host call hangs the run. No dedicated payload cap: rely on `memoryLimit` + the watchdog. The transport emits no events; observability rides the guest-facing descriptor's existing `pluginRequest` framing when a real consumer adds one.

## Cross-component flow

```
guest (QuickJS)      worker (host-bridge + plugin)        main (runtime hostHandlers)
     │                        │                                    │
     │  await db.query(...)   │                                    │
     ├───────────────────────▶│ plugin handler                    │
     │                        │  callHost("x", args)               │
     │                        │  id=N; pending.set(N,{resolve})    │
     │                        ├── postMessage host-call-request ──▶│ onPersistentMessage
     │                        │   {id:N, method:"x", args}         │  handler = hostHandlers["x"]
     │                        │                                    │  args.parse(args)   (D4)
     │            (worker event loop free; other async may run)    │  await handler(args)
     │                        │                                    │  result.parse(out)  (D4)
     │                        │◀── postMessage host-call-response ─┤
     │                        │   {id:N, ok:true, result}          │
     │                        │  pending.get(N).resolve(result)    │
     │◀── Promise resolves ───┤                                    │
     │                        │                                    │
   [run ends] ───────────────▶│ reject all pending callHost (D6)   │ (in-flight handler
                              │  pending.clear()                   │  finishes; result dropped)
```

## Risks / Trade-offs

- **[`memoryLimit` does not bound the transport]** → `memoryLimit` is the QuickJS WASM heap inside the worker; a large result materializes in main-thread RAM and is structure-cloned over `postMessage` *before* reaching QuickJS, so only the wall-clock watchdog bounds it (loosely). Mitigation: out of scope here; the first real consumer (e.g. DuckDB) SHOULD enforce a row/`LIMIT` cap in its handler. Documented for that follow-up.
- **[Residual wiring seam]** (D3) → a plugin loaded without its matching handler wired fails only at runtime. Mitigation: the unknown-method rejection (D5) makes the failure explicit and immediate; the round-trip test (and per-consumer tests) catch it in practice.
- **[Dropped main-side results on run-end]** (D6) → a handler with side effects that completes after the worker rejected may leave partial state. Mitigation: consumers with mutating handlers own idempotency/transactionality; this matches the established dispose contract, so the model is not new.
- **[Vocabulary confusion with bridge RPC]** → mitigated by naming the new arrow "host-call channel" and reserving "RPC" for the existing guest↔worker bridge; the spec deltas state this explicitly.

## Migration Plan

Purely additive. `hostHandlers` is optional on the factory; `callHost` is a new context method; existing plugins, callers, and the worker protocol consumers are unaffected. No persisted data, manifest, or SDK surface changes, so no tenant rebuild/re-upload is required. Rollback is removal of the additive surface.

## Open Questions

None blocking. The first consumer's concerns (DuckDB file layout, keying by workflow *name* so data survives re-uploads, guest-facing API shape, result-set caps) are deferred to a follow-up change.
