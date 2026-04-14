## Context

The sandbox (QuickJS WASM execution engine for workflow action code) lives at `packages/runtime/src/sandbox/` and ships as part of `@workflow-engine/runtime`. Its public API exposes a `Sandbox.spawn(source, ctx, options)` method where `ctx: ActionContext` is a runtime type that transitively imports `RuntimeEvent` and `EventSource`. The OpenSpec capability for the sandbox (`action-sandbox`) codifies 15+ Bridge-primitive requirements — `sync`, `async`, `arg` extractors, `marshal` helpers, opaque-ref store, `pushLog` — as public contract, plus 12 per-operation WebCrypto requirements, totalling 844 lines.

The sandbox is architecturally ready for extraction (5 TS files + 1 test file, only one internal import, `ActionContext`). But the extraction is an opportunity to also correct three long-standing misfits: (a) the public API conflates "execute JS in isolation" with "run a workflow action with ctx.emit/ctx.event/ctx.env"; (b) the spec describes implementation mechanics rather than the consumer-visible contract; (c) VM lifecycle (fresh-per-action) pays QuickJS startup cost on every event even though all events for the same workflow load identical source.

The change is bounded to the sandbox + its immediate consumers (`context`, `scheduler`, `sdk`, `workflow-loading`, `monorepo-structure`). Vite-plugin is explicitly out of scope — the npm polyfill chain (whatwg-fetch, url-polyfill, blob-polyfill, etc.) continues to be bundled into workflow source via `@workflow-engine/sandbox-globals`, and `__hostFetch` continues to be installed by the sandbox per-VM for MockXhr to call.

## Goals / Non-Goals

**Goals:**
- Reduce the sandbox's public surface to: `sandbox(source, methods, options)`, `sb.run(name, ctx, extraMethods)`, `RunResult`, `LogEntry`. Nothing else.
- Make the sandbox knowledge-free about workflow semantics (no `ctx.emit`, no `event.type`/`event.name` translation, no `ActionContext`).
- Amortize QuickJS VM setup across all events for the same workflow by reusing VMs, with explicit disposal on workflow reload.
- Consolidate all sandbox lifecycle and security guarantees into the `sandbox` capability spec; adjacent specs stop codifying them.
- Collapse the crypto spec surface from 12 per-operation requirements to 1 "WebCrypto surface" requirement plus 1 key-material security rule.
- Land in two reviewable phases: (1) in-place API refactor within `packages/runtime/src/sandbox/`; (2) file move to `packages/sandbox/` as a workspace package.

**Non-Goals:**
- Changing polyfill ownership. Vite-plugin continues to bundle npm polyfills into workflow source; sandbox owns only the host-bridge globals it installs today (`console`, timers, `performance`, `crypto`, `__hostFetch`).
- Wiring `AbortSignal` or adding execution timeouts. The current "accepted but ignored" status is preserved; `options` carries only `filename`. DoS mitigations (S2–S4 in SECURITY.md §2) remain residual risks.
- Making the Bridge primitive a public API. `sync`/`async`/`arg`/`marshal`/`storeOpaque` stay fully internal to the sandbox package.
- Implementing lazy polyfill loading, polyfill subsetting, or any other polyfill-size optimization.
- Changing workflow-author ergonomics beyond the `ctx.emit` → `emit` global migration.
- Supporting multiple source modules per sandbox (one `sandbox()` call takes exactly one source string).
- Replacing `quickjs-emscripten` or the RELEASE_SYNC variant.

## Decisions

### D1. Public API: `sandbox(source, methods, options)` + `sb.run(name, ctx, extraMethods)`

**Chosen:**
```ts
function sandbox(
  source: string,
  methods: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: { filename?: string }
): Promise<Sandbox>

interface Sandbox {
  run(
    name: string,
    ctx: unknown,
    extraMethods?: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<RunResult>
}

type RunResult =
  | { ok: true;  result: unknown;             logs: LogEntry[] }
  | { ok: false; error: { message; stack };   logs: LogEntry[] }
```

