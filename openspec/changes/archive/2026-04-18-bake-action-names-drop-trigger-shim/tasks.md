## 1. SDK — `httpTrigger()` returns a callable

- [x] 1.1 In `packages/sdk/src/index.ts`, change the `HttpTrigger` interface so it carries a call signature `(payload) => Promise<HttpTriggerResult>` and drop the `handler` property
- [x] 1.2 In `packages/sdk/src/index.ts`, change `httpTrigger(config)` to construct a callable that closes over `config.handler` and runs it; attach `HTTP_TRIGGER_BRAND`, `path`, `method`, `body`, `params`, `query`, `schema` as readonly own properties on the callable; freeze the function
- [x] 1.3 In `packages/sdk/src/index.ts`, confirm `isHttpTrigger(value)` still works — the brand check `(value as Record<symbol, unknown>)[HTTP_TRIGGER_BRAND] === true` works for callables too; update the `typeof value === "object"` guard to also accept `typeof value === "function"`

## 2. SDK — `action({...})` requires `name`, drops `.handler` and `__setActionName`

- [x] 2.1 In `packages/sdk/src/index.ts`, change `action(config)` to require `config.name: string`; initialize `assignedName = config.name` so the callable is named at construction
- [x] 2.2 In `packages/sdk/src/index.ts`, drop the `setName`/`getName` machinery from `attachActionMetadata` and `ActionMetadata`; replace the dynamic `name` getter with a static `name` value property
- [x] 2.3 In `packages/sdk/src/index.ts`, drop the `handler` and `__setActionName` properties from the public `Action` interface and from `attachActionMetadata`
- [x] 2.4 In `packages/sdk/src/index.ts`, change the missing-name path in the callable: instead of "Action was invoked before the build system assigned it a name", throw "Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin" if `assignedName` is undefined or empty at call time

## 3. Vite-plugin — AST transform injects `name`

- [x] 3.1 In `packages/sdk/src/plugin/index.ts`, add a Rollup `transform(code, id)` hook that runs on workflow source files; parse the source via Vite's bundled `acorn` (or Rollup's `this.parse`); walk top-level statements
- [x] 3.2 In the AST visitor, match `ExportNamedDeclaration > VariableDeclaration(kind: "const") > VariableDeclarator { id: Identifier, init: CallExpression { callee: Identifier("action"), arguments: [ObjectExpression, ...] } }`; for each match, use MagicString to inject `, name: "<id.name>"` immediately before the closing `}` of the first argument
- [x] 3.3 Return a `{ code, map }` from `transform` so sourcemaps are preserved; skip files that produce no edits (return `null`)
- [x] 3.4 In `packages/sdk/src/plugin/index.ts`, drop the build-time `actionExport.__setActionName(exportName)` call from the export-walking step in `buildActionEntries` (or wherever the plugin walks evaluated exports for manifest derivation) — the name is now baked into the call source
- [x] 3.5 In `packages/sdk/src/plugin/index.ts`, change the `buildTriggerEntry` precondition check from `typeof trigger.handler !== "function"` to `typeof trigger !== "function"` with the same error message text adapted

## 4. Vite-plugin — declaration-form validation + alias detection

- [x] 4.1 In `packages/sdk/src/plugin/index.ts`, after the post-bundle `discoverExports` walk, add a check that every `Action`-branded export has a non-empty `.name`; fail with `"Workflow \"<file>\": action \"<exportName>\" was not transformed at build time. Actions must be declared as: export const X = action({...})"` if any are missing
- [x] 4.2 In `packages/sdk/src/plugin/index.ts`, replace the alias-detection mechanism (currently `__setActionName` second-call throws) with an identity-set check during the export walk: maintain `Map<callable, exportName>`; on second-bind throw `ERR_ACTION_MULTI_NAME` with the same error text as today
- [x] 4.3 Add a build-error path for `export default action({...})` — if the default-exported value is `Action`-branded, fail with "action cannot be a default export; use `export const`"

## 5. Runtime — drop trigger shim and name binder

