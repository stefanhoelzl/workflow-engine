## Context

The sandbox plugin that installs the locked `__sdk.dispatchAction` host bridge — currently named `sdk-support` — lives in `packages/sdk/src/sdk-support/index.ts`. It is consumed *only* by `packages/runtime/src/sandbox-store.ts:23` via the vite `?sandbox-plugin` transform; nothing else imports the file or the `@workflow-engine/sdk/sdk-support` subpath export.

Because the file lives inside the SDK package, the SDK declares `@workflow-engine/sandbox` as a runtime dependency (it imports `Guest`, `GuestSafeError`, and the plugin types) and as a TypeScript project reference. Workflow author code never touches any of this. The dependency is an artifact of file layout.

Sibling runtime plugins — `host-call-action.ts`, `secrets.ts`, `trigger.ts`, `wasi-telemetry.ts` — are flat files under `packages/runtime/src/plugins/`. The sdk-support plugin's only declared peer dependency is `host-call-action` (via `dependsOn: ["host-call-action"]`), which is one of those runtime plugins.

The plugin's name string `"sdk-support"` is referenced by 27 occurrences across 6 live spec files, plus several non-spec comments and `openspec/project.md`.

## Goals / Non-Goals

**Goals**

- Eliminate `@workflow-engine/sandbox` from `@workflow-engine/sdk`'s runtime dependencies and TypeScript project references.
- Place the plugin alongside its peer plugins in the runtime package, matching the existing flat-file convention.
- Rename the plugin from `sdk-support` to `action-dispatch` so the name reflects its host-side role rather than its (former) package home, and pairs naturally with the `host-call-action` validator plugin it depends on.
- Preserve byte-identical guest-visible behavior: same descriptor name (`__sdkDispatchAction`), same locked global (`__sdk.dispatchAction`), same descriptor signature, same error translation, same dependsOn topology.

**Non-Goals**

- Renaming the guest-facing surface (`__sdk.dispatchAction`, `__sdkDispatchAction` private descriptor). These are the SDK↔runtime ABI baked into emitted tenant bundles; renaming them would force every tenant tarball to be rebuilt and is out of scope.
- Merging `action-dispatch` and `host-call-action` into a single plugin. The current split (validator plugin exports `validateAction`/`validateActionOutput`; dispatcher plugin consumes them via `dependsOn`) is intentional and unchanged.
- Restructuring how plugins are loaded by `sandbox-store.ts`, the `?sandbox-plugin` vite transform, or the boot phase sequence.
- Updating the SDK's `action()` factory implementation, the workflow-build vite plugin, or any owner-facing emit format.
- Introducing a new spec capability. The plugin's behavioral requirements remain in their current spec homes; only the spec text that names it is updated, and the two requirements whose title names the SDK explicitly are migrated to `actions/spec.md` where they coherently sit alongside `host-call-action plugin module`.

## Decisions

### D1. Move target: `packages/runtime/src/plugins/action-dispatch.ts` (flat file)

The runtime plugin directory uses flat single-file plugins (`host-call-action.ts`, `secrets.ts`, `trigger.ts`, `wasi-telemetry.ts`). The current `packages/sdk/src/sdk-support/` directory exists only because the SDK side had no other plugins to share a folder with.

**Alternatives considered:**
- *Subdirectory* (`packages/runtime/src/plugins/action-dispatch/index.ts`): inconsistent with sibling plugins, no benefit.
- *New shared package* (`@workflow-engine/sdk-support` or `@workflow-engine/action-dispatch`): adds a package boundary for one file with one consumer; the plugin's only peer is in the runtime, so no boundary is justified.
- *Move into `@workflow-engine/sandbox` or `sandbox-stdlib`*: the dispatcher couples to runtime concerns (manifest JSON Schemas via `host-call-action`), not generic platform primitives. Wrong altitude.

### D2. Rename: `sdk-support` → `action-dispatch`

Once the file leaves the SDK package, the name `sdk-support` becomes misleading. The plugin's role is to host-side dispatch action invocations from guest to host, validate I/O via `host-call-action`, and propagate errors. `action-dispatch` describes that directly and pairs grammatically with the existing `host-call-action` validator plugin.

The rename touches the plugin's `name` field, the test export `SDK_SUPPORT_PLUGIN_NAME` → `ACTION_DISPATCH_PLUGIN_NAME`, and 27 occurrences of the string `sdk-support` across spec text and comments. It does NOT touch the guest-visible surface (`__sdk`, `__sdkDispatchAction`).

**Alternatives considered:**
- *Keep `sdk-support`*: avoids 27 spec-text substitutions, but leaves a naming inconsistency in `runtime/plugins/` that compounds over time. Saved as a recurring "what does this name mean again?" cost.
- *Rename to `action-bridge`*: "bridge" is already overloaded in the sandbox lexicon (the bridge-closure rule, `__*` raw bridges, the host-bridge worker thread). Avoid.
- *Rename to `sdk-bridge`*: keeps SDK association after the SDK association is the thing we're cutting. Wrong direction.

