## 1. Move plugin source into runtime

- [x] 1.1 Move `packages/sdk/src/sdk-support/index.ts` to `packages/runtime/src/plugins/action-dispatch.ts` (git mv).
- [x] 1.2 Move `packages/sdk/src/sdk-support/sdk-support.test.ts` to `packages/runtime/src/plugins/action-dispatch.test.ts` (git mv).
- [x] 1.3 Delete the now-empty `packages/sdk/src/sdk-support/` directory.
- [x] 1.4 In `packages/runtime/src/plugins/action-dispatch.ts`, change the plugin's `name` constant from `"sdk-support"` to `"action-dispatch"`. Leave `SDK_DISPATCH_DESCRIPTOR = "__sdkDispatchAction"` and the `__sdk` global installation unchanged (guest ABI preserved per design.md D5).
- [x] 1.5 In `packages/runtime/src/plugins/action-dispatch.ts`, update internal comment headers and prose that refer to the plugin as `sdk-support` to use `action-dispatch`. The string `__sdkDispatchAction` MUST remain unchanged.
- [x] 1.6 In `packages/runtime/src/plugins/action-dispatch.test.ts`, rename the exported constant `SDK_SUPPORT_PLUGIN_NAME` to `ACTION_DISPATCH_PLUGIN_NAME`, update the assertion `expect(ACTION_DISPATCH_PLUGIN_NAME).toBe("action-dispatch")`, update the `describe(...)` text from `"sdk-support plugin (§10 shape)"` to `"action-dispatch plugin (§10 shape)"`, and update other internal references.
- [x] 1.7 In `packages/runtime/src/sandbox-store.ts:23`, change the import path from `"../../sdk/src/sdk-support/index.ts?sandbox-plugin"` to `"./plugins/action-dispatch.ts?sandbox-plugin"` and rename the imported binding from `sdkSupportPlugin` to `actionDispatchPlugin` (also at the registration call site).

## 2. Drop SDK→sandbox dependency

- [x] 2.1 In `packages/sdk/package.json`, remove `"@workflow-engine/sandbox": "workspace:*"` from `dependencies`.
- [x] 2.2 In `packages/sdk/package.json`, remove the `"./sdk-support": "./src/sdk-support/index.ts"` entry from `exports`.
- [x] 2.3 In `packages/sdk/tsconfig.json`, remove `{ "path": "../sandbox" }` from the `references` array.
- [x] 2.4 Run `pnpm install` to update the lockfile.

## 3. Update non-spec code references

- [x] 3.1 In `packages/sdk/src/index.ts:17,266-267`, update the comments that refer to "sdk-support plugin" to "action-dispatch plugin".
- [x] 3.2 In `packages/sdk/src/index.test.ts:519`, update the comment `// sdk-support plugin)` to `// action-dispatch plugin)` (assertion string identity unchanged).
- [x] 3.3 In `packages/runtime/src/plugins/host-call-action.ts:11,95`, update the comment references to `sdk-support` to `action-dispatch`.
- [x] 3.4 In `packages/runtime/src/globals-surface.test.ts:97`, update the comment `// `sdk-support` plugin (packages/sdk/src/sdk-support/index.ts):` to `// `action-dispatch` plugin (packages/runtime/src/plugins/action-dispatch.ts):`.
- [x] 3.5 In `packages/runtime/src/security-invariants.test.ts:90`, update `//   - `__sdkDispatchAction` (sdk-support)` to `//   - `__sdkDispatchAction` (action-dispatch)`.
- [x] 3.6 In `packages/runtime/src/sandbox-store.test.ts:58`, update the comment `// the sdk-support plugin installs `__sdk` …` to use `action-dispatch`.
- [x] 3.7 In `packages/sandbox/src/test-harness.ts:14`, update the comment `// multi-plugin integration cases (e.g. `sdk-support` captures bridges` to use `action-dispatch`.
- [x] 3.8 In `packages/sandbox/src/sandbox.test.ts:148`, update the comment `// production, the sdk-support plugin auto-deletes …` to use `action-dispatch`.
- [x] 3.9 In `packages/sandbox-stdlib/test/wpt/harness/runner.ts:212`, update the comment `// runtime-only plugins (host-call-action, sdk-support, trigger) are` to use `action-dispatch`.

## 4. Apply spec-text deltas in live specs

