## Context

The sandbox today caches one QuickJS VM instance per `(tenant, sha)` in `SandboxStore`. Every trigger invocation for that workflow version reuses the same VM until the workflow is re-uploaded or the process exits. Guest-visible state — mutations to `globalThis`, module-level `let`/`const` values, closures that captured mutable module state — persists across `run()` calls. That is the existing `sandbox/spec.md` guarantee: *"Module-level state and installed globals SHALL persist across `run()`s within the same sandbox instance."*

Workflow authors approaching this from a serverless mental model (`defineWorkflow` as a declaration, not a long-running process) will accidentally rely on module-level state in one trigger and see surprising persistence in another. This proposal inverts the guarantee — each run observes fresh guest-side state — by snapshotting the VM at end of init and restoring from that snapshot between runs.

The mechanism relies on public `quickjs-wasi` API only (`vm.snapshot()`, `QuickJS.restore()`, `vm.registerHostCallback()`). No upstream patches. The snapshot captures WASM linear memory; host-side registries (host callbacks, bridge, WASI overrides) are NOT in the snapshot and must be rebuilt per restore.

A Phase 0 spike with forced GC (`--expose-gc`, 2000 iterations) established that `arrayBuffers` and `external` memory stay pinned and `rss` oscillates within noise once the working set settles. The 9–76KB/run growth observed in an earlier bench-without-forced-GC was V8 major-GC scheduling, not retention. Real traffic (ms+ between runs) gives V8 ample opportunity to GC naturally; no eviction guard or forced-GC hook is needed.

## Goals / Non-Goals

**Goals:**
- Guest-side state observed inside the sandbox VM SHALL reset between runs. `globalThis` writes and module-level mutations do not leak.
- Plugin-authored worker-side state (R-4 territory — timers Map, pending Callables, fetch handles, compiled validators) continues to persist for the sandbox's lifetime.
- Per-run critical-path latency stays warm-equivalent (sub-ms for lightly-loaded triggers). Restore work runs asynchronously after the `run()` message is acknowledged.
- Restore failures surface via the existing `onDied` path; `SandboxStore` recovers by respawning on next invocation — same contract as a worker crash.
- Public sandbox API (`sandbox()`, `Sandbox.run`, `onEvent`, `dispose`, `onDied`) is unchanged.

**Non-Goals:**
- Full execution determinism. `Date.now()`, `Math.random()`, scheduler interleaving, and `fetch()` response content remain non-deterministic. The change-id says "deterministic-sandbox" but scopes that to **guest-visible state across runs**; wall-clock, RNG, and I/O determinism are separately out of scope and can be tackled in future changes.
- Opt-in / opt-out configuration. Snapshot-restore is always on. No DSL, manifest, or runtime-config surface is added.
- Cross-tenant or cross-workflow isolation. Already provided by `SandboxStore` keying on `(tenant, sha)` and physical VM separation.
- Worker-side plugin state reset. R-4's `onRunFinished` contract remains the plugin's responsibility for cleaning up its host-side residues.
- Lint or static-analysis rules against top-level mutable state in workflow source. Enforcement is at the runtime behavior + CLAUDE.md invariant level.

## Decisions

### Snapshot-always, no opt-in

One semantic for all sandboxes. The alternative — per-workflow opt-in via `defineWorkflow({ isolation: "snapshot" })` or similar — was considered and rejected: it reintroduces the footgun (authors need to know to opt in), requires propagating a new field through the manifest + DSL + runtime config surfaces, and doubles the behaviour matrix we need to document and test. A single guarantee is simpler to reason about and simpler to specify.

### Post-run asynchronous restore

Restore work happens **after** the worker posts `{ type: "done" }` for a run, not before the next run. The alternative (synchronous per-run restore before dispatch) adds ~10–17ms to every `run()` p50, which is 100× warm's latency. The async variant decouples restore from the critical path: `sb.run()` resolves at warm speed; the next run only pays a wait if the previous restore hasn't finished yet. For paced traffic (gaps ≥ restore time), restore is invisible.

