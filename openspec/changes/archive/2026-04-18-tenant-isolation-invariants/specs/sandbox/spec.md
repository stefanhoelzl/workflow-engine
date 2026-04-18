## MODIFIED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §2 Sandbox Boundary`. This capability is the single strongest isolation boundary in the system; any change to the public API, installed globals, host bridges, or VM lifecycle is a change to that boundary.

The QuickJS WASM isolation remains the primary guest/host boundary. Moving the host-bridge layer into a `worker_threads` worker does not alter the set of globals exposed to the guest and does not add a new Node.js surface visible to guest code. The worker is an implementation-level isolation layer for the host-bridge code itself, not a guest-visible change.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, change the VM lifecycle posture, alter what crosses the boundary, add a new global, or conflict with the rules in `/SECURITY.md §2` MUST update `/SECURITY.md §2` in the same change proposal. The worker-isolation change itself SHALL update `/SECURITY.md §2` to note the new execution topology (host-bridge runs in a worker isolate; only `emit` and other per-run main-side host methods cross the worker↔main boundary).

The implementation SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The sandbox is the load-bearing enforcement point for I-T2 on invocation-event writes: the `tenant` field stamped on every emitted `InvocationEvent` SHALL derive from the workflow's registration context (passed into the sandbox at construction by the host) and SHALL NOT be writable or influenceable by guest code. Any change that exposes a new host-bridge method through which guest code could observe, override, or forge the `tenant` field on emitted events breaks I-T2.

All lifecycle and security guarantees about the sandbox — VM construction, disposal, isolation, allowlisted globals, key-material containment — SHALL be codified in this capability spec rather than in consumer specs. Consumer specs (scheduler, context, workflow-loading, sdk) SHALL describe only how they use the sandbox's public API, not the sandbox's internal guarantees.

#### Scenario: Change alters sandbox boundary

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects entry points, installed globals, mitigations, residual risks, or rules enumerated in `/SECURITY.md §2`, or the tenant-stamping behaviour that upholds `/SECURITY.md §1 "Tenant isolation invariants"`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §2` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §2` or the tenant-isolation invariant in `/SECURITY.md §1`
- **THEN** no update to `/SECURITY.md` is required
- **AND** the proposal SHALL note that threat-model alignment was checked
