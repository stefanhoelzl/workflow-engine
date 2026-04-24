## Why

`openspec/specs/` has accumulated structural rot over 100+ archived changes. Eighteen of sixty live specs fail `openspec validate --specs --strict` today; two are empty tombstones; six carry a literal `TBD - update Purpose after archive` placeholder; the 1675-line `sandbox/spec.md` still describes a host-bridge architecture (`sandbox(source, methods, options)`, `__hostCallAction`, `__dispatchAction`, runtime source appending) that the `sandbox-plugin-architecture` change completely removed. Unrelated build specs overlap, narrow plugin specs duplicate their parent capabilities, and the `sandbox` / `sandbox-stdlib` boundary does not reflect the code after the `?sandbox-plugin` transform unified polyfills under `sandbox-stdlib`'s web-platform / fetch / timers / console plugins.

This proposal rewrites the spec layout so each capability maps to a coherent code module and every live spec reflects the real implementation. It is the sequencing anchor for `cleanup-specs-content` and `cleanup-specs-infrastructure`.

## What Changes

- **BREAKING (spec-layout)** Delete eight dead capabilities: `compose-stack`, `pulumi-stack`, `build`, `build-system`, `build-time-typecheck`, `vite-build`, `vite-plugin`, `webhooks-status`. Their content is either obsolete or absorbed by a successor capability in this change.
- **BREAKING (spec-layout)** Fold six narrow single-topic capabilities into their parents:
  - `sandbox-sdk-plugin` → `sdk` (the sdk-support plugin IS the guest-facing half of `action()`)
  - `sandbox-host-call-action-plugin` → `actions` (the plugin IS the runtime mechanism for action dispatch + Ajv validation)
  - `sandbox-trigger-plugin` → `triggers` (trigger lifecycle hooks inside the sandbox)
  - `sandbox-store` → `sandbox` (runtime-scoped per-`(tenant, sha)` sandbox reuse is sandbox consumer infrastructure)
  - `workflow-loading` → `workflow-registry` (loading is the read side of registry persistence)
  - `wpt-compliance-harness-plugin` → `wpt-compliance-harness` (the `createWptHarnessPlugin` factory belongs with the WPT harness itself)
- **BREAKING (spec-layout)** Reshape the sandbox boundary. `sandbox/spec.md` keeps the VM/isolation mechanism plus the Phase-1 quickjs-wasi extension globals (`atob`/`btoa`/`TextEncoder`/`TextDecoder`/`Headers`/`URL`/`URLSearchParams`/native `crypto.subtle`/native `DOMException`/`crypto.getRandomValues`). Every "Safe globals — X" requirement installed by a plugin (`EventTarget`, `AbortController`, `fetch`, `Request`, `Response`, `Blob`, `File`, `FormData`, streams, `URLPattern`, `structuredClone`, `queueMicrotask`, `reportError`, `indexedDB`, User Timing, `scheduler`, `Observable`, `DOMException` construct-trap wrapper, `subtle-crypto` wrapper, `console`, timers) moves to `sandbox-stdlib/spec.md`, organized by plugin (web-platform / fetch / timers / console). The `Hardened outbound fetch` requirement moves to `sandbox-stdlib` alongside its `createFetchPlugin` factory.
- **BREAKING (spec)** Remove the dead `Action call host wiring` requirement from `sandbox/spec.md`. It describes a signature (`sandbox(source, methods, options)`), host bridges (`__hostCallAction`, `__emitEvent`), and a runtime source-appending shim (`__dispatchAction`) that no longer exist. The actual mechanism (SDK-side `__sdk.dispatchAction` installed by the sdk-support plugin, host-side validation by the host-call-action plugin) is captured in the new `sdk` and `actions` content.
- Introduce one new capability: `runtime-build` (the Vite SSR build of `packages/runtime/src/main.ts`, native-binding externalization including the patched `fetch-blob`, `pnpm build` / `pnpm start` scripts). Symmetric with the retained `workflow-build` capability.
- Rework `workflow-build`: absorb the two removed build specs' real content (manifest generation, build-time typecheck, fixed strict compiler options, TypeScript peer dep, explicit-workflow-list plugin input, export-identifier rules).
- Fill in the TBD Purpose of each surviving sandbox plugin spec (`sandbox-plugin`, `sandbox-stdlib`) that this change keeps.
- Add a `## Purpose` section to every live spec kept by this change that currently lacks one (`docker`, `http-security`, `linting-formatting`, `network-policy-profiles`, `pod-security-baseline`, `storage-backend`, `testing-setup`, `typescript-config`, `workflow-manifest`). Content-level reconciliation of these specs is out of scope — this is a validation-hygiene fix only.
- Do NOT reconcile spec CONTENT against current code in this change. `runtime-config`, `auth`, `trigger-ui`, `dashboard-list-view`, `executor`, `sdk`, `http-trigger`, `action-upload`, `cli`, `ci-workflow`, `infrastructure` each carry known rot from recent upgrade notes — those are the scope of `cleanup-specs-content` and `cleanup-specs-infrastructure`, which apply AFTER this change.