The worker's state machine becomes:

```
   ┌── first run message ─────────────────────┐
   │                                          ▼
init → ready ── running ── finalize ── restoring ── ready
         ▲       │           │                       │
         │       │           │                       │
         │       ▼           ▼                       │
         │   guest work   plugin onRunFinished       │
         │               + post done                 │
         │                                           │
         └─── next run awaits state==ready ──────────┘
```

First run skips the `restoring` transition because init already left the VM in post-init state.

### Restore failure → sandbox-dead (reuse the existing death path)

If `QuickJS.restore()` or `registerHostCallback()` throws during the async restore, the worker rethrows via `queueMicrotask` to trigger the existing uncaught-error handler that fires `onDied` on the main thread. `SandboxStore` observes `onDied` and removes the entry; the next invocation rebuilds a fresh sandbox.

Alternatives considered and rejected:

- **Fall back to warm**: trades the correctness property for availability. Makes the guarantee probabilistic ("fresh state per run, except when restore fails, then it's warm") — hard to reason about.
- **Retry restore once**: adds control-flow without a known failure class that retry helps with. Papers over real bugs.

Hard fail matches the existing "worker crash → respawn" contract.

### Rebind path reuses the handler-builder closure shape

The refactor extracts `buildGuestFunctionHandler(vm, ctx, descriptor) → HostFunction` from the existing `installGuestFunction`. Both paths use it:

- Init: `vm.newFunction(descriptor.name, buildGuestFunctionHandler(vm, ctx, descriptor))`
- Restore: for each remembered descriptor, `vm.registerHostCallback(descriptor.name, buildGuestFunctionHandler(newVm, newCtx, descriptor))`

The alternative (inline duplication) would fork-maintain ~25 lines in two places with subtle closure-capture differences. Extraction is a pure refactor with zero behavior change; it lands as commit 1 of the PR.

### Worker lifecycle sequence diagram

```
MAIN THREAD                 WORKER THREAD
───────────                 ─────────────
init msg ─────────────────▶ runPluginBootPipeline
                            Phase 4 eval user source
                            state.snapshotRef = vm.snapshot()
                            state.guestFunctions = descriptors
                            state.createOptions = createOptions
                            state.runState = "ready"
         ◀────── ready ─────┤

run("h", ctx) ────────────▶ if runState == "restoring":
                              await restorePromise
                            runState = "running"
                            runLifecycleBefore + invokeGuestHandler + finalizeRun
         ◀────── done ──────┤ post done
                            runState = "restoring"
                            restorePromise = startRestore(state)  (no await)
                              ├─ state.bridge.dispose()
                              ├─ state.vm.dispose()
                              ├─ wasiState.anchor.ns = perfNowNs()
                              ├─ newVm = await QuickJS.restore(snapshotRef, createOptions)
                              ├─ for each descriptor:
                              │     newVm.registerHostCallback(name,
                              │       buildGuestFunctionHandler(newVm, newCtx, descriptor))
                              ├─ newBridge = createBridge(newVm, anchor)
                              ├─ newBridge.setSink(post-event)
                              ├─ wasiState.bridge = newBridge
                              └─ state.{vm,bridge} = new{Vm,Bridge}; runState = "ready"

run("h", ctx) ────────────▶ (awaits "ready" if restore still in flight)
```

### Snapshot lifetime is sandbox-lifetime

One `vm.snapshot()` per sandbox, held on `SandboxState.snapshotRef` for the worker's life. ~1.5–8MB per sandbox depending on plugin set + user source size (measured: tiny 1.5MB, demo 120KB bundle → similar). The alternative (take a fresh snapshot every N runs) introduces cadence questions without a motivating need — the post-init snapshot is stable and correct.

### Extensions captured in createOptions

