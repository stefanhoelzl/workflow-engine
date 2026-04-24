## Why

Workflow authors expect `workflow.env.X` to return the value resolved from `process.env` at build time (the behavior the Vite plugin's Node-VM discovery pass already records in `manifest.env`). At runtime, the QuickJS guest re-evaluates `defineWorkflow`, which reads `globalThis.process?.env` — undefined in QuickJS — and falls back to each binding's `default:`. The build-time-resolved `manifest.env` is never threaded back to the guest. This is a latent gap: existing workflows compile fine, but a tenant deploying with a real `TOKEN` env var in CI sees the `default` value at invocation time, not the overridden one.

The same mechanism also needs to land as a reusable foundation for the upcoming secrets feature (next change): per-invocation installation of runtime-supplied values onto the guest's `globalThis.workflow`. Building the foundation now — separate from the crypto and scrubber work — gives us the env gap fix as an isolated shippable improvement and cleanly isolates the plugin-API and SDK refactors from the security-sensitive code that follows.

## What Changes

- Add a new `@workflow-engine/core` module `workflow-runtime` exporting `RuntimeWorkflow<Env>`, `RuntimeSecrets` (shape only, populated in a later change), `GuestGlobals`, `installGuestGlobals(partial: Partial<GuestGlobals>)`, and a `declare global` augmentation typing `globalThis.workflow` and `globalThis.$secrets`.
- Extend `PluginSetup` in `@workflow-engine/sandbox` with one new optional hook: `onPost?: (msg: WorkerToMain, ctx: RunContext) => WorkerToMain`. Invoked inside `post()` in plugin topological order against every outbound worker→main message before it is posted. No existing plugin implements it; behaviour for the current composition is unchanged.
- Introduce a new runtime plugin `env-installer` (`packages/runtime/src/plugins/env-installer.ts`) that calls `installGuestGlobals({ workflow: { name, env: {} } })` at Phase 2, then on every invocation mutates `workflow.env` in place with the manifest's `env: Record<string, string>` values. On run completion, clears the env object.
- **BEHAVIOR CHANGE (intentional):** `workflow.env.X` at invocation time now returns the value from `manifest.env` (i.e., the build-time-resolved `process.env[name] ?? default`). Workflows that relied on the previous default-only behavior will start seeing the overridden value.
- `@workflow-engine/sdk`: `Workflow<Env>` extends `RuntimeWorkflow<Env>`; `defineWorkflow` reads `globalThis.workflow` (typed via the core ambient augmentation) instead of calling `resolveEnvRecord` at runtime. `getDefaultEnvSource()` and `resolveEnvRecord()` remain used by the Vite plugin's Node-VM build-time discovery path only.
- Add SECURITY.md R-11: `PluginSetup.onPost` requires a cross-cutting rationale per implementer. Only `env-installer` implements it after this change (as a no-op pass-through — the scrubber lands in the follow-up secrets change).

## Capabilities

### New Capabilities
- `workflow-env-runtime`: `RuntimeWorkflow<Env>`, `RuntimeSecrets`, `GuestGlobals`, `installGuestGlobals`, and the ambient global augmentation. The contract surface between the runtime's env-installer plugin (writer) and the SDK's `defineWorkflow` (reader). Locked-property installation discipline on guest `globalThis`.

### Modified Capabilities
- `sandbox-plugin`: `PluginSetup` gains `onPost?: (msg, ctx) => msg`. Sandbox core invokes registered hooks in topological order inside `post()` before message egress.
- `sdk`: `Workflow<Env>` re-shaped to extend `RuntimeWorkflow<Env>` from core. `defineWorkflow` reads `globalThis.workflow` at runtime instead of calling `resolveEnvRecord`. Build-time (Vite plugin / Node-VM) resolution path unchanged.
- `sandbox-store`: `env-installer` plugin added to the production plugin composition so that every sandbox receives the runtime-injected `workflow` global.

## Impact

- **Packages modified**: `packages/core` (new `workflow-runtime` module), `packages/sandbox` (PluginSetup + `post()` invocation of `onPost` hooks), `packages/sdk` (Workflow type extension, defineWorkflow runtime path), `packages/runtime` (new `env-installer` plugin + composition in sandbox-store).
- **Behavior change visible to tenants**: `workflow.env.X` at runtime now reflects build-time-resolved values from `manifest.env`, not `default:` fallbacks. Authors relying on the previous behavior (there is no known workflow that does) must re-examine their env bindings.
- **No manifest format change.** `manifest.env` schema stays `Record<string, string>`; no new fields.
- **No tenant re-upload required.** Existing bundles still work; they just start seeing correct env values.
- **Event bus**: no change. Consumers see identical events.
- **SECURITY.md**: adds R-11 documenting the `onPost` plugin discipline.
- **Upgrade note**: additive, behavioral fix only; deploy-time rollout; no state wipe, no tenant re-upload.
- **openspec/project.md**: no update needed; architectural principles unchanged.