## Capabilities

### New Capabilities
- `runtime-build`: Vite SSR build of the runtime (`packages/runtime`) to `dist/main.js`, native-binding externalization, `fetch-blob` pnpm-patch handling, `pnpm build` / `pnpm start` scripts.

### Modified Capabilities
- `sandbox`: remove every plugin-installed "Safe globals" requirement (moved to `sandbox-stdlib`); remove the dead `Action call host wiring` requirement; add a requirement documenting the Phase-1 quickjs-wasi extension globals as the VM-level baseline; update the `performance.now` requirement body to match the current WASI-anchor lifecycle (bridge.setRunContext is gone); split `DOMException` and WebCrypto requirements between native surface (stays) and web-platform wrapper (moves). Absorb the three `sandbox-store` requirements.
- `sandbox-stdlib`: rewrite Purpose; absorb every plugin-installed safe-global requirement from `sandbox`; absorb `Hardened outbound fetch`; group by plugin (web-platform, fetch, timers, console).
- `sandbox-plugin`: rewrite Purpose (the Plugin type, composition, boot phases — the mechanism, not the catalogue).
- `sandbox-store`: **REMOVED** (requirements absorbed into `sandbox`).
- `sandbox-sdk-plugin`: **REMOVED** (requirements absorbed into `sdk`).
- `sandbox-host-call-action-plugin`: **REMOVED** (requirements absorbed into `actions`).
- `sandbox-trigger-plugin`: **REMOVED** (requirements absorbed into `triggers`).
- `workflow-loading`: **REMOVED** (requirements absorbed into `workflow-registry`).
- `wpt-compliance-harness-plugin`: **REMOVED** (one requirement absorbed into `wpt-compliance-harness`).
- `sdk`: absorb sdk-support plugin requirements (`__sdk` locked-global discipline, `dispatchAction` signature, guest-source capture).
- `actions`: absorb host-call-action plugin requirements (Ajv input + output validator compilation, ValidationError shape, host-side enforcement).
- `triggers`: absorb trigger plugin requirements (`trigger.request` / `trigger.response` / `trigger.error` emission via run-lifecycle hooks; `createsFrame` / `closesFrame` discipline).
- `workflow-registry`: absorb `workflow-loading` requirements (no runtime source appending; env resolution at build time; phase-4 global visibility contract).
- `wpt-compliance-harness`: absorb `createWptHarnessPlugin` factory requirement.
- `http-trigger`: absorb the two `webhooks-status` requirements (status-code mapping between handler return and HTTP response).
- `workflow-build`: absorb requirements from the removed `build`, `build-system`, `build-time-typecheck`, `vite-plugin` capabilities that pertain to the workflow build pipeline (manifest generation, TypeScript typecheck, strict compiler options, explicit workflow list, TypeScript peer dep, export-identifier rules).
- `compose-stack`: **REMOVED** (dead tombstone — pulumi replaced compose stack, and pulumi itself is gone).
- `pulumi-stack`: **REMOVED** (dead tombstone — replaced by `infrastructure` which is itself retained).
- `build`: **REMOVED** (replaced by `runtime-build` + `workflow-build`).
- `build-system`: **REMOVED** (replaced by `runtime-build`; Vite-version and SDK-build requirements absorbed).
- `build-time-typecheck`: **REMOVED** (absorbed into `workflow-build`).
- `vite-build`: **REMOVED** (replaced by `runtime-build`).
- `vite-plugin`: **REMOVED** (absorbed into `workflow-build`).
- `webhooks-status`: **REMOVED** (absorbed into `http-trigger`).
- `docker`: add Purpose section (validation fix only; contents untouched beyond the Purpose header).
- `http-security`: add Purpose section (validation fix only).
- `linting-formatting`: add Purpose section (validation fix only).
- `network-policy-profiles`: add Purpose section (validation fix only).
- `pod-security-baseline`: add Purpose section (validation fix only).
- `storage-backend`: add Purpose section (validation fix only).
- `testing-setup`: add Purpose section (validation fix only).
- `typescript-config`: add Purpose section (validation fix only).
- `workflow-manifest`: add Purpose section (validation fix only).

## Impact

- **Specs.** Net capability count drops from 60 to ~47. `openspec validate --specs --strict` should go from 18 failures to ≤1 after this change applies (the remaining failures, if any, belong to content-level rot handled by the follow-on proposals).
- **Code.** None. This change edits no TypeScript, HCL, YAML, or shell script. It is spec-content-only.
- **Documentation.** `openspec/project.md` may need a nudge if it references deleted capability names; `SECURITY.md` does not (it references component names in the code, not spec capability names).
- **Downstream proposals.** `cleanup-specs-content` and `cleanup-specs-infrastructure` are drafted against the post-structure capability layout and cannot apply until this change lands.
- **Tenants.** None. No runtime behaviour, no manifest schema, no upload/download path is touched.