**Alternatives considered:**
- Keep `createSandbox()` + `spawn()` and just move files. Rejected: extraction without API cleanup locks in the ActionContext coupling and the Bridge-as-public-API problem.
- Per-call bridge configuration via callback (`spawn(source, { configure: (b) => { ... } })`). Rejected: exposes the Bridge primitive; consumers are expected to know about QuickJS handle marshalling.
- Fresh sandbox per event (keep per-invocation VM). Rejected: pays QuickJS + polyfill-eval cost on every event for no isolation benefit that cross-workflow sandboxing doesn't already provide.

**Rationale:** The consumer's mental model is "give me something I can invoke by name with JSON, and let me register named host functions." That's what the new API says literally. Everything else (QuickJS handles, async promise deferrals, arg extractors) becomes implementation detail.

### D2. JSON-only host/sandbox boundary (with a named internal exception)

All arguments and return values crossing the host/sandbox boundary MUST be JSON-serializable. Consumer-provided methods in `methods` and `extraMethods` receive deserialized JSON args and return JSON-serializable values; the sandbox serializes/deserializes at the boundary.

**Named internal exception:** the sandbox's own built-in bridges (currently crypto) may use an opaque-ref store to model host-resident resources (e.g., `CryptoKey`). Opaque refs appear to sandbox code as frozen JSON objects `{__opaqueId: N, ...metadata}`; the numeric id has no meaning outside the originating sandbox instance. The `storeOpaque` / `derefOpaque` / `opaqueRef` methods on the internal Bridge primitive are not reachable via the public API — consumers get a `Record<string, async-fn>` and nothing else.

**Rationale:** The current Bridge primitive allows consumers to bypass JSON marshalling via opaque refs. That's expressive but makes auditing "what crosses the boundary" hard — anyone adding a host method could accidentally introduce host-identity-carrying values. Narrowing the public contract to JSON-only makes the invariant physically enforced, not convention.

### D3. Host methods are globals (not under a `host` namespace, not injected via closure)

When `sandbox(source, methods)` constructs the VM, each entry in `methods` is installed as a top-level global function with the same name. Per-run `extraMethods` entries are installed as additional globals on each `run()` call and replaced (not cumulative) between runs. Installing `extraMethods` with a name that collides with a construction-time method SHALL be a runtime error — `extraMethods` extend, they do not shadow.

**Alternatives:**
- `globalThis.host.emit(...)` namespace. Rejected: extra ceremony; collides with browser-ish convention of no `host` global.
- Injecting `host` as a second positional arg to run() (`export function onFoo(ctx, host) { host.emit(...); }`). Rejected: workflow authors would have to thread `host` through call chains; global access is ergonomic.

**Rationale:** Matches the JSON-only spirit — there is no host object, just named async functions. Collision detection at install time catches the one real ambiguity (`extraMethods` trying to override a pinned construction method).

### D4. One sandbox per workflow, VM reused across runs

The scheduler maintains a `Map<workflowName, Sandbox>`. On first event for a workflow, the scheduler loads the workflow's `actions.js`, calls `sandbox(source, methods)`, and caches the result. Subsequent events call `sb.run(actionName, ctx, { emit })` on the cached sandbox. On workflow reload/unload, the sandbox is disposed and evicted from the map.

**Sequence — new event arrives for workflow `order-processor`:**

