## Why

The `@workflow-engine/sdk` package depends on `@workflow-engine/sandbox` solely because of one runtime-side plugin (`packages/sdk/src/sdk-support/`) that lives inside the SDK source tree. Workflow author code never imports it — the runtime is the sole consumer, via the vite `?sandbox-plugin` transform. The dependency exists for purely accidental reasons of file location, and it muddies the SDK's role: the SDK is the authoring API, not a sandbox-host plugin host. Cleaning this up shrinks the SDK's surface, removes its sandbox dependency entirely, and aligns the plugin with the other runtime plugins it sits next to in the boot list.

We also rename the plugin from `sdk-support` to `action-dispatch`. The current name was chosen when the plugin lived in the SDK package; once the file moves, the name "sdk-support" is misleading — the plugin is host-side glue for action dispatch, not SDK support code. `action-dispatch` pairs naturally with the existing `host-call-action` validator plugin it depends on.

## What Changes

- Relocate `packages/sdk/src/sdk-support/index.ts` to `packages/runtime/src/plugins/action-dispatch.ts` and its test to `packages/runtime/src/plugins/action-dispatch.test.ts` (flat single-file shape matches sibling runtime plugins: `host-call-action.ts`, `secrets.ts`, `trigger.ts`, `wasi-telemetry.ts`).
- Rename the plugin's `name` field from `"sdk-support"` to `"action-dispatch"`. Update all spec text and code comments referencing the old name.
- Rename the test file's exported plugin-name constant `SDK_SUPPORT_PLUGIN_NAME` to `ACTION_DISPATCH_PLUGIN_NAME`.
- Update the runtime boot site `packages/runtime/src/sandbox-store.ts:23` to import from the new path: `./plugins/action-dispatch.ts?sandbox-plugin`.
- Drop `@workflow-engine/sandbox` from `packages/sdk/package.json` `dependencies`.
- Drop the `"./sdk-support": "./src/sdk-support/index.ts"` entry from `packages/sdk/package.json` `exports` (no consumer imports this entry point — runtime uses the raw `?sandbox-plugin` source path).
- Drop `{ "path": "../sandbox" }` from `packages/sdk/tsconfig.json` `references`.
- Update `openspec/project.md` lines that name the plugin and its package location.

The guest-facing surface (`__sdk.dispatchAction(...)`, the private `__sdkDispatchAction` descriptor name, and the SDK's emit format) is intentionally unchanged. This is the SDK↔runtime ABI baked into uploaded tenant tarballs; renaming it would force a rebuild and is a separate concern.

The plugin's behavior — input validation via `host-call-action.validateAction`, host-side output validation via `host-call-action.validateActionOutput`, error translation through `GuestSafeError`, descriptor shape `args: [Guest.string(), Guest.raw(), Guest.callable()]` — is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

The plugin name change requires text deltas in every spec that names `sdk-support`. No requirement semantics change — these are name-substitution deltas plus the location note (the plugin moved from the SDK package to the runtime package).

- `actions`: rename `sdk-support` → `action-dispatch` in references to the host-side action dispatcher plugin (5 occurrences).
- `payload-validation`: rename `sdk-support` → `action-dispatch` in the dispatcher-handler requirements for action input/output validation (3 occurrences).
- `sdk`: rename `sdk-support` → `action-dispatch` and update the plugin's package location from `@workflow-engine/sdk` to `@workflow-engine/runtime` (16 occurrences).
- `workflow-registry`: rename `sdk-support` → `action-dispatch` (1 occurrence).
- `triggers`: rename `sdk-support` → `action-dispatch` (1 occurrence).
- `sandbox`: rename `sdk-support` → `action-dispatch` (1 occurrence).

## Impact

- **Code**:
  - Move `packages/sdk/src/sdk-support/{index.ts,sdk-support.test.ts}` → `packages/runtime/src/plugins/{action-dispatch.ts,action-dispatch.test.ts}`.
  - Update `packages/runtime/src/sandbox-store.ts:23` import path.
  - Update plugin name string and test export symbol.
  - Update non-spec comments referencing `sdk-support` in `packages/runtime/src/{globals-surface.test.ts,security-invariants.test.ts,sandbox-store.test.ts}`, `packages/runtime/src/plugins/host-call-action.ts`, `packages/sandbox-stdlib/test/wpt/harness/runner.ts`, `packages/sandbox/src/{sandbox.test.ts,test-harness.ts}`, `packages/sdk/src/index.ts`.

- **Package boundaries**:
  - `packages/sdk/package.json`: remove `@workflow-engine/sandbox` from `dependencies` and `"./sdk-support"` from `exports`.
  - `packages/sdk/tsconfig.json`: remove the `../sandbox` project reference.

- **Spec text**: 27 occurrences of `sdk-support` across 6 live spec files become `action-dispatch`; package-location prose in `openspec/specs/sdk/spec.md` updates from "in SDK package" to "in runtime package".

- **Project doc**: `openspec/project.md` lines 29, 84, 124, 133, 135 update plugin name and the monorepo-structure note (`packages/sdk/` no longer hosts the plugin; `packages/runtime/` does).

- **Sandbox boundary**: no change. Guest-visible globals (`__sdk.dispatchAction`, `__sdkDispatchAction` descriptor) keep their names. Plugin descriptor shape, dependsOn topology, and error-translation behavior are byte-identical.

- **APIs**: no public API change. Workflow author code is unaffected (no recompile or re-upload required). Tenant tarballs do not need rebuilding.

- **Dependencies**: `@workflow-engine/sdk` no longer depends on `@workflow-engine/sandbox` (build-time or install-time).

- **Tests**: existing `sdk-support.test.ts` moves with the source; assertions on the plugin name string update to `"action-dispatch"`. No new tests required.

- **Upgrade notes**: none. No tenant rebuild required (`docs/upgrades.md` unchanged).