### D3. Two requirements migrate `sdk/spec.md` → `actions/spec.md`

Two requirements in `openspec/specs/sdk/spec.md` have the SDK package's role baked into their *titles* and *bodies*, not just stray name references:

1. `SDK exposes the sdk-support plugin module` (L353)
2. `sdk-support plugin shape` (L390)

After the move, these requirements are factually about the runtime, not the SDK. They are removed from `sdk/spec.md` and added to `actions/spec.md` rephrased for the new home and renamed (`Runtime hosts the action-dispatch plugin module`, `action-dispatch plugin shape`). `actions/spec.md` is the natural home — it already contains `host-call-action plugin module` (L84) and the dispatch-related requirements.

The other affected requirements (e.g. `action factory returns typed callable` in `sdk/spec.md`, `Action output validated at the host-side bridge handler` in `payload-validation/spec.md`) stay in their current spec files; only their bodies are updated to use the new plugin name.

**Alternatives considered:**
- *Keep both requirements in `sdk/spec.md`, just MODIFY*: produces incoherent specs ("the SDK package's `sdk/` capability requires that the runtime hosts a plugin"). Spec hygiene loss.
- *Move all sdk-support-mentioning requirements to `actions/spec.md`*: too aggressive — many of them are genuinely about the SDK contract from the author's perspective and only mention the dispatcher in passing.

### D4. Drop `./sdk-support` subpath export and `@workflow-engine/sandbox` dep from SDK

`packages/sdk/package.json` currently declares:
- `dependencies."@workflow-engine/sandbox": "workspace:*"` — only used by the moved file.
- `exports."./sdk-support": "./src/sdk-support/index.ts"` — no consumer imports this entry point. The runtime imports the raw source path via the vite transform.

Both are removed. `packages/sdk/tsconfig.json` `references` similarly drops `{ "path": "../sandbox" }`.

This is the structural payoff of the move: the SDK's dependency surface shrinks to `core` only (plus its own runtime deps like Zod, citty, magic-string, vite, tsx, tar-stream, ts-cron-validator).

### D5. Guest-visible surface unchanged

The internal constant `SDK_DISPATCH_DESCRIPTOR = "__sdkDispatchAction"` keeps its string value. The `__sdk.dispatchAction` locked global keeps its name. The plugin's descriptor `args: [Guest.string(), Guest.raw(), Guest.callable()]` is unchanged. Tenant bundles do not need to be rebuilt.

This asymmetry — host plugin renamed, guest surface preserved — is deliberate: the plugin name is a host-side identifier with no semantic meaning to author code, while `__sdk.*` is a versioned ABI shipped in compiled tenant bundles.

## Risks / Trade-offs

- **Risk**: A spec text update misses an occurrence, leaving `sdk-support` in spec prose alongside `action-dispatch`. → **Mitigation**: `tasks.md` enumerates per-file substitution counts (`actions: 5`, `payload-validation: 3`, `sdk: 16`, `workflow-registry: 1`, `triggers: 1`, `sandbox: 1`); the post-implementation grep `grep -rn sdk-support openspec/` MUST return only the change directory itself.

- **Risk**: A non-spec comment in code retains the old name and confuses future readers. → **Mitigation**: `tasks.md` lists every code site; final `grep -rn sdk-support packages/` MUST match nothing under `packages/` after the change.

- **Risk**: `openspec validate` rejects the deltas because of MODIFIED-vs-RENAMED-vs-REMOVE+ADD confusion. → **Mitigation**: the migrated requirements (D3) use REMOVED + ADDED pairs; in-body name updates use MODIFIED with full requirement content copied verbatim from the source spec.

- **Risk**: Cached tenant bundles emit calls into a missing plugin name. → **Non-risk**: tenant bundles emit calls to `__sdk.dispatchAction`, never to the plugin name string. Plugin name is a runtime-only identifier.

- **Trade-off**: The migration of two requirements to `actions/spec.md` is mildly disruptive to anyone reading `sdk/spec.md` familiar with the old layout. → Accepted: the new layout is more coherent and the migration is one-time cost.

- **Trade-off**: The rename produces ~27 spec-text deltas for zero behavior change, which adds review overhead for what is structurally a file-move. → Accepted: bundling rename + move avoids two trips through the spec workflow and the new name is the right name forever after.

## Migration Plan

No data, schema, or runtime migration is required. Tenant bundles continue to work without rebuild. There is no rollback hazard beyond reverting the change commit.

Verification path after implementation:
1. `pnpm validate` (lint + typecheck + tests + tofu fmt/validate).
2. `grep -rn "sdk-support" packages/ openspec/specs/ openspec/project.md` returns no matches outside the change directory.
3. `pnpm dev --random-port --kill` boots; the demo workflow's `runDemo` orchestrator fires through an httpTrigger and the resulting `action.request` / `action.response` events appear in `.persistence/`.
4. `pnpm test` exercises the migrated `action-dispatch.test.ts` (formerly `sdk-support.test.ts`).
5. `openspec validate move-sdk-support-to-runtime --strict` passes.