```
  Scheduler                          Sandbox map             Sandbox instance
     │                                   │                         │
     │  dequeue event                    │                         │
     │  (workflow=order-processor,       │                         │
     │   targetAction=validateOrder)     │                         │
     │                                   │                         │
     │──── sandboxes.get(                ├─► hit? ──────────────────┐
     │     "order-processor")            │                          │
     │◄────── Sandbox | undefined ───────┤                          │
     │                                   │                          │
     │   if miss:                        │                          │
     │   load actions.js source          │                          │
     │   assemble methods (empty today)  │                          │
     │                                   │                          │
     │────── sandbox(source, {}) ────────│───────┬──────────────────┘
     │                                   │       │  construct VM
     │                                   │       │  install bridges
     │                                   │       │  (console, crypto,
     │                                   │       │   __hostFetch, ...)
     │                                   │       │  evalCode(source) once
     │                                   │       │  module-level code runs
     │◄──────────── Sandbox ─────────────┤───────┘
     │                                   │                          │
     │────── sandboxes.set() ────────────►                          │
     │                                   │                          │
     │                                                              │
     │   build ctx = { event, env } (JSON)                          │
     │   build emit = (type, payload) =>                            │
     │                 source.derive(event, type, payload, ...)     │
     │                                                              │
     │──────── sb.run(                                              │
     │          "validateOrder",                                    │
     │          ctx,                                                │
     │          { emit }                                            │
     │        ) ────────────────────────────────────────────────────►│
     │                                                              │  install emit global for this run
     │                                                              │  call exports.validateOrder(ctx)
     │                                                              │  collect per-run log buffer
     │                                                              │  JSON-serialize return value
     │◄───────── RunResult ─────────────────────────────────────────│
     │                                                              │
     │   source.transition(event, result)                           │
     │   persist logs                                               │
```

**Workflow reload / unload:**

```
  Scheduler                 Sandbox map              Sandbox
     │                          │                       │
     │── evict(workflow) ──────►│─── sandbox.dispose() ►│  dispose VM,
     │                          │                       │  runtime, opaque store
     │                          │                       │
     │── delete key ───────────►│                       │
```

**Rationale:** QuickJS context construction + polyfill evaluation is the dominant cost per-event today. For a workflow processing many events, the new scheme amortizes this cost to once-per-deploy. Isolation is preserved at the cross-workflow boundary, which is the meaningful trust boundary — actions within one workflow are authored together and share a trust domain by definition (see D7).

### D5. Logs are per-run, reset on each `run()` call

The sandbox maintains a log buffer that is cleared at the start of each `run()` and returned (copied) in `RunResult.logs`. Console calls, construction-time method invocations, extra-method invocations, and `__hostFetch` calls all push entries into the current run's buffer. Between runs, the buffer is empty; there is no cross-run log carryover.

**Rationale:** The runtime already persists logs per-event via `EventSource.transition()`. Per-run scoping matches this persistence model and prevents accidental cross-event bleed that would otherwise happen with VM reuse.

### D6. Workflow-author emit migration: `ctx.emit` → `emit` global

SDK's `ActionContext` loses the `emit` method. Workflow authors call `emit("type", payload)` directly. SDK declares an ambient global `declare function emit(type: string, payload: unknown): Promise<void>;` so TypeScript continues to check workflow authors' code.

**Alternatives:**
- Keep `ctx.emit` as SDK sugar, have the vite-plugin rewrite `ctx.emit` → `emit` at bundle time. Rejected: extra translation layer with no benefit; workflow authors already accept globals for `fetch`, `crypto`, `URL`, etc.
- Keep `ctx.emit` and have runtime rebuild a ctx object with `emit` closure inside the sandbox per-run. Rejected: that IS ActionContext inside the sandbox — we're moving away from it.

**Rationale:** Single layer of emit, no magic. Workflow authors already treat the sandbox as a browser-ish global namespace for other APIs.

### D7. VM lifecycle posture change — explicit security argument

The current SECURITY.md §2 mitigation states: *"Fresh context per invocation. newRuntime() + newContext() are called on every spawn; vm and runtime are disposed in a finally block. No state survives across actions."* This change replaces that guarantee with: *"Fresh context per workflow module load. Disposed on workflow reload/unload. State persists across run()s within the same workflow."*

**Argument that the posture change is safe:**
1. **A workflow is a trusted logical unit.** One author, one declared manifest, one deployed bundle. Events dispatched to actions in the same workflow are within a shared trust domain by construction.
2. **State leakage within a workflow is self-leakage.** If `action-a` leaves state in a module-level variable and `action-b` reads it, that is the workflow's own code reading its own state — no privilege escalation, no cross-tenant boundary crossed.
3. **Cross-workflow isolation is unchanged.** Each workflow gets its own Sandbox instance with its own QuickJS context. A compromised action in workflow A cannot reach workflow B's state or key material.
4. **Crypto key material still never crosses to guest.** Opaque-ref store is per-sandbox, not shared. CryptoKeys generated in workflow A are not addressable from workflow B.
5. **Event payload validation still gates `emit`.** `emit(type, payload)` is host-validated against the declared Zod schema regardless of which run() it's called from.