- [x] 5.1 In `packages/runtime/src/workflow-registry.ts`, delete `TRIGGER_SHIM_PREFIX`, `triggerShimName`, `buildTriggerShim`, `buildActionNameBinder`
- [x] 5.2 In `packages/runtime/src/workflow-registry.ts`, simplify `buildSandboxSource` to `${bundleSource}\n${ACTION_DISPATCHER_SOURCE}`
- [x] 5.3 In `packages/runtime/src/workflow-registry.ts`, change `buildInvokeHandler` so `sb.run(...)` is called with `triggerName` directly (the user's export name from the manifest), not `triggerShimName(triggerName)`

## 6. Tests — SDK

- [x] 6.1 In `packages/sdk/src/index.test.ts`, replace the `expect(a.handler).toBe(handler)` assertion with `expect(typeof a).toBe("function")` and a behavioral test `await a({...})` that exercises the dispatch path with a stubbed `__dispatchAction` global; assert the handler ran via observable side-effect
- [x] 6.2 In `packages/sdk/src/index.test.ts`, replace the `expect(t.handler).toBe(handler)` assertion with `expect(typeof t).toBe("function")` and a behavioral test `await t({...})` that returns the handler's result
- [x] 6.3 In `packages/sdk/src/index.test.ts`, add a test "action without name throws on first invocation" — construct `action({input, output, handler})` (no name), call it, assert it throws with the expected message
- [x] 6.4 In `packages/sdk/src/index.test.ts`, add a test "action with name dispatches with that name" — construct `action({input, output, handler, name: "myAction"})`, stub `__dispatchAction`, invoke, assert dispatcher saw `name === "myAction"`
- [x] 6.5 In `packages/sdk/src/index.test.ts`, drop tests that reference `__setActionName` (the slot is gone)

## 7. Tests — vite-plugin

- [x] 7.1 In `packages/sdk/src/plugin/workflow-build.test.ts`, verify `BASIC_WORKFLOW` continues to build successfully and that the resulting bundle source contains `name: "sendNotification"` injected into the `action({...})` call (read the emitted bundle text)
- [x] 7.2 In `packages/sdk/src/plugin/workflow-build.test.ts`, update the `ACTION_TWO_NAMES` fixture's expected error path — it still fails with `ERR_ACTION_MULTI_NAME`, but now that error originates in the plugin's identity-set check, not the SDK's `__setActionName` throw
- [x] 7.3 In `packages/sdk/src/plugin/workflow-build.test.ts`, add a fixture `ACTION_DETACHED_EXPORT` with `const X = action({...}); export { X };` and assert the build fails with the new "must be declared as `export const X = action({...})`" error
- [x] 7.4 In `packages/sdk/src/plugin/workflow-build.test.ts`, add a fixture `ACTION_DEFAULT_EXPORT` with `export default action({...})` and assert the build fails with "action cannot be a default export"
- [x] 7.5 In `packages/sdk/src/plugin/workflow-build.test.ts`, add a fixture `ACTION_FACTORY_WRAPPER` with `const make = (...) => action({...}); export const X = make(...)` and assert the build fails with the "not transformed at build time" error from task 4.1

## 8. Tests — runtime

- [x] 8.1 In `packages/runtime/src/workflow-registry.test.ts`, audit the hand-rolled bundle fixtures; for any that exercise an action, ensure the bundle source includes `name: "..."` in the `action({...})` call so the SDK accepts it (or use the bare `__wfe_exports__` mechanic that bypasses the SDK)
- [x] 8.2 In `packages/runtime/src/workflow-registry.test.ts`, audit the hand-rolled bundle fixtures; for any that exercise a trigger, ensure the bundle exports a callable on `__wfe_exports__.<triggerName>` (since `httpTrigger()` now returns a callable, this falls out naturally if the fixture uses the SDK's `httpTrigger()` factory)
- [x] 8.3 In `packages/runtime/src/integration.test.ts`, run the existing trigger → action → host validation → archive end-to-end and confirm it passes; the trigger is invoked via `sb.run("<triggerName>", ...)` directly (no shim prefix)
- [x] 8.4 Covered by existing "invokeHandler stamps id/tenant/workflow/workflowSha onto emitted events" test: the fixture's bundle has `exports.onPing` as a plain callable (no `__trigger_onPing` shim), and `runner.invokeHandler("evt_x", "onPing", ...)` succeeds — proving `sb.run` received `"onPing"` directly

## 9. SECURITY.md and CLAUDE.md

- [x] 9.1 In `SECURITY.md`, locate the §2 ASCII diagram around L85 that mentions `action.handler(input)`; update it to reflect that the handler is no longer a public property — the dispatcher path is the only path
- [x] 9.2 In `SECURITY.md`, remove any references to `__setActionName`, `__trigger_*` shim, and the action-bypass-via-`.handler` residual from §2 narrative; this bypass channel is now closed (none existed in the current file)
- [x] 9.3 In `CLAUDE.md`, audit the "Security Invariants" section for invariants that reference `__setActionName` or `__trigger_*`; update or remove (none found)

## 10. Validation

- [x] 10.1 Run `pnpm lint` and confirm no new biome warnings in touched files
- [x] 10.2 Run `pnpm check` and confirm no TypeScript errors
- [x] 10.3 Run `pnpm test` and confirm all unit + integration tests pass (421/421)
- [x] 10.4 Run `pnpm exec openspec validate bake-action-names-drop-trigger-shim --strict` and confirm zero issues
- [x] 10.5 Built cronitor end-to-end via SDK `build({cwd: workflows/})`; verified `bundle.tar.gz` contains `name: "sendNotification"` injected into the `action({...})` call expression, and both `exports.sendNotification` and `exports.cronitorWebhook` are callable; integration test suite (runtime + sandbox end-to-end) passes
- [x] 10.6 Added BREAKING entry to `## Upgrade notes` in `CLAUDE.md`
