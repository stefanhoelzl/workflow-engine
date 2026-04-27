## ADDED Requirements

### Requirement: system.exhaustion event kind

The runtime SHALL recognise a leaf event kind `system.exhaustion` under the existing reserved `system.*` prefix. The kind represents a per-run sandbox **terminal-class** resource-limit breach (cpu, output, pending) and SHALL carry:

```
kind: "system.exhaustion"
name: "cpu" | "output" | "pending"      // terminal dimensions ONLY
type: "leaf"
input: {
  budget: number,        // the configured cap in the unit of the dimension
  observed?: number      // present only when measurable post hoc:
                         //   cpu:     elapsed ms at terminate
                         //   output:  cumulative bytes including the breaching event
                         //   pending: in-flight count at the breaching dispatch
}
```

Recoverable-class breaches (memory, stack) SHALL NOT emit `system.exhaustion`. A recoverable breach surfaces as a normal QuickJS exception inside the guest; if uncaught, it produces an ordinary `RunResult{ok:false, error}` and a regular `trigger.error` close — no `system.exhaustion` precedes it. See `sandbox/spec.md` "Sandbox resource caps — two-class classification".

`system.exhaustion` events SHALL be emitted by the sandbox layer (`packages/sandbox/src/sandbox.ts`) on the main thread when a worker termination is classified as `{kind:"limit", dim}` via `worker-termination.cause()`. The leaf SHALL be emitted via `sequencer.next({type:"leaf", kind:"system.exhaustion", name: dim, input: {...}})` BEFORE `sequencer.finish({closeReason})` synthesises LIFO close events for any still-open frames. Seq/ref are stamped by the `RunSequencer`; no manual fabrication.

`system.exhaustion` SHALL NOT be emitted by:
- guest code (no SDK API exists for emitting arbitrary kinds)
- plugin code (the prefix is reserved for runtime-driven happenings)
- the executor (synthesis lives in the sandbox layer to keep it adjacent to the RunSequencer that owns seq/ref stamping)
- recovery (recovery's domain is process-restart synthesis of `engine_crashed` terminals; resource-limit breaches happen against a live sandbox that handles synthesis itself)

The synthesised `trigger.error` close emitted by `sequencer.finish({closeReason: \`limit:${dim}\`})` carries `error: { message: "limit:<dim>" }` and serves as the terminal event for the invocation. No additional `error.kind` discriminant or `error.dimension` field is added — the dimension is structurally available via the preceding `system.exhaustion` leaf for programmatic consumers, and via the message format for raw EventStore consumers.

#### Scenario: CPU breach emits system.exhaustion with observed elapsed

- **GIVEN** a sandbox with `cpuMs = 100` running an infinite loop
- **WHEN** the watchdog terminates the worker at ~100ms
- **THEN** the sandbox SHALL emit a `system.exhaustion` leaf with `name: "cpu"`, `input: { budget: 100, observed: <≈100> }`
- **AND** the synth `trigger.error` close emitted afterwards SHALL carry `error: { message: "limit:cpu" }`

#### Scenario: Memory breach does NOT emit system.exhaustion (recoverable)

- **GIVEN** a sandbox with `memoryBytes = 1048576` whose guest code OOMs
- **WHEN** the OOM exception surfaces inside the VM
- **THEN** NO `system.exhaustion` leaf SHALL be emitted (memory is a recoverable cap)
- **AND** the run SHALL produce an ordinary `RunResult{ok:false, error:{message: /out of memory/}}` if the guest does not catch, OR succeed if the guest catches

#### Scenario: Output breach reports cumulative bytes observed

- **GIVEN** a sandbox with `outputBytes = 4194304` whose guest emits 4194305 cumulative bytes
- **WHEN** the worker terminates
- **THEN** the leaf SHALL carry `name: "output"`, `input: { budget: 4194304, observed: <≥4194305> }`

#### Scenario: Crash termination emits no system.exhaustion

- **GIVEN** a sandbox whose worker dies of an uncaught non-limit error
- **WHEN** `termination.cause()` returns `{kind:"crash", err}`
- **THEN** NO `system.exhaustion` leaf SHALL be emitted
- **AND** `sequencer.finish({closeReason: \`crash:${err.message}\`})` SHALL still synthesise LIFO closes for any open frames
