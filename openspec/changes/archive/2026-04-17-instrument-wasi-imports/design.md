## Context

The QuickJS sandbox has two distinct host-boundary layers:

```
guest JS
   │
   ▼
QuickJS VM (WASM)
   │                            │
   │ explicit bridge            │ implicit WASI imports
   ▼                            ▼
vm.newFunction / b.sync        wasi_snapshot_preview1
 - console.log                  - clock_time_get
 - __hostFetch                  - random_get
 - __hostCallAction             - fd_write
 - __emitEvent                  - fd_close/fdstat/seek (stubs)
   │                            │
   ▼                            ▼
emits system.request /          default shim at
    system.response /           wasi-shim.js:25-101
    action.* / trigger.*        passes through to host
    InvocationEvents            Date.now / crypto.getRandomValues
                                / process.stdout with NO events
```

The explicit bridge is fully instrumented. The WASI path is not — `Date.now()`, `Math.random()`, `crypto.getRandomValues()`, `crypto.randomUUID()`, and every internal entropy read by the WASM crypto extension cross the sandbox boundary silently. QuickJS-engine-internal diagnostics written to fd 1/2 land on the host process stdout/stderr with no structured trace.

The quickjs-wasi package exposes a `wasi` factory option at VM creation: `(memory: WebAssembly.Memory) => overrides`. It is a closure that captures WASM memory and cannot cross `postMessage`. The sandbox runs in a `worker_threads` worker, so the `wasi` factory must be constructed inside the worker — the main thread cannot supply it.

The existing sandbox capability spec includes three requirements — "Caller-provided clock override" (line 757), "Caller-provided randomness override" (line 781), and "Override options follow existing patterns" (line 811) — that describe the opposite architecture: closure-valued `clock` / `random` options passed from caller to sandbox. No code satisfies these requirements today (the `SandboxOptions` interface does not contain the fields). The requirements describe an unimplementable API given the worker-thread topology.

## Goals / Non-Goals

**Goals:**

- Close the observability gap: every clock read, entropy read, and engine diagnostic emitted by the sandbox becomes discoverable from the InvocationEvent stream or the sandbox Logger.
- Preserve the ability to reconstruct call-site attribution for WASI reads — the event's `ref` field parents each read to the in-flight bridge call (or the trigger itself).
- Keep `random_get` entropy bytes out of the event store. The observability event records buffer size and a bounded fingerprint; never the bytes themselves.
- Establish the foundation for a future replay/ledger phase: persisted `system.call` events are shaped such that a future consumer could replay them verbatim to reconstruct a deterministic run.

**Non-Goals:**

- Deterministic control modes (fixed clock, seeded random, ledger replay). These come back in a future change with a serializable-descriptor `SandboxOptions` surface. They are not required for observability alone.
- Timers (`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`). Also unlogged today; deferred to a separate change.
- `interruptHandler` wiring for execution timeouts. Same postMessage constraint as clock/random; deferred.
- Observing WASM crypto extension internals (`crypto.subtle.*`). The operations run entirely inside WASM linear memory without crossing a boundary we instrument; a separate change is required if that gap becomes operationally important.
- Pre-run WASI read observability. Events during `QuickJS.create`, WASI libc init, and workflow source evaluation (before `setRunContext`) are not emitted.

## Decisions

### D1. New `EventKind`: `system.call`, not an overload of `system.request`

WASI reads complete synchronously in sub-microseconds (one `Date.now()` + 8-byte memory write; one `crypto.getRandomValues` into a WASM buffer). There is no latency to capture across a request/response pair and no asynchronous gap to bracket. A paired event shape would double volume without carrying information.

**Chosen:** introduce a new `EventKind` variant `system.call` whose contract is "single record, input and output in the same event, no paired counterpart, leaf event (never pushes or pops the ref stack)". Reserved for instant synchronous sub-bridge host reads.

**Alternatives considered:**

