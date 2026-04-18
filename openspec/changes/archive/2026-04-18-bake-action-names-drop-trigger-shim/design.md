## Context

Workflow bundles loaded into the sandbox today rely on two pieces of source-code generation appended by the runtime at load time:

```
              ┌────────────────────────────────────────────────────┐
              │  buildSandboxSource()  — packages/runtime/src/     │
              │                          workflow-registry.ts       │
              ├────────────────────────────────────────────────────┤
              │                                                    │
              │   ${bundleSource}                                  │
              │   ${ACTION_DISPATCHER_SOURCE}    ← keep            │
              │   ${nameBinder}                  ← drop            │
              │   ${triggerShim}                 ← drop            │
              │                                                    │
              └────────────────────────────────────────────────────┘
```

The two pieces being dropped exist because of two asymmetries in the SDK:

1. **`httpTrigger()` returns an object, not a callable.** The sandbox's `Sandbox.run(exportName, payload, ctx)` invokes a top-level callable from the IIFE namespace. To bridge from "object on the namespace" to "callable on the namespace", the runtime appends `__trigger_<name> = async (p) => __wfe_exports__.<name>.handler(p)` per trigger. The `__` prefix avoids overwriting the user's own `<name>` export.

2. **`action()` returns an unnamed callable.** Inside QuickJS the bundle re-evaluates from source, so the Node-side `__setActionName(exportName)` calls the vite-plugin made are evicted; the VM-side closures all start with `assignedName === undefined`. The runtime appends per-action `__setActionName(exportName); delete __setActionName;` to bind names at sandbox-load.

Both pieces work, but they push code-gen responsibility onto the runtime and impose a side-channel (`__setActionName`) on each action callable that the runtime has to delete defensively. The cleaner end-state baked at build time:

```
WORKFLOW SOURCE                       BUNDLE (post-plugin transform)
─────────────────                     ──────────────────────────────

export const X = action({             export const X = action({
  input, output, handler                input, output, handler,
})                                      name: "X"           ← injected
                                      })

export const Y = httpTrigger({        export const Y = httpTrigger({
  path, body, handler                   path, body, handler
})                                    })  ← unchanged

                                      Y is itself callable:
                                        Y(payload) === user-handler(payload)
```

```
INSIDE SANDBOX (post-load)
──────────────────────────

  globalThis.__wfe_exports__:
    ├─ X    ← action callable, name="X" baked at build time
    └─ Y    ← trigger callable

  Sandbox.run("Y", payload, ctx)
       │
       ▼
  globalThis.__wfe_exports__.Y(payload)
       │  (the user's handler)
       ▼
  await X({...})
       │
       ▼
  dispatchAction("X", input, handler, schema)
       │
       ▼
  globalThis.__dispatchAction("X", ..., handler, schema)
       │
       ▼
  __hostCallAction("X", ...)  +  invoke handler  +  validate output
```

**Constraints inherited:**

- `quickjs-wasi` IIFE evaluation model unchanged. `Sandbox.run` still expects a top-level callable name on `globalThis[IIFE_NAMESPACE]`.
- `core.dispatchAction()` continues to read `globalThis.__dispatchAction` per-call.
- The IIFE_NAMESPACE convention (`__wfe_exports__`) is unchanged.
- The vite-plugin's `discoverExports` step continues to walk evaluated module exports for manifest derivation; the new AST transform runs separately during Rollup's `transform` hook on the source.

**Stakeholders:**

- Workflow authors: must use `export const X = action({...})` declaration form (most already do). Cannot read `.handler` from action or trigger objects (none do today).
- SDK / plugin maintainers: gain one AST-transform step, lose two runtime code-gen steps. Net surface shrinks.
- Sandbox / runtime maintainers: registry simplifies; one fewer side-channel to defend against.

## Goals / Non-Goals

**Goals:**

- Drop the `__trigger_<name>` shim entirely by making `httpTrigger()` return a callable.
- Drop the `__setActionName` side-channel and the runtime's per-action binder by requiring `name` in `action({...})` and AST-injecting it at build time.
- Drop `.handler` from both `Action` and `HttpTrigger` public types — net SDK surface shrinks; closes the `myAction.handler(input)` audit-log-bypass channel.
- Constrain action declarations to one canonical form (`export const X = action({...})`) so the AST transform stays trivial (~10 lines of acorn visitor) and the build error messages stay specific.

**Non-Goals:**

- Build-time injection of `name` into `httpTrigger({...})` calls. Triggers don't need names — the registry knows the trigger's export name from the manifest, and `Sandbox.run` is called with the export name directly. Adding a redundant `name` field would be noise.
- Changing the IIFE evaluation model or the IIFE_NAMESPACE constant.
- Hiding `__dispatchAction` (still locked-but-visible per `hide-private-sandbox-methods`).
- Supporting workflow-author declaration patterns beyond `export const X = action({...})`. Detached exports, default exports, conditional definitions, factory functions, and computed exports all fail the build with a clear message.
- Per-trigger host audit hooks (`__hostCallTrigger`). The sandbox already emits `trigger.request` / `trigger.response` events covering this need.