- [x] 4.1 In `openspec/specs/actions/spec.md`, apply the MODIFIED requirement for "host-call-action plugin depends on none" from `openspec/changes/move-sdk-support-to-runtime/specs/actions/spec.md` and add the two ADDED requirements ("Runtime hosts the action-dispatch plugin module", "action-dispatch plugin shape").
- [x] 4.2 In `openspec/specs/payload-validation/spec.md`, apply the MODIFIED requirement for "Action output validated at the host-side bridge handler" (3 in-body substitutions of `sdk-support` → `action-dispatch`).
- [x] 4.3 In `openspec/specs/sdk/spec.md`, REMOVE the requirements "SDK exposes the sdk-support plugin module" and "sdk-support plugin shape"; apply the MODIFIED requirements "SDK provides subpath exports", "action factory returns typed callable", "action() SDK export is a passthrough", and "No runtime-appended dispatcher source".
- [x] 4.4 In `openspec/specs/workflow-registry/spec.md`, apply the MODIFIED requirement "Workflow loading instantiates one sandbox per `(tenant, sha)`" (1 in-body substitution).
- [x] 4.5 In `openspec/specs/triggers/spec.md`, apply the MODIFIED requirement "Reserved `trigger.` event-kind prefix" (1 in-scenario substitution at the plugin-source-list line).
- [x] 4.6 In `openspec/specs/sandbox/spec.md`, apply the MODIFIED requirement "Isolation — no Node.js surface" (1 in-body substitution + the `runtime/sdk plugins` → `runtime plugins` phrasing change).

## 5. Update project.md

- [x] 5.1 In `openspec/project.md` line 29, update `…through the sdk-support plugin, which routes…` to `…through the action-dispatch plugin, which routes…`.
- [x] 5.2 In `openspec/project.md` line 69, leave `__sdkDispatchAction` unchanged (guest ABI) but update any surrounding plugin-name reference.
- [x] 5.3 In `openspec/project.md` line 84, update `__sdk.dispatchAction(name, input, handler)` reference text — the global itself is unchanged; rename plugin reference from `sdk-support` to `action-dispatch`.
- [x] 5.4 In `openspec/project.md` line 124, update `# @workflow-engine/sdk (authoring API + vite plugin + sdk-support plugin)` to `# @workflow-engine/sdk (authoring API + vite plugin)`.
- [x] 5.5 In `openspec/project.md` line 133, update the SDK monorepo-structure note: remove the clause about `sdk-support plugin (in SDK package)` — describe `__sdk` as installed by the runtime's action-dispatch plugin.
- [x] 5.6 In `openspec/project.md` line 135, update `runtime/sdk plugins (trigger, host-call-action, sdk-support, wasi-telemetry)` to `runtime plugins (trigger, host-call-action, action-dispatch, wasi-telemetry)`.

## 6. Verify zero residue

- [x] 6.1 Run `grep -rn "sdk-support" packages/`. Result MUST be empty.
- [x] 6.2 Run `grep -rn "sdk-support" openspec/specs/ openspec/project.md`. Result MUST be empty (the change directory under `openspec/changes/move-sdk-support-to-runtime/` is allowed to retain the old name in REMOVED-requirement headings and migration text).
- [x] 6.3 Run `grep -rn "@workflow-engine/sandbox" packages/sdk/`. Result MUST be empty.
- [x] 6.4 Run `find packages/sdk/src/sdk-support -type f 2>/dev/null`. Result MUST be empty (directory removed).

## 7. Validate

- [x] 7.1 `pnpm exec openspec validate move-sdk-support-to-runtime --strict` passes.
- [x] 7.2 `pnpm lint` passes.
- [x] 7.3 `pnpm check` passes (TypeScript). Confirms the SDK builds without `@workflow-engine/sandbox` and the runtime plugin file resolves at its new path.
- [x] 7.4 `pnpm test` passes; specifically `packages/runtime/src/plugins/action-dispatch.test.ts` runs at the new location and asserts plugin name `"action-dispatch"`.
- [x] 7.5 `pnpm validate` passes end-to-end.

## 8. Dev-server smoke

- [x] 8.1 Start `pnpm dev --random-port --kill` in the background; wait for `[READY] Dev server listening on http://localhost:<port>` and parse the port.
- [x] 8.2 Trigger `runDemo` via the demo workflow's `httpTrigger` (canonical recipe in `docs/dev-probes.md`); confirm a 2xx response.
- [x] 8.3 Confirm the resulting events under `.persistence/` include the expected `action.request` / `action.response` frames for the action exercised by `runDemo` (proves the renamed plugin still dispatches and `host-call-action` still validates).
- [x] 8.4 Confirm an intentional output-validation failure (via the `fail` manualTrigger → `boom` action path in `workflows/src/demo.ts`) still produces an `action.error` frame with the validator's `issues` payload propagated through `GuestSafeError`.
- [x] 8.5 Kill the dev-server process tree.
