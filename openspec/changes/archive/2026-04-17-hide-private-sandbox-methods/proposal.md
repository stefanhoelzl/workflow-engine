## Why

The sandbox installs several `__*`-prefixed globals on `globalThis` as plumbing for its built-in shims (`__hostFetch` for the fetch shim, `__emitEvent` for action telemetry, `__reportError` for the reportError shim) and the runtime appends a plain-JS `__dispatchAction` that consumes `__hostFetch`-adjacent capabilities (`__hostCallAction`). Once these globals are installed they remain **readable and writable by guest code** for the life of the VM. This hands untrusted workflow code two latent capabilities it should not have: (a) it can read the raw host bridges directly instead of going through their shims — bypassing serialization guards and shim invariants — and (b) it can overwrite the bridges to install rogue implementations that poison every subsequent `fetch`, `reportError`, action dispatch, or event emission. Defense-in-depth for the sandbox's strongest boundary demands that these plumbing names disappear before guest code starts running.

## What Changes

- **BREAKING (guest-observable surface)**: `__hostFetch`, `__emitEvent`, `__hostCallAction`, and `__reportError` SHALL NOT be present on `globalThis` once workflow source evaluation is complete. Each is installed at init for the consumption of exactly one shim (FETCH_SHIM, ACTION_DISPATCHER_SOURCE, REPORT_ERROR_SHIM), captured into that shim's IIFE closure, and deleted from `globalThis` before the shim returns.
- **BREAKING (runtime internals)**: `__dispatchAction` SHALL remain on `globalThis` (it is read by `core.dispatchAction()` on every action call) but SHALL be installed via `Object.defineProperty` with `writable: false` and `configurable: false`. Guest code cannot swap or delete the dispatcher. The accepted residual risk — guest calling the live dispatcher with `(validName, realInput, fakeHandler, fakeSchema)` to emit audit events that misrepresent the actual handler — is documented in SECURITY.md §2.
- **BREAKING (test surface)**: per-run `extraMethods.__reportError` override is removed. Consumers that want `reportError` to be captured SHALL pass `__reportError` at construction via `methods`. The existing per-run override test is removed.
- `__setActionName` is deleted from each action callable after the runtime binder shim runs. Minor hygiene; not a security change.
- `RESERVED_BUILTIN_GLOBALS` drops `__hostFetch` and `__emitEvent`. Hiding is enforced by the capture-and-delete shims, not by the reservation list. Hosts that wish to deliberately reinstall these names via per-run `extraMethods` MAY do so; the host's explicit choice is honored.
- SECURITY.md §2 "Bridge surface inventory" rewritten to describe the install → capture → delete lifecycle and the locked `__dispatchAction` exposure.

## Capabilities

### New Capabilities

None. All changes modify existing specs.

### Modified Capabilities

- `sandbox`: requirements around `__hostFetch`, `__reportError`, `__hostCallAction`, and the guest-visible globals list change from "installed and reachable by guest" to "installed, captured by shim, deleted post-init". New requirement added for `__emitEvent` (previously undocumented in the spec) and for the locked `__dispatchAction` guest global. The `Sandbox exposes only these globals` requirement drops `__hostFetch` and `__reportError` from its guest-visible inventory.
- `sdk`: the `action factory returns typed callable` requirement currently describes the callable body as `(input) => __hostCallAction(<name>, input)` — stale pre-proposal, actively false post-proposal (since `__hostCallAction` is no longer guest-reachable). Rewritten to describe the dispatcher indirection that actually exists.
- `vite-plugin`: the `Action call resolution at build time` requirement currently claims the plugin rewrites the callable body at build time. Reality is a two-layer name binding (plugin walks exports for manifest derivation; runtime appends a binder shim that calls `__setActionName` at sandbox eval time to populate the VM-fresh closure). Rewritten to describe both layers.
- `workflow-loading`: the `__hostCallAction bound to workflow's manifest` requirement continues to hold at the host-bridge level, but its scenarios that imply guest-side `__hostCallAction` visibility are rewritten to describe the dispatcher-shim capture semantics.

## Impact

**Code affected:**

- `packages/sandbox/src/globals.ts` — `FETCH_SHIM` captures `__hostFetch` in IIFE closure and deletes from `globalThis`; `REPORT_ERROR_SHIM` captures `__reportError` and deletes.
- `packages/sandbox/src/index.ts` — `RESERVED_BUILTIN_GLOBALS` drops `__hostFetch` and `__emitEvent`.
- `packages/runtime/src/workflow-registry.ts` — `ACTION_DISPATCHER_SOURCE` rewritten as an IIFE that captures `__hostCallAction` + `__emitEvent`, installs `__dispatchAction` via `Object.defineProperty{writable: false, configurable: false}`, then deletes `__hostCallAction` + `__emitEvent`; `buildActionNameBinder` deletes `__setActionName` after binding.
- `packages/sandbox/src/sandbox.test.ts` — 5 `__emitEvent` direct-call tests reframed to exercise via dispatcher/action path; per-run `__reportError` override test deleted; `__reportError absent throws ReferenceError` test deleted; new tests for post-init surface invisibility and `__dispatchAction` lock.
- `packages/sandbox/src/host-call-action.test.ts` — direct `__hostCallAction` calls rewritten to exercise via SDK action callable.

**Specs affected:**

- `openspec/specs/sandbox/spec.md` — five requirements modified; two added.
- `openspec/specs/sdk/spec.md` — one requirement modified.
- `openspec/specs/vite-plugin/spec.md` — one requirement modified.
- `openspec/specs/workflow-loading/spec.md` — scenarios modified.

**Docs affected:**

- `SECURITY.md` §2 — "Bridge surface inventory", "Globals exposed inside the sandbox", and "Rules for AI agents" all updated to reflect the install → capture → delete lifecycle.

**No external API changes.** The SDK's `action()`, the runtime's `invokeHandler`, and the workflow-authoring surface are unaffected. The sandbox factory signature is unchanged.

**Threat model delta:**

- Closes: guest-side overwrite of `fetch`/`reportError`/action dispatcher via direct assignment to the underlying `__*` bridge.
- Closes: guest-side direct calls to raw bridges (e.g., `__hostFetch(method, url, ...)` bypassing the fetch shim).
- Residual accepted: guest can still call `__dispatchAction(validName, realInput, fakeHandler, fakeSchema)` to emit audit events that misrepresent the dispatched handler. Documented in SECURITY.md §2 as an accepted residual.
