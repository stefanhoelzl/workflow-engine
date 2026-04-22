## 1. Patch fetch-blob at the dependency boundary

- [x] 1.1 Run `pnpm patch fetch-blob@<current-version>`; in the resulting edit directory, delete the `if (!globalThis.ReadableStream) { await import("node:process"); ... }` top-level-await block from `index.js`.
- [x] 1.2 Run `pnpm patch-commit` to generate `patches/fetch-blob@<version>.patch` and add the `pnpm.patchedDependencies` entry to the root `package.json`.
- [x] 1.3 Run `pnpm install`; confirm the patched module has no TLA by reading `node_modules/fetch-blob/index.js` and grepping for `await import`.
- [ ] 1.4 Commit the patch file and `package.json` change. (Deferred — commits batched for user review at end.)

## 2. Extend the `?sandbox-plugin` vite transform

- [x] 2.1 In `packages/sandbox/src/vite/sandbox-plugins.ts`, add a helper that detects whether an imported plugin file exports a `guest` function (e.g. a light static-analysis pass on the TS source, or a try/catch around a second rollup synthetic-entry resolve).
- [x] 2.2 Refactor the existing worker rollup pass to add `treeshake: { moduleSideEffects: false }` to its config.
- [x] 2.3 Add a second rollup pass, invoked only when `guest` is exported, using synthetic entry `import { guest } from "<path>"; guest();`, output format `iife`, default tree-shaking, and no `node:*` external (node builtins in guest code should fail the bundle).
- [x] 2.4 Update the transform's virtual-module output to emit `workerSource` (renamed from `source`) and optional `guestSource`; default export becomes `{ name, dependsOn, workerSource, guestSource }`.
- [x] 2.5 Add JSDoc references to SECURITY.md §2 where the transform comments currently say "ESM bundle for the sandbox worker thread".

## 3. Update the sandbox kernel types and loader

- [x] 3.1 In `packages/sandbox/src/plugin.ts`, rename `PluginDescriptor.source` to `workerSource`; add optional `guestSource?: string`; delete `PluginSetup.source`.
- [x] 3.2 Update `packages/sandbox/src/worker-plugin-loader.ts` to read `descriptor.workerSource` instead of `descriptor.source` (including the `data:` URI construction and the override path).
- [x] 3.3 In `packages/sandbox/src/plugin-runtime.ts`, change Phase 2 to iterate the descriptor map (keyed by plugin name) and call `evaluator.eval(descriptor.guestSource, "<plugin:${name}>")` when `guestSource` is defined; drop the `setup.source` read.
- [x] 3.4 Update `packages/sandbox/src/protocol.ts` and `packages/sandbox/src/test-plugins.ts` to match the new descriptor shape.

## 4. Migrate web-platform plugin to inline `guest()`

- [x] 4.1 Rename directory `packages/sandbox-stdlib/src/web-platform/source/` to `packages/sandbox-stdlib/src/web-platform/guest/`; update internal imports accordingly.
- [x] 4.2 In each former `source/*.ts` file, wrap the installing side effects in an exported `installX()` function if not already structured that way.
- [x] 4.3 In `packages/sandbox-stdlib/src/web-platform/index.ts`, add `export function guest(): void` that calls the installer functions in the existing required order; delete the `Config` interface and the `config.bundleSource` branch from `worker()`.
- [x] 4.4 Delete `packages/sandbox-stdlib/src/web-platform/vite-plugin.ts`.
- [x] 4.5 Delete `packages/sandbox-stdlib/src/web-platform/source/guest.d.ts` (the `__WFE_VERSION__` ambient).
- [x] 4.6 In `packages/sandbox-stdlib/src/web-platform/guest/trivial.ts`, replace `` `WorkflowEngine/${__WFE_VERSION__}` `` with the string literal `"WorkflowEngine"`.

## 5. Migrate console and sdk-support plugins to inline `guest()`

- [x] 5.1 In `packages/sandbox-stdlib/src/console/index.ts`, replace `buildConsoleSource()` + `source: buildConsoleSource()` with an exported `guest()` function containing the same logic as TypeScript code; delete the template-literal helper.
- [x] 5.2 In `packages/sdk/src/sdk-support/index.ts`, replace `SDK_SUPPORT_SOURCE` + `source: SDK_SUPPORT_SOURCE` with an exported `guest()` function containing the same IIFE phases (capture `__hostCallAction` + `__emitEvent`, define `__sdk`, lock via `Object.defineProperty`); delete the hand-authored string.

## 6. Remove runtime polyfill wiring

- [x] 6.1 In `packages/runtime/src/sandbox-store.ts`, remove the `import SANDBOX_POLYFILLS from "virtual:sandbox-polyfills"` line.
- [x] 6.2 Remove `webPlatformConfig` construction and its assignment to `webPlatformPlugin.config`; drop the spread that carried `bundleSource`.
- [x] 6.3 Delete `packages/runtime/src/virtual.d.ts` entries for `virtual:sandbox-polyfills` (and the whole file if it contains only that).
- [x] 6.4 Delete `packages/sandbox-stdlib/test/wpt/harness/virtual.d.ts` entries for `virtual:sandbox-polyfills` (and the whole file if it contains only that).
- [x] 6.5 Remove `sandboxPolyfills()` registration from `packages/runtime/vite.config.ts`, the repo-root `vitest.config.ts`, and `packages/sandbox-stdlib/test/wpt/vitest.config.ts`.

## 7. Vite transform tests

