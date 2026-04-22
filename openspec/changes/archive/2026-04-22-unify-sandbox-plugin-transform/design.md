## Context

Two vite plugins currently build the sandbox ecosystem's TypeScript sources into strings the sandbox evaluates at two layers:

1. **`sandboxPlugins()`** (`packages/sandbox/src/vite/sandbox-plugins.ts`) resolves `<path>?sandbox-plugin` imports. Each import is rollup-bundled via a synthetic entry (`export { worker as default } from <path>`) into a self-contained ESM module string whose default export is the plugin's `worker(ctx, deps, config)` function. The sandbox worker thread loads this string via a `data:text/javascript;base64,...` dynamic `import()`.
2. **`sandboxPolyfills()`** (`packages/sandbox-stdlib/src/web-platform/vite-plugin.ts`) resolves the virtual module `virtual:sandbox-polyfills` into an IIFE string bundling `source/entry.ts` — the WinterCG-minimum polyfill suite (Streams, Blob, EventTarget, URLPattern, CompressionStream, scheduler, etc.) — plus a one-off rollup transform that strips `fetch-blob` v4's top-level-await block (rollup IIFE format rejects TLA). The runtime imports this string (via `import SANDBOX_POLYFILLS from "virtual:sandbox-polyfills"`) and hand-wires it into the `web-platform` plugin as `config.bundleSource`. The plugin's `worker()` returns it as `PluginSetup.source`, which the sandbox kernel evaluates as a top-level guest script in Phase 2.

The ESM/IIFE split is a real QuickJS constraint — QuickJS has no module loader, only top-level script eval — not an accidental one. But **ownership** of the guest-side bundle leaks across three locations (sandbox-stdlib owns the rollup pass; runtime owns the virtual-module import and config wiring; web-platform owns a `Config.bundleSource` pass-through). Every plugin except `web-platform` is `worker`-only and needs no polyfill wiring; only `web-platform` and two other plugins (`console`, `sdk-support`) author guest-side source at all, and those two hand-write template-literal IIFE strings that the `?sandbox-plugin` transform does not see.