- Overload `system.request` to sometimes lack a response — rejected because it silently breaks the "every `system.request` has a matching `system.response` or `system.error`" invariant that existing consumers assume.
- `system.read` — rejected as too narrow; a future sub-bridge write (e.g., `fd_write` if we ever logged it as an event) wouldn't fit.
- `system.sync` — rejected for overloading with "synchronization" connotations.
- `wasi.read` as a new top-level family — rejected as too WASI-specific; the kind should describe a shape (single-record sync call), not an origin (the WASI layer).

### D2. Call-site attribution via `ref`, no extra field

The event log already encodes a call tree via `ref`. When a WASI read fires:

```
trigger.request (seq 0) pushed at run start by emitTriggerEvent
   │
   └── refStack grows/shrinks as guest calls bridges
       └── system.call wasi.clock_time_get uses refStack.at(-1) as ref

   Examples:
     read during pure guest code      → ref = 0 (trigger)
     read inside a host.fetch impl    → ref = seq of the fetch request
     read inside an action.request    → ref = seq of the action.request
```

**Chosen:** the event's `ref` is the call-site context. No additional `callSite` / `stackTrace` field.

**Alternatives considered:**

- Stack dump on every WASI call (`vm.evalCode('new Error().stack')`) — rejected. Recursive WASI triggers, expensive, and quickjs-wasi does not expose a host-side stack read without eval.
- QuickJS-layer shims wrapping `crypto.getRandomValues` / `randomUUID` / `subtle.*` — rejected as brittle (won't catch extension-internal entropy consumption) and heavy maintenance.
- Size-based heuristics — rejected as unreliable (16 bytes could be libc init, randomUUID, or a 16-byte user request).

### D3. `random_get` output: `{ bufLen, sha256First16 }`, never the bytes

Raw entropy bytes in the event stream would leak crypto material into the invocation event store, which has a weaker trust boundary than VM snapshots.

**Chosen:** `output: { bufLen: <number>, sha256First16: <hex> }`. The hash detects "the same entropy was returned twice" without leaking the bytes. The size is the actionable number for volume-over-time.

**Alternatives considered:**

- Log full bytes as hex — rejected on security invariant grounds.
- Log only size — fine, but adding `sha256First16` is cheap and doubles debugging value.
- Hash the full buffer — slightly stronger fingerprint but more CPU for no additional observability benefit.

### D4. Monotonic clock anchored at `setRunContext`, not at worker init

The default WASI shim conflates `CLOCK_MONOTONIC` with `CLOCK_REALTIME`. Our override separates them, and anchoring monotonic per-run gives deterministic-looking timelines across replays (same guest, same ctx → same monotonic values) and matches the per-run isolation model (new invocationId, new refStack, new monotonic).

**Chosen:** `anchorNs` is a mutable variable in the WASI factory closure. Set at worker init (fallback for pre-run reads). Re-set every time `bridge.setRunContext` fires. `CLOCK_MONOTONIC` returns `(performance.now() × 1e6) − anchorNs`.

**Alternatives considered:**

- Anchor at worker init only — rejected because reruns on a cached sandbox would see monotonic grow across invocations, breaking per-run isolation.
- Anchor at run and require pre-run reads to return 0 — rejected because guest module-load code doing `const start = performance.now()` would always see 0, which is surprising.

### D5. Pre-run WASI reads: skip emission

QuickJS's PRNG seeding and WASI libc init each call a WASI import once at VM creation. Our design explicitly skips these reads.

The alternatives would either require a schema change (`InvocationEvent.id: string | null` to allow non-invocation-scoped events) or invent a synthetic invocationId namespace. Both ripple into persistence, logging-consumer, recovery, dashboard — for a handful of invariant events per sandbox lifetime. Not worth the surface-area cost.

**Chosen:** emit only when `bridge.getRunContext()` returns non-null. Pre-run WASI reads silently pass through.

**Alternatives considered:**

- Null-able invocationId — ripple cost too high for the value.
- Synthetic `sandbox-init:<hash>` invocationId — invents a parallel identity namespace that every consumer eventually has to understand.
- Buffer pre-run events and flush into the first run — wrong attribution.

### D6. `fd_write` → injected `Logger` at `debug`, not an InvocationEvent

QuickJS-engine diagnostics (printf-ish error paths, mbedTLS notices) are:

- Rare in correct code (zero volume normally).
- Engine-internal (not guest-observable, not part of the workflow's semantic behavior).
- Signal-when-present (worth capturing, not worth alerting).

They do not belong in the invocation event stream — that would mix workflow semantics with engine plumbing. They belong in the sandbox's operational log.

**Chosen:** `fd_write` decodes bytes, line-buffers per fd, posts `WorkerToMain { type: "log", level: "debug", message: "quickjs.fd_write", meta: { fd, text } }`. The main thread dispatches `log` messages via the sandbox's injected `Logger` at the carried level. No InvocationEvent is emitted. If no logger is provided, the message is silently dropped (tests and direct `sandbox()` callers).

**Alternatives considered:**

- Emit as `system.call wasi.fd_write` event — rejected on layer mixing.
- Keep current host-stdout/stderr passthrough — rejected because it pollutes the host process logs with unstructured text that bypasses log-level filtering.
- Log at `info` or `warn` — `debug` is the right level for "rare engine internal diagnostic"; higher levels would pollute default-level logs.

### D7. Logger reach: `SandboxOptions.logger`, injected by factory

```
┌─────────────────────────────┐
│ main thread                 │
│                             │
│ ┌─────────────────────────┐ │
│ │ factory.ts              │ │
│ │   holds Logger          │ │
│ │   sandbox(src, methods, │ │       ┌────────────────────┐
│ │           { logger })───┼─┼─────► │ packages/sandbox/  │
│ └─────────────────────────┘ │       │ src/index.ts       │
│                             │       │                    │
│                 ┌───────────┼───────┤ on 'log' msg:      │
│                 │           │       │   logger[level]    │
│                 ▼           │       │     (message, meta)│
│          worker_thread      │       │ else: drop         │
│          ┌──────────────┐   │       └────────────────────┘
│          │  worker.ts   │   │
│          │  posts 'log' │───┘
│          └──────────────┘
└─────────────────────────────┘
```

**Chosen:** `SandboxOptions` gains `logger?: Logger`. The factory passes its own logger through when calling `sandbox()`. Direct `sandbox()` callers (tests, ad-hoc scripts) can omit — missing logger means the log message drops silently.

**Alternatives considered:**

- Factory attaches a message listener to the sandbox after creation — rejected because it requires exposing the worker or message-handler hook on the Sandbox public API, breaking encapsulation.
- Default fallback to host stdout — rejected because it would reproduce today's unstructured-noise behavior in test environments.

### D8. Protocol change: additive `WorkerToMain.log` only; `MainToWorker` unchanged

With observability always on in this phase and no control/replay modes shipped, nothing needs to be told to the worker at init time. The overrides are unconditional; the gating (pre-run skip) is on `runContext` which is already carried by the `run` message.

**Chosen:** protocol delta is exactly `WorkerToMain += { type: "log", level, message, meta? }`. `MainToWorker` stays as-is. The existing TODO comments describing phase-2 descriptor plumbing are removed (they rot; a future change will add the descriptors when the first caller needs control/replay modes).

**Alternatives considered:**

- Add `clock` / `random` / `fdWrite` tagged-union descriptors to `MainToWorker['init']` now in preparation for phase 2 — rejected as speculative scope; YAGNI. Phase 2 adds them when a concrete caller needs them.
- Preserve the existing TODO comments — rejected because they describe a future implementation that may take a different shape; speculative commentary decays.

### D9. Remove the three caller-provided-override spec requirements

They describe a closure-valued option API that cannot be implemented given the worker-thread architecture. No code currently satisfies them. Keeping them creates spec debt — readers and future implementers think "this must already work" and are misled.

**Chosen:** remove "Caller-provided clock override", "Caller-provided randomness override", and "Override options follow existing patterns" from the sandbox capability spec. Migration note points future control-mode authors to the descriptor-based API that phase 2 will introduce.

**Alternatives considered:**

- Modify the requirements to describe the observability API instead of the control API — rejected because the observability API is a distinct concern and should be spec'd as new requirements, not a rename of misfit ones.
- Leave the requirements in place — rejected as spec debt; they mislead.

## Sequence Diagram — clock read during a host.fetch

```
  guest code                    worker                       main thread
     │                            │                              │
     │ await fetch(url)           │                              │
     ├───────────────────────────►│                              │
     │                            │ emit system.request          │
     │                            │   name=host.fetch seq=1      │
     │                            │ refStack: [0, 1]             │
     │                            │                              │
     │                            │ (inside fetchImpl — perhaps  │
     │                            │  calls Date.now internally)  │
     │                            │                              │
     │                            │ WASI clock_time_get          │
     │                            │   REALTIME, anchor irrelevant│
     │                            │ emit system.call             │
     │                            │   name=wasi.clock_time_get   │
     │                            │   seq=2, ref=1               │
     │                            │   input={clockId:'REALTIME'} │
     │                            │   output={ns:<host time>}    │
     │                            │                              │
     │                            │ (fetch resolves)             │
     │                            │ emit system.response         │
     │                            │   name=host.fetch seq=3 ref=1│
     │                            │ refStack: [0]                │
     │                            │                              │
     │◄───────────────────────────┤ Response returned to guest   │
     │                            │                              │
     │ console.log(...)           │                              │
     ├───────────────────────────►│                              │
     │                            │                              │
     │                            │ ... guest code calls         │
     │                            │     crypto.randomUUID()      │
     │                            │ WASI random_get(buf, 16)     │
     │                            │ emit system.call             │
     │                            │   name=wasi.random_get       │
     │                            │   seq=5, ref=0               │
     │                            │   input={bufLen:16}          │
     │                            │   output={bufLen:16,         │
     │                            │     sha256First16: <hex>}    │
```

## Risks / Trade-offs

- **Event volume on hot WASI paths** → a tight loop `for (let i=0;i<10000;i++) Date.now();` emits 10 000 events. At ~10µs per postMessage, that adds ~100 ms overhead to a loop that was previously zero-cost. **Mitigation:** rare in practice; if it becomes a problem, the phase-2 `mode: 'host'` opt-out will provide a kill switch. Document the performance shape in SECURITY.md and release notes.

- **Pre-run WASI reads remain unobserved** → by design. PRNG seeding, libc init, and guest module-load reads are not emitted. **Mitigation:** accept; the volume is tiny and invariant across invocations. Replay phase will add a per-sandbox ledger if visibility is needed.

- **WASM crypto extension internals stay unobserved** → `crypto.subtle.*` operations run inside the extension's WASM memory without crossing a boundary we instrument. A workflow that generates a private key leaves no InvocationEvent trail for the generation itself — only its entropy consumption (via `random_get`). **Mitigation:** document in SECURITY.md §2 as a known observability gap; out of scope for this change.

- **Removing three spec requirements** may surprise readers who expected a `clock` / `random` option to exist → no code ever implemented them, so no behavior regresses. **Mitigation:** the REMOVED delta carries an explicit **Migration** pointer to the descriptor-based API that phase 2 will introduce.

- **`Logger` interface extension with `debug`** could break custom `Logger` implementations outside this workspace → internal-only package, the only structural implementer is `PinoLogger` which already has `debug`. **Mitigation:** test stubs in `factory.test.ts` add `debug: vi.fn()` — trivial.

- **`random_get` output hash discloses some structure of entropy** — a `sha256First16` of bytes is one-way, but it reveals "same bytes twice" to an attacker with event-store read access. For genuine determinism (replay), replay authors will need raw bytes, which belong in a snapshot-adjacent ledger — not the event store. **Mitigation:** the hash is the fingerprint; the bytes are never logged. Replay phase puts bytes in a separate trust-boundary artifact.

## Open Questions

None. The interview closed every decision above. The phase-2 scope (control modes, timers, `interruptHandler`) is explicitly out of scope and has no blocking dependencies on phase-1 choices.