## Decisions

### D1: `httpTrigger()` returns a callable; `.handler` removed

The SDK's `httpTrigger(config)` constructs a callable that closes over `config.handler` and runs it. The brand symbol, `path`, `method`, `body`, `params`, `query`, `schema` remain as readonly properties on the callable (callable functions can carry arbitrary properties, exactly as today's `Action` does). The public `HttpTrigger` interface drops `.handler` — the callable IS the handler.

```ts
interface HttpTrigger<...> {
  (payload: HttpTriggerPayload<...>): Promise<HttpTriggerResult>;
  readonly [HTTP_TRIGGER_BRAND]: true;
  readonly path: Path;
  readonly method: string;
  readonly body: Body;
  readonly params: Params;
  readonly query: Query | undefined;
  readonly schema: z.ZodType;
}
```

The runtime's invoke path becomes `sb.run(triggerName, payload, ctx)` where `triggerName` is the user's export name from the manifest. No shim, no prefix.

### D2: `action({..., name})` is required; `.handler` and `__setActionName` removed

The SDK's `action(config)` requires `config.name: string`. The callable is constructed with `assignedName = config.name`; subsequent `dispatchAction(assignedName, ...)` calls work immediately. There is no `__setActionName` slot to defend, no name-binder shim to append.

```ts
interface Action<I, O> {
  (input: I): Promise<O>;
  readonly [ACTION_BRAND]: true;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly name: string;
}
```

If `action({...})` is called without a `name` in a hand-rolled bundle (test fixture, etc.), the callable throws on first invocation: `Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin`.

The captured `handler` is closed over the callable but not exposed as a property — guest code can no longer call `action.handler(input)` to bypass the dispatcher.

### D3: Vite-plugin AST-transforms `export const X = action({...})` declarations

The plugin adds a `transform(code, id)` hook that runs on workflow source files. It uses Rollup's bundled `acorn` parser (already in the dep tree via Vite) to walk the AST and inject `name: "<exportName>"` into matching `action({...})` call expressions:

```
ExportNamedDeclaration
  └─ VariableDeclaration  (kind: "const")
       └─ VariableDeclarator { id: Identifier("X"), init: CallExpression }
                                                            │
                              CallExpression                ▼
                                ├─ callee: Identifier("action")
                                └─ arguments[0]: ObjectExpression
                                                       │
                                       inject `name: "X"` here
                                       (StringLiteral property)
```

Match conditions (all must hold):
- Node is an `ExportNamedDeclaration` directly containing a `VariableDeclaration` of kind `const`.
- The declaration has exactly one `VariableDeclarator` with an `Identifier` id.
- The declarator's `init` is a `CallExpression` whose callee is the bare identifier `action` (no member access, no aliased imports — the SDK convention is to import `action` directly).
- The first argument is an `ObjectExpression` literal (not a spread, not a variable reference).

If any condition fails, the transform leaves the call unchanged. The resulting `action({...})` runs without a name and throws at first invocation — the user gets a clear error pointing at the declaration form.

