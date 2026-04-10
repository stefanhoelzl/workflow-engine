## REMOVED Requirements

### Requirement: Isolate-per-invocation
**Reason**: Replaced by QuickJS WASM sandbox. Fresh QuickJS context per invocation replaces fresh V8 isolate per invocation.
**Migration**: Use `action-sandbox` spec's "QuickJS WASM sandbox execution" and "Context disposal" requirements.

### Requirement: Memory limit enforcement
**Reason**: Resource limits deferred in initial QuickJS implementation. QuickJS supports memory limits via `runtime.setMemoryLimit()` — will be added later.
**Migration**: No immediate replacement. Future: add memory limits to `createSandbox()` options.

### Requirement: Execution timeout
**Reason**: Timeout enforcement deferred in initial QuickJS implementation. QuickJS supports interrupt handlers — will be added later via `AbortSignal`.
**Migration**: No immediate replacement. Future: wire `AbortSignal` to `runtime.setInterruptHandler()`.

### Requirement: JSON-only data boundary
**Reason**: Replaced by QuickJS WASM boundary. Data crosses the WASM boundary via explicit marshalling (not JSON serialization), but the effect is the same — no host references are accessible.
**Migration**: Use `action-sandbox` spec's "ctx.event and ctx.env as serialized data" requirement.

### Requirement: Minimal host API
**Reason**: Replaced by expanded but still controlled host API in QuickJS sandbox. The API now includes `ctx.event`, `ctx.env`, `ctx.emit()`, `ctx.fetch()`, plus safe globals.
**Migration**: Use `action-sandbox` spec's requirements for ctx bridging, fetch response proxy, and safe globals.

### Requirement: Synchronous emit bridge
**Reason**: Replaced by async deferred promise bridge. `ctx.emit()` is now async in the sandbox, using the deferred promise pattern instead of `isolated-vm`'s `applySync`.
**Migration**: Use `action-sandbox` spec's "Ctx bridging via deferred promises" requirement.
