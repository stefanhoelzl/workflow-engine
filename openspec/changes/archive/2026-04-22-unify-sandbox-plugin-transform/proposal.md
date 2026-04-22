## Why

The sandbox ecosystem currently ships **two** vite plugins — `sandboxPlugins()` (host-side ESM worker bundles) and `sandboxPolyfills()` (guest-side IIFE polyfill bundle) — with polyfill ownership leaking into the runtime: `sandbox-store.ts` imports `virtual:sandbox-polyfills` and hand-wires it into the web-platform plugin's `config.bundleSource`. The split reflects two real VM targets (Node `worker_thread` vs QuickJS) but the build tooling, naming, and ownership boundary are accidental rather than load-bearing. A plugin that owns both host and guest behavior is spread across three locations (its source file, a virtual runtime module, a runtime wiring call).

## What Changes

- **BREAKING internal contract**: `PluginDescriptor.source` renamed to `PluginDescriptor.workerSource`; a new optional `PluginDescriptor.guestSource` field carries the IIFE guest bundle when the plugin file exports a `guest` function.
- **BREAKING internal contract**: `PluginSetup.source` (returned from `worker()`) removed. Phase-2 source evaluation sources strings from `descriptor.guestSource` keyed by plugin name instead.
- **BREAKING internal contract**: Plugin file contract extended — plugin files MAY export a zero-arg `guest(): void` function alongside `worker`. The `?sandbox-plugin` vite transform bundles it into an IIFE via a second rollup pass with `treeshake: { moduleSideEffects: false }` on the worker pass (to drop guest-only imports cleanly).
- The `sandboxPolyfills()` vite plugin, `virtual:sandbox-polyfills` virtual module, and all associated `.d.ts` shims are **removed**.
- The `web-platform` plugin's `Config.bundleSource` field is **removed**. Its polyfill source moves into an exported `guest()` function in the same file; the polyfill entry tree (`source/*.ts`) is renamed to `guest/*.ts` and invoked from `guest()`.
- `__WFE_VERSION__` replacement is **removed**; `navigator.userAgent` hardcodes `"WorkflowEngine"`.
- `fetch-blob` v4's top-level-await block is eliminated via `pnpm patch` (new `patches/fetch-blob@<version>.patch` + `pnpm.patchedDependencies` entry) rather than a build-time rollup transform.
- `sandbox-store.ts` stops importing `virtual:sandbox-polyfills` and stops assembling `webPlatformConfig`; the runtime becomes blind to polyfill wiring.
- String-assertion tests that grep `setup.source` (console, sdk-support) are replaced with either direct `guest()` calls in Node against a staged `globalThis` (Strategy A) or real-sandbox integration tests using a minimal `withPluginSandbox(descriptors, source, fn)` helper (Strategy B). WPT continues to cover web-platform spec compliance.
- No tenant re-upload required; no pending/archive state wipe; no manifest format change. Bundle format, sandbox boundary semantics, and storage layout are unchanged.

## Capabilities

### New Capabilities

_(none — every changed behavior lives in an existing capability)_

### Modified Capabilities

- `sandbox-plugin`: `PluginDescriptor` shape changes (`source` → `workerSource`, new `guestSource?`); `PluginSetup.source` removed; plugin file contract extended with optional `guest` export; `?sandbox-plugin` vite transform performs a second rollup pass for plugins that export `guest`.
- `sandbox-stdlib`: `sandboxPolyfills()` vite plugin and `virtual:sandbox-polyfills` virtual module removed; web-platform plugin's `Config.bundleSource` removed and replaced by an exported `guest()` function that installs polyfills directly; `__WFE_VERSION__` replacement removed; `fetch-blob` TLA handled via pnpm patch.
- `sandbox`: Phase-2 source evaluation reads `descriptor.guestSource` rather than `setup.source`.

## Impact

**Affected code**:
- `packages/sandbox/src/vite/sandbox-plugins.ts` — extended with a second rollup pass and `guest` export detection.
- `packages/sandbox/src/plugin.ts` — `PluginDescriptor` field renamed and extended; `PluginSetup.source` deleted.
- `packages/sandbox/src/plugin-runtime.ts` — Phase-2 reads `descriptor.guestSource` instead of `setup.source`.
- `packages/sandbox/src/worker-plugin-loader.ts` — loads `descriptor.workerSource` (renamed).
- `packages/sandbox-stdlib/src/web-platform/vite-plugin.ts` — **deleted**.
- `packages/sandbox-stdlib/src/web-platform/index.ts` — adds `guest()` export, removes `Config` and the conditional `setup.source` branch.
- `packages/sandbox-stdlib/src/web-platform/source/` → `packages/sandbox-stdlib/src/web-platform/guest/` (directory rename); `trivial.ts` hardcodes `"WorkflowEngine"` userAgent.
- `packages/sandbox-stdlib/src/web-platform/source/guest.d.ts` — **deleted** (no more `__WFE_VERSION__` ambient).
- `packages/sandbox-stdlib/src/console/index.ts` and `packages/sdk/src/sdk-support/index.ts` — migrate from returning `PluginSetup.source` strings to exporting `guest()` functions.
- `packages/runtime/src/sandbox-store.ts` — remove `virtual:sandbox-polyfills` import and `webPlatformConfig` wiring.
- `packages/runtime/src/virtual.d.ts`, `packages/sandbox-stdlib/test/wpt/harness/virtual.d.ts` — remove `virtual:sandbox-polyfills` declarations.
- `packages/runtime/vite.config.ts`, `vitest.config.ts`, `packages/sandbox-stdlib/test/wpt/vitest.config.ts` — remove `sandboxPolyfills()` registration.
- Plugin unit tests (`console.test.ts`, `sdk-support.test.ts`, `web-platform.test.ts`) — replace string-assertion tests with direct `guest()` tests or real-sandbox integration tests.

**Affected APIs**:
- Internal `PluginDescriptor` / `PluginSetup` shapes — not tenant-visible, not sandbox-boundary.
- Public `createFetchPlugin`, `createSandboxFactory`, and tenant-facing SDK surfaces — unchanged.

**Dependencies**:
- New: `pnpm patch` tracking a patched `fetch-blob` version; `patches/fetch-blob@<version>.patch` committed.
- Unchanged: `rollup`, `@rollup/plugin-*`, `rollup-plugin-esbuild`, vite, all tenant-facing dependencies.

**Security**:
- No sandbox-boundary shape change. §2 plugin-discipline rules R-1 through R-8 unchanged. The capture-and-delete pattern used by existing polyfills for host bridges continues unchanged; `guest()` is simply the new container for that pattern instead of an anonymous IIFE string.
- SECURITY.md §2 wording that references `PluginSetup.source` or `virtual:sandbox-polyfills` will be updated in the same change to match the new names.

**Migration**:
- No tenant re-upload required (bundle format unchanged).
- No `pending/` or `archive/` wipe.
- No manifest format change.
- Internal refactor only; release-through-main path unaffected.
