## REMOVED Requirements

All requirements are absorbed into `actions` under a new "Host-call-action plugin (runtime validation surface)" grouping.

### Requirement: createHostCallActionPlugin factory

**Reason**: The host-call-action plugin IS the runtime side of action dispatch and Ajv validation. Its semantics (pre-compiled per-action Ajv validators, `ValidationError` with `issues` + `errors` shape, shared compile-cache WeakMap for cross-schema reuse, no guest-facing functions) describe the runtime mechanism behind the `actions` capability, not a standalone plugin concept.

**Migration**: See `actions` — the full factory contract is specced there with every scenario preserved (validators compiled per action per direction, valid input pass, invalid input throws with `errors`, valid output returned, invalid output throws with `issues`, unknown-action error for both directions).

### Requirement: Plugin depends on none

**Reason**: Same absorption.

**Migration**: See `actions` — `createHostCallActionPlugin` declares `dependsOn: []`; sdk-support depends on it. Topo-sort guarantees host-call-action worker runs before sdk-support.

### Requirement: Per-sandbox manifest binding

**Reason**: Same absorption.

**Migration**: See `actions` — validators are compiled at sandbox construction (once per cached `(tenant, sha)` sandbox) and persist for the sandbox's lifetime across runs.
