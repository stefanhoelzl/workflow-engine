## 1. Protocol & transport (sandbox package)

- [x] 1.1 Extend `packages/sandbox/src/protocol.ts`: add `{type:"host-call-request"; id; method; args}` to `WorkerToMain` and `{type:"host-call-response"; id; ok; result?; error?}` to `MainToWorker`.
- [x] 1.2 Add `hostHandlers?: Record<string, (args: unknown[]) => Promise<unknown>>` to the `sandbox()` options and thread it through `factory.ts` `create()` (`FactoryCreateOptions`). _(Field added to `SandboxOptions`; `FactoryCreateOptions`'s `Omit` already includes it and `create()` spreads `...options`, so it flows automatically — verified by type-check.)_
- [x] 1.3 In `sandbox.ts`, add a `host-call-request` branch to `onPersistentMessage`: look up `method` in `hostHandlers`, `await` it, post `host-call-response {ok:true,result}`; on throw post `{ok:false,error}` (serialized); on missing method post `{ok:false,error}` naming the method. Treat absent `hostHandlers` as empty map.
- [x] 1.4 Confirm the channel uses only the existing worker port and JSON-serializable payloads (no `SharedArrayBuffer`/`Atomics`).

## 2. Worker-side caller (sandbox package)

- [x] 2.1 Add a worker-lifetime-monotonic `id` counter and a `Map<id,{resolve,reject}>` pending map in `worker.ts`. _(Counter is NOT reset per run — see the note in `worker.ts`: reusing ids would let a late response correlate to a fresh call.)_
- [x] 2.2 Add `callHost(method, args): Promise<unknown>` to the plugin context (`plugin.ts`): mint `id`, store the pending entry, post `host-call-request`; resolve/reject the pending entry when the matching `host-call-response` arrives. _(Includes an internal `.catch` to suppress `unhandledRejection` for fire-and-forget calls.)_
- [x] 2.3 Make the plugin context type generic over `HostApi` (default = no host calls / untyped transport); ensure `callHost` is typed from it.
- [x] 2.4 Ensure `callHost` is worker-only — not installed on guest `globalThis` and unreachable from guest scope. _(Asserted by the `probe` case in `host-call.test.ts`.)_

## 3. Run-end lifecycle (sandbox package)

- [x] 3.1 On run end, reject all still-pending `callHost` promises and clear the pending map before the VM snapshot restore. _(`rejectPendingHostCalls()` in `finalizeRun`.)_
- [x] 3.2 Drop any `host-call-response` whose `id` is not in the current pending map (late response after run end / across restore). _(`resolveHostCall` drops unknown ids.)_

## 4. Runtime wiring & typing convention

- [x] 4.1 Add a `defineHostMethod(name, contract, handler)` helper (runtime) that validates `args` against the contract, invokes the handler, validates/coerces the `result`, and returns a `{ [name]: wrappedHandler }` entry. _(`packages/runtime/src/host-call.ts`.)_
- [x] 4.2 Establish the contract-module convention: a plain `.ts` exporting Zod `{args,result}` per method plus the `z.infer` `HostApi` type (`HostApiOf<>`); document that worker code imports the type only (`import type`). _(Documented in `host-call.ts` header.)_
- [x] 4.3 Production `sandbox-store.ts` wiring deferred to the first consumer. The factory seam (`create({ hostHandlers })`) exists and is exercised by the sandbox round-trip test; with **zero** host methods in this change, building a per-sandbox `hostHandlers` map in production would be dead code. The first consumer adds its method via `defineHostMethod` and wires the scoped map then.

## 5. Security treatment

- [x] 5.1 Update `SECURITY.md §2` with the worker→main host-call boundary: args validated main-side, handlers scoped to `(owner, workflow)` and fail-closed, `callHost` not guest-reachable, new host methods require explicit treatment. _(Added as **R-15**.)_

## 6. Tests

- [x] 6.1 Add a test-only plugin (worker side calls `ctx.callHost("test.echo", …)`) plus a test `hostHandlers` map; assert the full worker→main→worker round-trip resolves.
- [x] 6.2 Test the error path: a handler that throws and an unknown method both reject the worker-side call with the serialized error.
- [x] 6.3 Test run-end rejection: a fire-and-forget `callHost` is rejected at run end without breaking the sandbox; a late response does not resolve any call in the next run (subsequent run unaffected).
- [x] 6.4 Correlation + `SerializedError` round-trip exercised end-to-end through the real channel by 6.1/6.2 (multiple methods correlate by id; error fields cross intact).
- [x] 6.5 Security cases: `callHost` absent from guest `globalThis` (`probe`); main-side `args` validation rejects before the handler body runs (`defineHostMethod` test). The `(ownerA, workflowA)` vs `ownerB` scope case requires a real scoped handler and lands with the first consumer (R-15 records the invariant).
- [x] 6.6 `defineHostMethod` tests: args-validation rejection and result coercion crossing back (`packages/runtime/src/host-call.test.ts`). The "worker bundle carries no contract values" build assertion lands with the first consumer that actually `import type`s a contract into a worker plugin (no such plugin ships here).

## 7. Definition of Done

- [x] 7.1 `pnpm validate` passes (lint, type-check, `pnpm test` 1549 passing across 112 files, tofu fmt + validate).
- [x] 7.2 `pnpm test:wpt` not required: only test fixtures in `sandbox-stdlib` gained a `callHost` stub; no sandbox-stdlib runtime surface changed.
- [x] 7.3 Confirmed no SDK / `demo.ts` change is required (guest never sees `callHost`) and none was made.