Security discipline (`SECURITY.md` §2) and plugin lifecycle phases (§sandbox-plugin #Lifecycle) are unchanged by this refactor. The sandbox boundary, bundle format, manifest format, storage layout, and tenant-facing APIs are unchanged.

## Goals / Non-Goals

**Goals:**

- Collapse the two vite plugins into **one** `?sandbox-plugin` transform with two rollup passes per plugin file (worker ESM + guest IIFE).
- Move guest-source ownership **into the plugin source file itself** via an optional `export function guest(): void`.
- Eliminate `virtual:sandbox-polyfills`, `sandboxPolyfills()`, `config.bundleSource`, and the runtime's `SANDBOX_POLYFILLS` import.
- Replace the build-time `stripFetchBlobTLA` rollup plugin with a `pnpm patch` on `fetch-blob` (the patch lives at the dependency boundary, where the constraint conceptually belongs).
- Rename `PluginDescriptor.source` → `workerSource` for symmetry with the new `guestSource?` field.
- Remove `PluginSetup.source` (returned from `worker()` at runtime) in favor of `PluginDescriptor.guestSource` (baked in at build time).
- Replace fragile string-assertion tests (`expect(setup.source).toContain(...)`) with either direct `guest()` calls in Node (staged `globalThis`) or a minimal-sandbox integration helper `withPluginSandbox(descriptors, source, fn)`.
- Drop `__WFE_VERSION__` substitution; hardcode `navigator.userAgent = "WorkflowEngine"` in `trivial.ts`.

**Non-Goals:**

- Changing the sandbox boundary, the `SandboxContext` API, or any tenant-visible SDK.
- Changing `SandboxStore` (its `bundleSource` parameter is the tenant workflow bundle, unrelated to polyfills).
- Changing WASI plugin composition, trigger backends, or event semantics.
- Rewriting the Phase-2 evaluator (`plugin-runtime.ts`) beyond swapping its source of truth from `PluginSetup.source` to `descriptor.guestSource`.
- Relocating any spec capabilities; all changes are delta edits against `sandbox-plugin`, `sandbox-stdlib`, and `sandbox` specs.
- Migrating tenant bundles, wiping `pending/`/`archive/`, or changing the tenant upload flow.

## Decisions

### D1. Inline `guest()` function in the plugin source file

Each plugin file MAY export `guest(): void` alongside `worker(ctx, deps, config)`:

```ts
// packages/sandbox-stdlib/src/web-platform/index.ts
import { installStreams } from "./guest/streams.js";
import { installBlob } from "./guest/blob.js";
// ... other installers

export const name = "web-platform";

export function guest(): void {
  installStreams();
  installBlob();
  // capture + delete host bridges, install polyfills, etc.
}

export function worker(ctx: SandboxContext): PluginSetup {
  return { guestFunctions: [reportErrorHostDescriptor(ctx)] };
}
```

Simple plugins (e.g. `console`, `sdk-support`) inline the full guest body directly inside `guest()`. Plugins with heavy guest trees (e.g. `web-platform`'s dozen polyfill files) keep per-topic installer files under a `./guest/*.ts` directory and compose them from `guest()`.

**Rationale**: Symmetric with `worker`. Co-locates the two halves of a plugin's behavior in one file. Reviewers see both surfaces at once. The optional sibling-file layout is an author-ergonomics choice, not a vite-transform concern.

**Alternative rejected**: _Path string (`export const guest = "./source/entry.ts"`)_. Required a second naming convention and a separate `transform` hook for fetch-blob TLA. Inline function removes both needs.

**Alternative rejected**: _Sibling-file convention (`./guest.ts` auto-detected)_. Magic filename without an export surface; less discoverable; no way to compose multiple installer files without re-introducing the path-based approach.

### D2. One vite plugin with two rollup passes

The `sandboxPlugins()` transform (moved to `packages/sandbox/src/vite/sandbox-plugins.ts`, renamed as needed) performs two rollup builds for every `<path>?sandbox-plugin` resolution:

| Pass | Synthetic entry | Format | `treeshake` |
| --- | --- | --- | --- |
| Worker | `export { worker as default } from "<path>";` | `esm` | `{ moduleSideEffects: false }` |
| Guest (skipped if the plugin file has no `guest` export) | `import { guest } from "<path>"; guest();` | `iife` | `true` (default) |

Both passes share the existing plugin list (`esbuild`, `nodeResolve`, `commonjs`). Pass 2 does not mark `node:*` as external (guest code MUST NOT reach Node builtins; a guest-side `node:fs` import is a bundle-time failure, which is the desired early signal).

The transform's `load()` hook emits:

```ts
import * as mod from "<absolute-plugin-path>";
export const name = mod.name;
export const dependsOn = mod.dependsOn;
export const workerSource = "<bundled-ESM-string>";
export const guestSource = "<bundled-IIFE-string>"; // omitted when no `guest` export
export default { name, dependsOn, workerSource, guestSource };
```

**Rationale**: A single transform is simpler for consumers (one `vite.config.ts` registration), co-locates the build-tool knowledge about sandbox-ecosystem code, and maps 1:1 to the plugin file contract.

**Alternative rejected**: _Keep two plugins, colocate only ownership_. Does not improve ergonomics; leaves a cross-package virtual-module dance.

**Alternative rejected**: _Commit a pre-built IIFE artifact on disk_. Requires a separate codegen step and a CI drift guard; adds more surface than it removes.

### D3. `treeshake: { moduleSideEffects: false }` on the worker pass ONLY

A spike (see Risk R1 below) confirmed that when a plugin file imports guest-only packages like `web-streams-polyfill`, rollup's default tree-shake **preserves** those imports in the worker bundle — even though no code reachable from the worker synthetic entry references them — because the package declares no `sideEffects: false` in its `package.json`. Setting `moduleSideEffects: false` tells rollup to treat all bundled modules as side-effect-free by default, dropping unreferenced imports cleanly.

The guest pass keeps the default tree-shake because `guest()` is reachable and pulls in exactly what it needs; `moduleSideEffects: false` on the guest pass would risk dropping legitimate module-level initialization in polyfill packages.

**Rationale**: Flag scope is minimal (worker pass only, where it's safe) and load-bearing (without it, worker bundles leak ~60KB of guest polyfill code).

### D4. `PluginDescriptor` shape change

```ts
// packages/sandbox/src/plugin.ts
interface PluginDescriptor<Config extends SerializableConfig = SerializableConfig> {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  readonly workerSource: string;   // was: `source`
  readonly guestSource?: string;   // new
  readonly config?: Config;
}
```

`PluginSetup.source` is removed (only `web-platform` used it, and only as a passthrough of `config.bundleSource`).

**Phase-2 source evaluation** (`packages/sandbox/src/plugin-runtime.ts`) now reads `descriptor.guestSource` via a descriptor map keyed by plugin name, iterating in the same topo order as today. Behavior is unchanged: per-plugin guest IIFE evaluated at Phase 2, between Phase-1 worker setup and Phase-3 capture-and-delete of private guest functions.

**Rationale**: Guest source is a build-time fact; making it a descriptor field (rather than a worker() return value) removes the runtime plumbing needed to pass config through to a worker() that only passes it back.

### D5. `fetch-blob` TLA handled via `pnpm patch`

`fetch-blob` v4's `index.js` contains a top-level `if (!globalThis.ReadableStream) { await import("node:process"); ... }` Node fallback. Rollup IIFE format rejects TLA syntactically. The current `stripFetchBlobTLA()` rollup plugin removes the block at bundle time; the `streams.ts` polyfill installs `ReadableStream` before `blob.ts` loads, so the TLA branch is dead at runtime.

This change replaces the build-time transform with a `pnpm patch` on the committed version. `pnpm patch fetch-blob@<version>` generates `patches/fetch-blob@<version>.patch`; adding the entry to `package.json`'s `pnpm.patchedDependencies` activates it on install.

**Rationale**: The constraint is about the dependency, not the build tool. pnpm will warn on version mismatches during upgrade; the patch is a small, reviewable commit. Removing `stripFetchBlobTLA` simplifies the unified transform and eliminates a class-of-bug (rollup-plugin authoring).

**Alternative rejected**: _Fork / vendor fetch-blob_. Higher ongoing maintenance burden.

**Alternative rejected**: _Inline a minimal Blob implementation_. Larger diff; diverges from the WinterCG conformance signal WPT provides against the real package.

### D6. Drop `__WFE_VERSION__` substitution

The `trivial.ts` polyfill currently reads `navigator.userAgent = "WorkflowEngine/${__WFE_VERSION__}"`; the version is injected via `@rollup/plugin-replace` from `packages/sandbox-stdlib/package.json`. No consumer depends on the version suffix.

Change: hardcode `navigator.userAgent = "WorkflowEngine"` (no version component). Delete the `replace` rollup step, the `readSandboxVersion()` helper, and the `guest.d.ts` ambient `__WFE_VERSION__` declaration.

**Rationale**: The version-in-userAgent has no consumer. Dropping it removes the last need for plugin-specific rollup hooks in the guest pass.

### D7. Testing seam

Today, guest-side behavior is asserted in three ways:

| Layer | Today | Post-change |
| --- | --- | --- |
| `worker()` unit tests | ✓ | ✓ (unchanged) |
| String-assertion on `setup.source` (`console`, `sdk-support`) | ✓ fragile | **Deleted** — rollup output is not grep-stable |
| WPT integration suite for polyfill spec compliance | ✓ | ✓ (unchanged) |

Two new helpers replace the string-assertion layer:

- **Strategy A — `withGlobalThis(fakeGlobal, fn)`**: a small test helper that runs a function against a surrogate `globalThis` (via a `Proxy` or `vm.runInNewContext`). Tests import `guest` directly and call it against a pre-staged fake global that provides any host bridges `worker()` would install. Used by plugins whose guest code is simple (e.g. `console`).
- **Strategy B — `withPluginSandbox(descriptors, tenantSource, fn)`**: a small helper in `@workflow-engine/sandbox` that spins up a real sandbox with the given plugin composition and runs the provided tenant source. Tests assert observable behavior inside the guest. Used by plugins whose guest code depends on multi-plugin composition (e.g. `sdk-support`).

**Rationale**: Post-refactor, the guest source string is a build artifact (rollup output), not hand-authored. String-greps of build artifacts are brittle; behavior assertions are robust.

### D8. No security-boundary change

Every §2 plugin-discipline rule (`R-1` through `R-8` in `SECURITY.md`) continues to apply unchanged. `guest()` is merely the new container for the capture-and-delete pattern (R-1). The Phase-2 eval order, Phase-3 private-descriptor deletion, and `__sdk` / `__reportErrorHost` discipline are all preserved bit-for-bit.

SECURITY.md wording that references `PluginSetup.source` or `virtual:sandbox-polyfills` is updated in the same change to match the new names.

## Risks / Trade-offs

- **R1 [Rollup tree-shake leak on worker pass]** — Without `treeshake: { moduleSideEffects: false }`, top-level imports of packages that don't declare `"sideEffects": false` leak into the worker bundle even when unreachable from the worker function. → Mitigation: the spike recorded in the exploration confirmed the flag's necessity; the `sandbox-plugins.test.ts` suite gains a dedicated test asserting that the worker bundle does NOT contain guest-only dependency names (e.g. `web-streams-polyfill`) and that the guest bundle does NOT contain `node:*` imports.
- **R2 [Node-only API accidentally used in `guest()`]** — Plugin files share a TS type-env (`types: ["node"]`). An author could reference `Buffer` or `process.env` inside `guest()` without a type error; the guest pass would fail at rollup-IIFE time (no `node:*` externals), surfacing the issue early, but not until bundle time. → Mitigation: existing discipline (author + review) unchanged; rollup bundle-time failure is the backstop. No new tooling added for this cycle.
- **R3 [Guest-only dep's module-level init dropped by `moduleSideEffects: false`]** — Only affects the **worker** pass (where guest deps are unreachable and SHOULD be dropped). The guest pass uses default tree-shake, preserving any module-level init that polyfill packages rely on. → Mitigation: the WPT suite is the integration check; unchanged coverage.
- **R4 [pnpm patch drift on fetch-blob upgrade]** — Upgrading `fetch-blob` past the patched version invalidates the patch; `pnpm install` warns but does not block. → Mitigation: the patch is minimal (one regex-ish block delete); regenerating it against a new version is ~5 minutes. CI's existing lockfile gate catches unintentional upgrades.
- **R5 [String-assertion test deletion loses coverage]** — The current `expect(setup.source).toContain("globalThis.console = con")` style asserts author intent at a lexical level. Replacement via `guest()` in Node asserts behavior but not lexical shape. → Mitigation: acceptable trade-off; behavior assertions are stronger. The vite transform's own tests (new cases) assert tree-shake separation, so the author-intent dimension is covered where it matters.
- **R6 [Eliminating `config.bundleSource` breaks tests that supply custom polyfill bundles]** — A hypothetical test might want a minimal polyfill set for faster setup; post-change it would need to construct a `PluginDescriptor` with a custom `guestSource` string directly. → Mitigation: no such tests exist today; `withPluginSandbox` helper accepts descriptors verbatim, so a future test that needs a custom bundle can pass one.
- **R7 [Large worker bundle retains Ajv etc.]** — The worker pass currently bundles `ajv` statically (for runtime's `host-call-action` plugin). Bundle size grows only if new worker-only deps are added; `moduleSideEffects: false` does not shrink what's actually used. → Mitigation: no action; bundle size of the worker ESM running in Node is not a hot path.

## Migration Plan

Single PR; internal refactor; no tenant-visible surface changes.

1. **Patch `fetch-blob`**: run `pnpm patch fetch-blob@<version>`, apply the TLA-block deletion, commit `patches/fetch-blob@<version>.patch` and the `pnpm.patchedDependencies` entry.
2. **Extend the `?sandbox-plugin` vite transform**: add the second rollup pass (IIFE guest bundle); emit `workerSource` + `guestSource` fields on the resolved virtual module.
3. **Rename `PluginDescriptor.source` → `workerSource`**; add optional `guestSource`; delete `PluginSetup.source` from the type. Update the `worker-plugin-loader` to read `workerSource`. Update Phase-2 in `plugin-runtime` to read `descriptor.guestSource`.
4. **Migrate `web-platform`**: add `export function guest()`; rename `source/*.ts` → `guest/*.ts`; drop `Config` type, `config.bundleSource` branch, and `__WFE_VERSION__` usage; hardcode `"WorkflowEngine"` userAgent. Delete `packages/sandbox-stdlib/src/web-platform/vite-plugin.ts` and `guest.d.ts`.
5. **Migrate `console` and `sdk-support`**: replace `buildConsoleSource()` / `SDK_SUPPORT_SOURCE` with `guest()` functions in their respective plugin files; delete the hand-authored IIFE strings.
6. **Remove `virtual:sandbox-polyfills`**: delete the virtual-module import in `runtime/src/sandbox-store.ts`, delete `webPlatformConfig` wiring, delete `virtual.d.ts` declarations in runtime and WPT harness, remove `sandboxPolyfills()` registration from `runtime/vite.config.ts`, `vitest.config.ts`, and `sandbox-stdlib/test/wpt/vitest.config.ts`.
7. **Rewrite tests**: delete string-assertion tests in `console.test.ts` and `sdk-support.test.ts`; add Strategy A / B helpers; add vite-transform tests covering `guestSource` emission, `workerSource`-only plugins, and tree-shake separation.
8. **Update `SECURITY.md` §2 wording** to reference `PluginDescriptor.workerSource` / `guestSource` and drop references to `virtual:sandbox-polyfills` and `PluginSetup.source`.
9. **Update specs** per the delta files in `specs/sandbox-plugin/spec.md`, `specs/sandbox-stdlib/spec.md`, `specs/sandbox/spec.md`.
10. **Validate**: `pnpm validate` (lint, format, type, test); confirm `pnpm test:wpt` passes unchanged.

Rollback: `git revert` the PR. No state migration means rollback is byte-reversible. No tenant re-upload required because bundle format is unchanged.

## Open Questions

None remaining after the exploration phase. All four design threads (rollup tree-shake, guest arguments, type-env collision, testing seam) were resolved with spikes or explicit decisions.
