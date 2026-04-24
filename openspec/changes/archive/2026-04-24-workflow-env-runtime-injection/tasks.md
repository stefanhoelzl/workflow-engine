## 1. Core: workflow-runtime module

- [x] 1.1 Create `packages/core/src/workflow-runtime.ts` exporting `RuntimeWorkflow<Env>`, `RuntimeSecrets`, `GuestGlobals`, `installGuestGlobals`, and the `declare global` augmentation for `workflow` and `$secrets`.
- [x] 1.2 Add re-exports from `packages/core/src/index.ts` so consumers can import `{ RuntimeWorkflow, RuntimeSecrets, GuestGlobals, installGuestGlobals }` from `@workflow-engine/core`.
- [x] 1.3 Write unit tests: `installGuestGlobals` installs locked non-configurable properties; second install of the same key throws; partial argument works.
- [x] 1.4 Verify `declare global` augmentation propagates: a consumer package imports core and `globalThis.workflow` / `globalThis.$secrets` type correctly without `any` casts.

## 2. Sandbox: PluginSetup.onPost hook

- [x] 2.1 Add optional `onPost?: (msg: WorkerToMain, ctx: RunContext) => WorkerToMain` to the `PluginSetup` type in `packages/sandbox/src/plugin.ts`.
- [x] 2.2 Modify `post()` in `packages/sandbox/src/worker.ts` to iterate registered plugins in topological order and invoke each plugin's `onPost` (if defined) against the outbound message before actually posting.
- [x] 2.3 Decide and document whether `onPost` applies to `init-error` and `ready` messages; implement consistently (recommended: applies to every `WorkerToMain` message).
- [x] 2.4 Add unit tests: plugin with `onPost` transforming the message sees the transform reflected in what main receives; plugin without `onPost` is skipped; multiple plugins compose in topo order; the return value chains through hooks.
- [x] 2.5 Add a sandbox boundary test: `onPost` plugin cannot observe messages from before its hook registration (sanity check against stashed state).

## 3. SDK: defineWorkflow runtime-read refactor

- [x] 3.1 Update `packages/sdk/src/index.ts`: change `Workflow<Env>` to extend `RuntimeWorkflow<Env>` from core; brand symbol becomes the only SDK-specific property.
- [x] 3.2 Rewrite the guest-side path of `defineWorkflow`: when `globalThis.workflow` is installed, read it and return; when absent, fall back to resolving `config.env` against `process.env` (build-time Node-VM discovery path).
- [x] 3.3 Keep `resolveEnvRecord` and `getDefaultEnvSource` callable from the build-time discovery fallback in `defineWorkflow`; no separate Vite plugin pre-population needed (the fallback covers it).
- [x] 3.4 Plugin path continues to read `workflow.env` off the Node-VM context's IIFE exports; fallback resolution in `defineWorkflow` produces the correct env. Simpler than pre-populating `globalThis.workflow` in the Vite plugin.
- [x] 3.5 Remove `Object.freeze` on `workflow.env` (env is mutated by env-installer at runtime; `workflow` itself stays frozen).
- [x] 3.6 Unit tests: updated existing tests to reflect new `name: ""` default (was `undefined`); build-time env resolution still works via the fallback path.

## 4. Runtime: env-installer plugin

- [x] 4.1 Create `packages/runtime/src/plugins/env-installer.ts` exporting `name` + `worker(ctx, deps, config)`. Simplified from the original design: env is stable per (tenant, sha), so installed once at sandbox init via `config: { name, env }`, not per-invocation. Per-run mutation + `$env/populate` / `$env/clear` guest functions deferred to workflow-secrets.
- [x] 4.2 Guest-side source installs `globalThis.workflow = Object.freeze({ name, env: Object.freeze(envStrings) })` via locked `Object.defineProperty`. Inlined rather than importing `installGuestGlobals` because plugin sources are esbuild-bundled and cannot resolve bare imports at runtime in the guest VM.
- [x] 4.3 ~Worker-side `onBeforeRunStarted`~ not needed — env is install-once at Phase 2.
- [x] 4.4 ~Worker-side `onRunFinished`~ not needed — env is install-once at Phase 2.
- [x] 4.5 Add unit tests: source installs workflow global with correct name + env; empty env works; installed property is non-writable non-configurable.

## 5. Runtime: SandboxStore composition

- [x] 5.1 Update `packages/runtime/src/sandbox-store.ts` to include `envInstallerPlugin` in the production plugin catalog, placed between `wasiTelemetry` and `webPlatform` so its Phase-2 source installs `globalThis.workflow` before the tenant's IIFE evaluates. Plugin config is `{ name: workflow.name, env: workflow.env }` from the manifest.
- [x] 5.2 No `run` message ctx change — env is install-once via plugin config, not per-run.
- [x] 5.3 Metadata-stamping `onEvent` callback unchanged; env-installer plugin has no `onEvent` interaction.
- [x] 5.4 Integration test covered by existing sandbox-store end-to-end tests (all passing); manual E2E with a real workflow will run in task 7.4.

## 6. Documentation + SECURITY.md

- [x] 6.1 Add SECURITY.md R-11: `PluginSetup.onPost` requires a documented cross-cutting rationale per implementer.
- [x] 6.2 Add upgrade note: env-gap fix behavior change documented in CLAUDE.md.
- [x] 6.3 No in-repo workflow docs or tutorials reference the old defaults-only behavior; nothing to update.

## 7. Verification

- [x] 7.1 `pnpm lint` clean (only info about WPT file size; no errors).
- [x] 7.2 `pnpm check` clean (tsc --build succeeds).
- [x] 7.3 `pnpm test` — 768/768 tests pass across 68 test files.
- [x] 7.4 `pnpm build` succeeds; the 463 runtime tests include end-to-end sandbox-store executions of real workflows with env reads.
- [x] 7.5 In-repo `cronitor.ts` / `heartbeat.ts` both pass all existing tests with the new plugin in the composition; they declare `default:` values that match the previous behavior.