The posture change moves one specific guarantee from "action-scoped" to "workflow-scoped" but preserves every cross-workflow guarantee.

### D8. Crypto: one WebCrypto requirement + one security rule (collapse from 12)

The 12 per-operation crypto requirements in the current spec (randomUUID, getRandomValues, digest, importKey, sign, verify, encrypt/decrypt, generateKey, exportKey, deriveBits/deriveKey, wrapKey/unwrapKey, CryptoKey-is-frozen-metadata) collapse to:

- **Requirement: WebCrypto surface.** The sandbox SHALL provide the W3C WebCrypto API (`crypto.randomUUID`, `crypto.getRandomValues`, full `crypto.subtle`). Implementation bridges to `globalThis.crypto` on the host.
- **Requirement: Key material never crosses the host/sandbox boundary.** `CryptoKey` references inside the sandbox SHALL be opaque handles carrying only metadata (`type`, `algorithm`, `extractable`, `usages`). Underlying key material remains on the host.

Test coverage of each operation remains unchanged; `sandbox.test.ts` is the detailed source of truth for per-operation behavior.

**Rationale:** The per-op requirements restate WebCrypto's W3C contract with no project-specific semantic content. Spec readability benefits from describing only what's project-specific (the security rule about key material); standard behavior stays in tests.

### D9. LogEntry stays in the sandbox package

`LogEntry` is exported from `@workflow-engine/sandbox` and consumed by `event-source.ts` (which persists logs with events) and the scheduler's test fixtures. It does not move to `@workflow-engine/sdk`; the sdk is workflow-author-facing, and LogEntry is a runtime/infrastructure concern.

### D10. Phase split: refactor in place, then move

**Phase 1 (in-place refactor within `packages/runtime/src/sandbox/`):**
- Rewrite `index.ts` to the new `sandbox()` / `run()` API.
- Refactor `bridge.ts` to no longer know about `ActionContext` (remove `bridgeCtx`, `bridgeEmit`, `bridgeEvent`, `bridgeEnv`). Keep `bridgeHostFetch` as an internal polyfill installer.
- Remove `emit` from `packages/runtime/src/context/index.ts`; simplify `createActionContext`.
- Rewrite `packages/runtime/src/services/scheduler.ts` to manage the `Map<workflowName, Sandbox>` and construct `extraMethods: { emit }` per run.
- Remove `emit` from `packages/sdk/src/context/index.ts`; add ambient `emit` declaration.
- Update all tests to the new API. Regenerate or adjust bundled-workflow test fixture (no polyfill-side regeneration needed — vite-plugin is unchanged).
- Green: `pnpm validate` passes end-to-end.

**Phase 2 (file move, no behavior change):**
- Create `packages/sandbox/` with `package.json`, `tsconfig.json`, `vitest.config.ts`.
- Move `packages/runtime/src/sandbox/*` → `packages/sandbox/src/*`.
- Move `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync` deps from runtime to sandbox package.json.
- Add `@workflow-engine/sandbox: workspace:*` to runtime's dependencies.
- Update import paths in runtime; add tsconfig project reference.
- Update `SECURITY.md §2` file references.
- Green: `pnpm validate` passes.

**Rationale:** Two-phase sequencing keeps each PR reviewable. Phase 1 is the semantic change (what the sandbox is, what consumers see). Phase 2 is purely packaging — no logic changes, no signatures change. If Phase 2 breaks something surprising, it rolls back cleanly without losing Phase 1's work.

## Risks / Trade-offs

