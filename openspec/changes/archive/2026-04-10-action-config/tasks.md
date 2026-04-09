## 1. SDK: env() helper and EnvRef

- [x] 1.1 Add `ENV_REF` Symbol, `EnvRef` type, and `env()` function with all four overload signatures to `packages/sdk/src/index.ts`
- [x] 1.2 Add `resolveEnvRecord` helper that walks a `Record<string, string | EnvRef>`, resolves markers from `process.env`, and returns `Record<string, string>`
- [x] 1.3 Add tests for `env()` marker creation (all overloads) and `resolveEnvRecord` (literals, env refs, defaults, missing vars, Symbol detection)

## 2. SDK: WorkflowBuilder env support

- [x] 2.1 Add `.env()` method to `WorkflowBuilder` interface and `WorkflowBuilderImpl` that accepts `Record<string, string | EnvRef>`, resolves eagerly, and stores as `Record<string, string>`
- [x] 2.2 Change action `env` field from `readonly string[]` to `Record<string, string | EnvRef>` in builder interface and impl; resolve eagerly in `.action()`
- [x] 2.3 Update `CompileOutput` and `CompiledAction` types: change `env` from `string[]` to `Record<string, string>`; update `compile()` to merge workflow env + action env (action wins)
- [x] 2.4 Add second generic parameter to `WorkflowBuilder<E, Env>` for type-safe `ctx.env` across workflow-level and action-level env keys
- [x] 2.5 Update SDK exports to include `env`, `ENV_REF`, and `EnvRef`
- [x] 2.6 Add/update tests for workflow-level `.env()`, action-level `env: {}`, merge behavior (action overrides workflow), and compile output

## 3. Manifest and Vite plugin

- [x] 3.1 Update `ManifestSchema` in SDK: change `actions[].env` from `z.array(z.string())` to `z.record(z.string())`
- [x] 3.2 Update `ManifestAction` type in `packages/vite-plugin/src/index.ts` to use `Record<string, string>` for env
- [x] 3.3 Update manifest extraction in Vite plugin to pass through `Record<string, string>` env from compile output

## 4. Runtime: per-action env injection

- [x] 4.1 Add `env: Record<string, string>` field to the `Action` interface in `packages/runtime/src/actions/index.ts`
- [x] 4.2 Update loader (`packages/runtime/src/loader.ts`) to read `env` from manifest action entries and attach to loaded `Action` objects
- [x] 4.3 Update `createActionContext` signature: remove global `env` parameter; accept per-action env as argument to the returned factory function
- [x] 4.4 Update `ActionContext` class: change `env` type from `Record<string, string | undefined>` to `Record<string, string>`
- [x] 4.5 Update scheduler to pass `action.env` when calling the context factory
- [x] 4.6 Update `main.ts`: remove `process.env` passthrough to `createActionContext`
- [x] 4.7 Update runtime tests for loader, context, and scheduler changes

## 5. Workflow migration

- [x] 5.1 Migrate `workflows/cronitor.ts` to use workflow-level `.env()` and action-level `env: {}` with `env()` helper
- [x] 5.2 Verify build succeeds with env vars set and fails without them