`quickjs-wasi`'s `QuickJS.restore(snapshot, options)` requires that the caller re-supply the same extensions array that was passed to `QuickJS.create(options)` — extension `__memory_base`/`__table_base` pointers are baked into the snapshot. We cache the `createOptions` on `SandboxState` at init and re-pass it verbatim to `restore`. WASI factory is included; `wasiState` itself is a module-scoped singleton and is updated with the new bridge on each restore.

### Testing scope

Three acceptance tests, all in-scope for this change:

1. **Isolation invariant** — mirrors the spec's new `Guest state does not persist across runs` scenario: `let count = 0; export function tick(ctx) { return ++count; }` returns `1, 1, 1` across three runs.
2. **Restore failure → sandbox-dead** — a seam to force `QuickJS.restore` to throw after the first run; assert that the next `run()` rejects, `onDied` fires with the restore error, and subsequent `run()` calls reject.
3. **Integration smoke: plugin stack survives 3+ restores** — compose the production plugin set (fetch mocked to avoid `hardenedFetch` loopback block, timers, console, host-call-action, sdk-support, trigger) against a bench fixture workflow and run `sb.run()` three times; assert each run succeeds and exercises each plugin surface.

Not in scope for this change: memory-growth assertion test (Phase 0 spike established the memory property; regressions should be detected via production observability), perf assertion (flaky in CI; manual bench on worker lifecycle changes).

## Risks / Trade-offs

- **[Risk] A plugin's guest-facing descriptor retains a closure over the init-time `vm` or `ctx`, becoming dangling after restore** → Mitigation: `buildGuestFunctionHandler` is the single place that captures `vm`/`ctx`; rebind rebuilds every descriptor's handler with the new `vm`/`ctx`. Integration smoke test asserts every production plugin's guest surface still works after 3+ restores. Any new plugin added in the future that captures `vm`/`ctx` outside this helper is caught at review time via the new CLAUDE.md invariant.

- **[Risk] Back-to-back runs with gap < restore time pay the restore wait on the next run's critical path** → Mitigation: accepted trade-off. The wait is still bounded by restore time (~10–17ms), much less than warm-throwaway's ~350ms. Production traffic spacing is expected to be at least a few ms between invocations per-sandbox due to work-queue dispatch; the critical-path cost should rarely be visible.

- **[Risk] A silent behavior change for any workflow that relied on warm-reuse state** → Mitigation: none of the repo's current workflows (demo.ts + plugins) rely on persistence. The change is BREAKING in a theoretical sense but observable only if someone writes counter-pattern code. The new CLAUDE.md invariant + the spec scenario `Guest state does not persist across runs` catch this at review/grep time.

- **[Risk] Restore work accumulates in the Node GC backlog under synthetic tight-loop load** → Mitigation: Phase 0 spike confirmed forced-GC flatlines memory. Production traffic gives V8 natural GC opportunities; no forced `global.gc()` needed in the worker.

- **[Risk] Native-extension mismatch at restore time (e.g., if plugin extensions could mutate at runtime)** → Mitigation: `createOptions` is frozen at init and reused verbatim on every restore. The extensions list is compiled from plugin descriptors passed to `sandbox()` and cannot change after construction. If a future change introduces dynamic extension loading, this risk resurfaces and needs explicit handling.

- **[Trade-off] One additional permanent 1.5–8MB allocation per sandbox for the snapshot's memory buffer** → Accepted. For typical production sandbox counts (tens to low hundreds), total is under 1GB of snapshot memory. Capacity planning should include this but it is not a constraint in practice.

- **[Trade-off] Restore still pays a full WASM memory copy and re-instantiation on every run.** We explored reusing `WebAssembly.Memory` across restores — not supported by public quickjs-wasi API. Accepted as intrinsic cost of the "public API only" constraint.

- **[Non-goal-implied risk] The word "deterministic" in the change-id may suggest full execution determinism to readers** → Mitigation: proposal.md, design.md, and the spec delta all explicitly bound determinism to "guest-visible state across runs". Time/random/fetch are called out as non-determinism sources we are NOT addressing here.