- **Workflow-scoped opaque-ref store grows unboundedly** → A workflow that generates many `CryptoKey` instances in a hot path will see its sandbox's opaque store grow until the workflow is reloaded. No GC exists. Documented as residual risk R-S7 in the new spec; acceptable for v1 (no known workflow does this). Revisit if memory metrics show growth in production.
- **Module-level state leaking between actions in one workflow** → By design under the new lifecycle. Workflow authors may unintentionally rely on it or be confused by it. Mitigation: document explicitly in the sandbox spec; add a test that exercises it so the behavior is regression-protected.
- **Per-run method-name collision is a runtime error, not a compile error** → TypeScript cannot catch an `extraMethods` entry that shadows a construction method when the sets are built separately. Mitigation: sandbox throws on shadowing with a clear error; rare in practice because runtime owns both sets.
- **Two-phase migration leaves a transient commit where packaging and semantics differ** → Between Phase 1 and Phase 2, the sandbox has the new API but still lives in the runtime package. Consumers that import from `@workflow-engine/sandbox` will fail until Phase 2 lands. Mitigation: run Phase 1 and Phase 2 back-to-back on the same feature branch; merge together.
- **`sandbox.test.ts` bundled-workflow fixture depends on `workflows/dist/cronitor/actions.js`** → The current test already handles this (skips if dist absent, per the recent `test(sandbox): skip bundled-workflow test when dist is absent` commit). No new risk; just preserve the skip in the port.
- **SECURITY.md §2 edits drift from spec edits** → The threat model and the spec must stay consistent. Mitigation: both updates live in the same change; reviewer checks §2 entry points / mitigations / file references against the new sandbox spec before merging.
- **The posture change (VM reused across runs) is the most scrutinized decision** → Reviewer may reject the safety argument in D7. Mitigation: argument is explicit in design.md; if rejected, fall back to fresh-VM-per-run with the same API (would negate D4's cost amortization but leave D1–D3 intact).

## Migration Plan

**Runtime code migration (automatic, no workflow author involvement for most):**
- Phase 1 and Phase 2 land back-to-back. Between them, no public package surface is exposed externally (the runtime is the only consumer today).

**Workflow author migration (manual, small):**
- Workflow authors replace `ctx.emit(...)` calls with `emit(...)`. This is the only code change required of authors.
- The SDK ships ambient `emit` type declaration in the same version bump, so TypeScript compilation continues to pass immediately after the update.
- Example migration script (one-time): `grep -rl 'ctx\.emit' workflows/ | xargs sed -i 's/ctx\.emit(/emit(/g'`. Authors verify by running `pnpm check` and `pnpm test`.

**Rollback strategy:**
- Phase 1 rollback: revert the Phase 1 commit. Workflow code that has already migrated to `emit(...)` will break; authors must revert their `sed` change. Acceptable — Phase 1 is not live before this change merges.
- Phase 2 rollback: revert the Phase 2 commit. Phase 1 API remains in place in `packages/runtime/src/sandbox/`. The new `packages/sandbox/` directory is removed; imports revert.
- No data migration is involved; no schema change; no infrastructure change.

## Open Questions

- **Lazy vs eager sandbox construction.** Scheduler could construct sandboxes eagerly at startup (for all known workflows in the registry) or lazily on first event. Eager catches source-parse errors early; lazy defers cost and handles dynamic workflow registration more cleanly. Defaulting to **lazy** pending operational signal otherwise; revisit if startup-time failure-detection becomes valuable.
- **Disposal trigger for sandbox eviction.** The scheduler must dispose a workflow's sandbox on reload or when the workflow is removed from the registry. The exact eviction hook (e.g., `WorkflowRegistry.onReload` callback, explicit `scheduler.reloadWorkflow(name)` call, or polling with version comparison) is left to the implementation in tasks.md, not this design.
- **Per-run method-override syntax finalization.** We have `sb.run(name, ctx, extraMethods?)`. Whether `extraMethods` also supports functions that need access to an AbortSignal / per-run metadata is deferred. v1: no such metadata.
- **SECURITY.md §2 wording for the posture change.** D7 gives the shape of the argument; the exact phrasing of the replacement mitigation and rule #4 for AI agents needs review when §2 is edited in tasks. Not a blocker for this proposal.