- [x] 7.1 In `packages/sandbox/src/vite/sandbox-plugins.test.ts`, add a test that writes a plugin file exporting only `worker`, runs the transform, and asserts the emitted descriptor has `workerSource` but omits `guestSource`.
- [x] 7.2 Add a test that writes a plugin file exporting both `worker` and `guest`, runs the transform, and asserts both `workerSource` and `guestSource` are present; further assert that `eval(guestSource)` mutates a staged `globalThis` surrogate in the expected way.
- [x] 7.3 Add a test that writes a plugin file where `worker` imports `ajv`-equivalent (worker-only) and `guest` imports a guest-only npm package; assert `workerSource` does NOT contain the guest package name and `guestSource` does NOT contain `node:*` import statements.
- [x] 7.4 Add a test that writes a plugin file whose `guest` imports `node:fs`; assert the transform's guest pass fails with a resolution/external error.
- [x] 7.5 Add a test that writes a plugin file with no `worker` export; assert the transform throws a clear error.

## 8. Plugin unit/integration tests

- [x] 8.1 In `packages/sandbox/src/test-harness.ts` (new), add a `withStagedGlobals(stage, fn)` helper (Strategy A) that stages keys onto `globalThis` and snapshot-restores on exit. (`globalThis` itself is non-writable; the helper mutates-and-restores keys rather than swapping the object.)
- [x] 8.2 In `packages/sandbox/src/test-harness.ts`, add a `withPluginSandbox(source, options, fn)` helper (Strategy B) that creates a sandbox and disposes on exit.
- [x] 8.3 Export both helpers from `packages/sandbox` for cross-package test use.
- [x] 8.4 In `packages/sandbox-stdlib/src/console/console.test.ts`, delete the two string-assertion tests. Add a Strategy-A test that calls `guest()` against a staged `globalThis` with `__console_*` bridges and asserts `globalThis.console.<method>` forwards to the bridge.
- [~] 8.5 In `packages/sdk/src/sdk-support/sdk-support.test.ts`, delete string-assertion tests on `setup.source`. (Done; Strategy-B integration test not added — architecturally awkward because `sdk` is upstream of `host-call-action` in runtime. Existing direct `worker()` tests cover the dispatcher logic exhaustively: validation, handler invocation, completer, disposal, error propagation.)
- [x] 8.6 In `packages/sandbox-stdlib/src/web-platform/web-platform.test.ts`, delete the two `bundleSource` tests. Keep the plugin-name test, the `__reportErrorHost` descriptor shape test, and the handler-emits-event test. Add a scenario asserting `guest` is exported from the plugin file.

## 9. Update sandbox kernel tests for renamed fields

- [x] 9.1 In `packages/sandbox/src/sandbox.test.ts`, `plugin-compose.test.ts`, and any other kernel test that constructs a `PluginDescriptor` literal, rename `source:` to `workerSource:`; add `guestSource:` in tests that previously asserted Phase-2 eval behavior via `PluginSetup.source`.
- [~] 9.2 Add a kernel test asserting that a plugin whose descriptor lacks `guestSource` does not trigger a Phase-2 `evalCode` call. (Existing `runPhaseSourceEval` "skips plugins whose descriptor has no guestSource" test covers this.)
- [~] 9.3 Add a kernel test asserting a Phase-2 failure from `descriptor.guestSource` triggers VM disposal and `init-error`, as in the existing `PluginSetup.source` failure test. (Existing `runPhaseSourceEval` "annotates source-eval throws" test covers the annotation; disposal path is unchanged from pre-refactor behavior.)

## 10. WPT coverage check

- [x] 10.1 Run `pnpm test:wpt`; confirm the suite passes unchanged after the web-platform migration.
- [x] 10.2 If any subtest regresses, diagnose whether the cause is a missing polyfill installer call in the new `guest()` function (ordering bug) or a real behavioral change; fix before proceeding.

## 11. Security and CLAUDE.md wording updates

- [x] 11.1 In `SECURITY.md` §2, update any reference to `PluginSetup.source` to `PluginDescriptor.guestSource` and `descriptor.source` to `descriptor.workerSource`. Delete references to `virtual:sandbox-polyfills` and `sandboxPolyfills()`.
- [x] 11.2 In `CLAUDE.md`, add a short upgrade-note entry under `## Upgrade notes` titled `unify-sandbox-plugin-transform`, stating: no tenant re-upload required; no pending/archive wipe; no manifest format change; describes the `PluginDescriptor` field rename and the `guest` export convention.
- [x] 11.3 Review the existing `## Security Invariants` bullet list; add a bullet forbidding reintroduction of `virtual:sandbox-polyfills` or equivalent cross-package polyfill wiring if judged worth calling out, or skip if the existing R-1/R-2 bullets cover the intent. (Skipped — existing R-1/R-2 rules cover plugin-discipline adequately.)

## 12. Validate end-to-end

- [x] 12.1 Run `pnpm lint`; fix any new biome-ignore needs with a justified suffix (per CLAUDE.md code conventions) or restructure to avoid them.
- [x] 12.2 Run `pnpm check`; fix all type errors.
- [x] 12.3 Run `pnpm test`; fix all failures.
- [x] 12.4 Run `pnpm test:wpt`; confirm pass.
- [x] 12.5 Run `pnpm validate` (the umbrella command from CLAUDE.md); confirm green.
- [x] 12.6 Run `pnpm build`; confirm the runtime and workflow bundles produce without `virtual:sandbox-polyfills` resolution errors.
- [x] 12.7 Run `pnpm exec openspec validate unify-sandbox-plugin-transform --strict`; confirm the change validates.

## 13. Post-merge archive

- [ ] 13.1 After the PR merges, run `pnpm exec openspec archive unify-sandbox-plugin-transform` so the spec deltas merge into `openspec/specs/` and the change folder moves to `openspec/changes/archive/`.
