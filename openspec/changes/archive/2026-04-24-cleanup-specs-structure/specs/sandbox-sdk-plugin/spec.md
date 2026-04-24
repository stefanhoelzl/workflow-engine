## REMOVED Requirements

All requirements are absorbed into `sdk` under a new "Sdk-support plugin (guest-side action dispatch)" grouping.

### Requirement: createSdkSupportPlugin factory

**Reason**: The sdk-support plugin IS the guest-facing half of the SDK's `action()` factory; splitting the plugin across its own capability duplicates ownership. Fold into `sdk`.

**Migration**: See `sdk` — the full factory contract (dependsOn `host-call-action`, `__sdkDispatchAction` private descriptor, host-side validation of both input and output, locked `__sdk` global via `Object.defineProperty({writable:false,configurable:false})` wrapping a frozen inner object) is specced there with every scenario preserved (locked binding, frozen inner, success emits request/response, handler throws → action.error, input validation failure, output validation failure, callable auto-dispose, stale-guest tolerance).

### Requirement: action() SDK export is a passthrough

**Reason**: Same absorption; this requirement describes the SDK side of the same end-to-end flow.

**Migration**: See `sdk` — the `action()` wrapper calls `globalThis.__sdk.dispatchAction(name, input, handler)` and does not construct a `completer` closure.

### Requirement: No runtime-appended source

**Reason**: Same absorption. The no-runtime-source-append invariant belongs alongside the sdk-support plugin discussion in `sdk`, and is cross-referenced in `workflow-registry` under Sandbox loading.

**Migration**: See `sdk` (ownership) and `workflow-registry` (runtime enforcement).