The transform uses MagicString for source-level edits to preserve sourcemaps (Vite's standard pattern).

### D4: Alias detection moves to the plugin's export walk

After the AST transform runs and Rollup bundles, the plugin's existing `discoverExports` step still walks the evaluated module exports for manifest derivation. It already has every export's name and value; it picks up an identity-set check:

```ts
const seen = new Map<unknown, string>();
for (const [name, value] of Object.entries(mod)) {
  if (isAction(value)) {
    const prior = seen.get(value);
    if (prior !== undefined) {
      ctx.error(`action exported under two names: "${prior}" and "${name}" (${file})`);
    }
    seen.set(value, name);
  }
}
```

Same detection rule as today, same error code (`ERR_ACTION_MULTI_NAME`), implementation moves from the SDK's `__setActionName` second-call-throws to the plugin's export walk.

### D5: Declaration patterns that fail the build

The plugin's manifest builder treats any of the following as a hard error with a specific message:

| Pattern                                                | Error                                                       |
|--------------------------------------------------------|-------------------------------------------------------------|
| `const X = action({...}); export { X };`               | "action must be declared as `export const X = action({...})`" |
| `export default action({...})`                         | "action cannot be a default export; use `export const`"      |
| `export const X = action({...}); export { X as Y };`   | `ERR_ACTION_MULTI_NAME` (existing message)                   |
| `export const X = isProd ? action({...}) : action({...})` | "action must be a direct call expression at module scope"   |
| `export const X = makeAction({...})` (factory wrapper) | not detected; runtime throws "Action constructed without a name" on first invocation |

The first four are detected at build time by the AST transform / export walk. The last (factory wrappers) is intentionally a runtime failure — the SDK can't statically detect arbitrary factory shapes, and the runtime error message points at the cause.

### D6: Migration path for hand-rolled test bundles

The sandbox package's tests construct hand-rolled IIFE bundles via the `iife()` helper and similar fixtures. These don't go through the plugin and don't use the SDK's `action()` factory at all (they test the sandbox primitives directly). They are unaffected.

The plugin's own test fixtures (`workflow-build.test.ts`) use the SDK and DO go through the full plugin pipeline. Existing `BASIC_WORKFLOW` matches the supported pattern. `ACTION_TWO_NAMES` exercises alias detection (still fails the build, just with the relocated check). New fixtures cover the unsupported declaration patterns.

The runtime's tests (`workflow-registry.test.ts`, `integration.test.ts`) load fixture bundles that simulate the post-plugin output. These need to construct bundles where `action({...})` calls already include `name: "..."` (or skip the SDK and use the bare `__wfe_exports__` mechanic, which several already do).

### D7: Spec scope

Four capability specs touched: `sdk` (action + httpTrigger factory contracts), `vite-plugin` (Action call resolution at build time + new declaration-form constraint + alias scenario under Brand-symbol export discovery), `workflow-loading` (bundle-suffix shrinks to dispatcher-only), `http-trigger` (httpTrigger factory contract gains callable shape).

The `triggers`, `executor`, `workflow-registry`, `actions`, `payload-validation` specs are not touched — their requirements describe behavior at a layer that doesn't reference the trigger shim or the name binder.

## Risks & Mitigations

**Risk 1: AST transform missed cases produce silent runtime failures.**
The transform looks for a precise AST shape. If a workflow author writes `export const X = action(myConfig)` (passing a variable instead of an object literal), the transform skips it; the action runs unnamed; runtime throws on first invocation. The error message is specific ("Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin"), but it's a runtime error, not a build error.

*Mitigation:* the plugin's existing post-bundle `discoverExports` walk can additionally check `typeof exportedAction.name === "string" && exportedAction.name !== ""` and fail the build if any exported `Action`-branded value lacks a name. This catches both the "factory wrapper" case and the "AST shape mismatch" case at build time, before the bundle ships.

**Risk 2: Alias detection regressions.**
Today's `__setActionName`-throws mechanism catches aliases at the second-bind site. The new identity-set check in the plugin export walk should catch the same cases. The `ACTION_TWO_NAMES` test fixture verifies this; if the test passes after the refactor, alias detection is functionally equivalent.

**Risk 3: Sourcemap fidelity.**
The AST transform inserts a property into an existing `ObjectExpression`. Using MagicString preserves source positions for the unchanged portions. The injected `, name: "X"` adds a column offset to the closing `})` and beyond. Since the injection is in declaration source (not handler bodies that produce stack traces in production), sourcemap impact on user-facing diagnostics is negligible.

**Risk 4: Reserved-import handling.**
The transform assumes `action` is imported as the bare identifier `action` from `@workflow-engine/sdk`. If a workflow author writes `import { action as defAction } from "@workflow-engine/sdk"` and then uses `export const X = defAction({...})`, the transform misses it.

*Mitigation:* the same post-bundle "every exported action has a name" check from Risk 1 catches this. Could also extend the transform to honor renamed imports by tracking the binding from the `ImportDeclaration`, but the cost-benefit favors the simpler validation-at-build-end approach.

**Risk 5: Documentation drift.**
SECURITY.md and CLAUDE.md both reference `__setActionName` and `__trigger_*` in invariants and the threat model. Both must be updated in the same PR; otherwise reviewers chasing security invariants will see stale guidance.

## Migration

This change is **breaking** for anyone reading `Action.handler` / `HttpTrigger.handler` from workflow code (none observed in the repo today) and for anyone using non-canonical action declaration forms (none observed). The bundled cronitor workflow (`workflows/src/cronitor.ts`) uses `export const sendNotification = action({...})` and `export const onEvent = httpTrigger({...})` — both supported as-is.

Steps:

1. Vite-plugin AST transform lands; existing workflows continue to build.
2. SDK `Action.handler` / `HttpTrigger.handler` / `__setActionName` removed in the same PR; `action({..., name: required})` enforced.
3. Runtime `buildTriggerShim` / `buildActionNameBinder` deleted in the same PR; `Sandbox.run(triggerName, ...)` invoked with the export name.
4. Tests updated; `pnpm validate` passes.

No workflow-bundle on-disk format change: the bundle is just JS source. Existing tenant tarballs continue to work after the runtime drops the shim+binder source — their bundles already export trigger objects (about to become trigger callables once rebuilt) and action callables. **Caveat**: tenants must re-upload their workflow bundles after this change because the SDK is bundled into the workflow output; old bundles ship with the old SDK whose `action()` doesn't take `name` and whose `httpTrigger()` returns a non-callable object. Add to `## Upgrade notes` in CLAUDE.md as a BREAKING entry alongside `multi-tenant-workflows`.
