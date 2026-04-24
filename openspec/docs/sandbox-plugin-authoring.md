# Sandbox plugin authoring guide

Practical reference for adding a plugin to `@workflow-engine/sandbox`. Assumes familiarity with the sandbox's QuickJS+WASI model. For rationale, see `openspec/changes/sandbox-plugin-architecture/design.md` §1, §2, §3, §5, §7, §10.

## 1. File shape

A plugin is a single TypeScript module with a fixed set of named exports. No `export default`, no factory wrapper, no classes.

```ts
// packages/runtime/src/plugins/trigger.ts
import type { PluginSetup, RunInput, SandboxContext } from "@workflow-engine/sandbox";

const name = "trigger";

function worker(ctx: SandboxContext): PluginSetup {
    return {
        onBeforeRunStarted(runInput: RunInput): boolean {
            ctx.emit("trigger.request", runInput.name,
                { input: runInput.input }, { createsFrame: true });
            return true;
        },
        onRunFinished(result, runInput) { /* ... */ },
    };
}

export { name, worker };
```

The required exports are `name` (static string) and `worker(ctx, deps, config)`. Optional: `dependsOn: readonly string[]` (static) and a type-only `export type Config = ...`. Config is erased at build time; its shape is enforced by the main-thread helper that constructs `descriptor.config` — see §9.

The vite plugin wraps every plugin file with a synthetic rollup entry that emits `export { worker as default }`. That is why plugin files must not declare their own `export default`: biome's `noDefaultExport` rule and the synthetic entry would collide.

## 2. Arg/result vocabulary (`Guest.*`)

Every `GuestFunctionDescription` declares its args and result as `ArgSpec`/`ResultSpec` values from the `Guest` helper (`packages/sandbox/src/plugin-types.ts`). Pick the narrowest type that matches the wire shape.

| Call                       | Use for                                                                         |
|----------------------------|---------------------------------------------------------------------------------|
| `Guest.string() / .number() / .boolean()` | Primitives with known shape.                                     |
| `Guest.object<T>()`        | JSON object. Pass a type param for handler ergonomics (default `Record<string, unknown>`). |
| `Guest.array(item)`        | Homogeneous JSON array; `item` is itself an `ArgSpec`.                          |
| `Guest.callable()`         | Captures a guest function as `Callable` (invocable + `.dispose()`; args only).  |
| `Guest.raw()`              | Pre-validated `GuestValue` — skip structural shape checks; caller-validated.    |
| `Guest.void()`             | Result only; handler returns nothing the guest will observe.                    |

Use `Guest.raw()` when an upstream caller already validated the payload (e.g. the SDK's Zod parser) or when the shape is JSON but genuinely dynamic — otherwise prefer `Guest.object<T>()` so a wrong shape surfaces as a typed marshalling error before your handler runs.

`Guest.callable()` is arg-only; results returning Callables are not supported. The handler receives a `Callable` whose `(...args)` returns `Promise<GuestValue>`. Always `dispose()` it in a `finally`:

```ts
// packages/sdk/src/sdk-support/index.ts
args: [Guest.string(), Guest.raw(), Guest.callable()],
result: Guest.raw(),
handler: async (actionName, input, handler) => {
    try {
        validateAction(actionName, input);
        const raw = await handler(input as GuestValue);
        return validateActionOutput(actionName, raw);  // host-side
    } finally {
        handler.dispose();
    }
},
```

## 3. `log` config — leaf vs request/response

Every descriptor emits an audit event by default. `log` controls the shape.

- `log: { event: "name" }` — emits a single leaf event before handler invocation. Use for commands with no response pair (e.g. `timer.set`, `timer.clear`, `console.log`). See `sandbox-stdlib/src/timers/index.ts`.
- `log: { request: "prefix" }` — wraps the handler in `ctx.request(prefix, ...)`, emitting `prefix.request` before and `prefix.response` or `prefix.error` after. Use for anything resembling an RPC (fetch, host-call-action, sdk dispatcher).
- Default (no `log`) — equivalent to `{ request: descriptor.name }`. Audit-by-default keeps forgotten declarations safe.

**Event-volume note.** Every descriptor call produces at least one bus event (leaf or request/response pair) that fans out through the full consumer chain — persistence (`pending/`/`archive/`), EventStore (DuckDB index), and the logging consumer. In practice only the logging consumer filters: it logs solely the three `trigger.*` lifecycle kinds and drops `action.*`, `fetch.*`, `timer.*`, `console.*`, `wasi.*`, and `system.*` (see `logging-consumer/spec.md`). Persistence and EventStore, however, receive everything. A hot loop that calls an audited descriptor N times per invocation therefore produces ~N sandbox→host→bus round trips and N event-store rows. When introducing a new descriptor on a tight path, consider `log: { event: "name" }` (a single leaf, not a request/response pair) or no-op audit only for operations whose volume is bounded by the invocation surface; do not add a new reserved event prefix (`trigger`, `action`, `fetch`, `timer`, `console`, `wasi`, `uncaught-error`) for a third-party plugin (§2 R-7 in `CLAUDE.md`).

See design §7 for the rationale against kind-suffix auto-detection.

## 4. `public: true` vs `public: false`

Descriptors default to `public: false` — the sandbox deletes `globalThis[name]` after Phase-2 source eval runs. Tenant code never sees the binding. Set `public: true` only to expose a name directly to tenant code (timers, `console`, the WHATWG polyfill's entry points).

```ts
// timers — directly user-visible
{ name: "setTimeout", args: [...], result: Guest.number(),
  handler: ..., log: { event: "timer.set" }, public: true }

// fetch dispatcher — captured by polyfill, deleted from globalThis
{ name: "$fetch/do", args: [...], result: Guest.object(),
  handler: ..., log: { request: "fetch" } /* public defaults to false */ }
```

Private descriptors require a Phase-2 source IIFE in the same plugin that captures them into a locked object before Phase-3 deletes them; otherwise the capability is unreachable. The `sdk-support` plugin is the canonical example — see `packages/sdk/src/sdk-support/index.ts`.

## 5. `logName` / `logInput` overrides

The default audit event stamps `name = descriptor.name` and `input = args`. Override when the raw arg tuple is the wrong shape for the event:

```ts
// packages/sdk/src/sdk-support/index.ts
{
    name: "__sdkDispatchAction",
    args: [Guest.string(), Guest.raw(), Guest.callable()],
    result: Guest.raw(),
    log: { request: "action" },
    logName: (args) => String(args[0] ?? ""),  // the action's business name
    logInput: (args) => args[1],               // just the payload, no Callable
    public: false,
}
```

`logInput` matters whenever an arg is a `Callable` — Callables cannot cross the worker `postMessage` boundary intact, so leaving them in the default `input` tuple produces garbage (or a serialization crash).

## 6. Lifecycle hooks

- `onBeforeRunStarted(runInput) => boolean | void` runs in topo order at the start of every `sb.run(...)`. Returning truthy **preserves** any frames the hook pushed via `createsFrame` — subsequent guest emissions nest under them until `onRunFinished` pops. Returning falsy/void makes the sandbox auto-balance the stack right after the hook returns (frames that the hook opened get closed implicitly).
- `onRunFinished(result, runInput) => void` runs in reverse topo order **inside** the run's ref frame: any events it emits still nest under the trigger's (or other preserved) frame. Use for cleanup + closing frames previously opened.

The trigger plugin is the reference pair:

```ts
onBeforeRunStarted(runInput): boolean {
    ctx.emit("trigger.request", runInput.name, { input: runInput.input },
             { createsFrame: true });
    return true;  // keep the pushed frame alive for the whole run
},
onRunFinished(result, runInput) {
    const kind = result.ok ? "trigger.response" : "trigger.error";
    ctx.emit(kind, runInput.name, { /* ... */ }, { closesFrame: true });
},
```

The timers plugin uses `onRunFinished` for leak prevention (clear dangling timers + emit one `timer.clear` leaf each), without opening any frame of its own — returning `void` from `onBeforeRunStarted` is implicit.

## 7. `ctx.emit` vs `ctx.request` + frame control

`ctx.emit(kind, name, extra, options?)` is the primitive. `ctx.request(prefix, name, extra, fn)` is sugar: it emits `prefix.request` (createsFrame), runs `fn` (sync or async), emits `prefix.response`/`prefix.error` (closesFrame), and returns the result.

Use `ctx.emit` when you need a single leaf event, when you're opening/closing a frame across hook boundaries (trigger, run lifecycle), or when the wrapped computation is not a plain function call. Use `ctx.request` for any handler-like call site — it's a single line and error-safe.

`createsFrame` pushes the emitted event's seq onto the ref stack so subsequent leaf emissions carry it as `ref`. `closesFrame` pops the stack after emitting (the emitted event itself still has the outgoing frame's ref). Seq/ref/ts are stamped internally and never exposed — plugin code only flips these flags.

## 8. Exporting to peer plugins via `deps`

A plugin can expose functions to other plugins by returning `{ exports: { ... } }` from `worker()`:

```ts
// packages/runtime/src/plugins/host-call-action.ts
// Config carries separate per-action validator-source maps (strings
// emitted on the main thread via Ajv standaloneCode). The worker
// `new Function(...)`-instantiates each one at load; no Ajv runtime
// is bundled into the worker.
function worker(_ctx, _deps, config: Config): PluginSetup {
    const inputValidators = compileValidators(config.inputValidatorSources);
    const outputValidators = compileValidators(config.outputValidatorSources);
    const validateAction = (name, input) => { /* runs input validator */ };
    const validateActionOutput = (name, output) => { /* runs output validator, returns output */ };
    return { exports: { validateAction, validateActionOutput } };
}
```

Consumers declare `dependsOn: ["host-call-action"]` and read from the `deps` argument:

```ts
// packages/sdk/src/sdk-support/index.ts
const dependsOn: readonly string[] = ["host-call-action"];

function worker(_ctx: SandboxContext, deps: DepsMap): PluginSetup {
    const { validateAction } = resolveHostCallActionDeps(deps);
    // ... use validateAction inside the dispatcher handler
}
```

Topo-sort guarantees that a peer's `exports` are populated before your `worker()` runs. A missing dep or a cycle is a construction-time error.

## 9. Main-thread preparation (the "how do I use Ajv?" pattern)

Plugin files are bundled for the worker thread and tree-shaken from a synthetic `export { worker as default }` entry. Anything reachable from `worker` ends up in the worker bundle; anything you import only from an ordinary helper in the same package is dropped.

For heavy main-thread-only deps (Ajv is ~200 KB), compile on the main thread in a separate file and pass the result as a JSON-serializable `config`:

```ts
// packages/runtime/src/host-call-action-config.ts — main-thread only
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCodeMod from "ajv/dist/standalone/index.js";

function compileActionValidators(manifest): HostCallActionConfig {
    const ajv = new Ajv2020.default({ /* ... */ });
    const inputValidatorSources: Record<string, string> = {};
    const outputValidatorSources: Record<string, string> = {};
    for (const action of manifest.actions) {
        inputValidatorSources[action.name] = standaloneCode(ajv, ajv.compile(action.input));
        outputValidatorSources[action.name] = standaloneCode(ajv, ajv.compile(action.output));
    }
    return { inputValidatorSources, outputValidatorSources };
}
```

The plugin file imports nothing from Ajv. It receives the string sources and rehydrates them with `new Function(...)`:

```ts
// packages/runtime/src/plugins/host-call-action.ts
function worker(_ctx, _deps, config: Config): PluginSetup {
    const inputValidators = compileValidators(config.inputValidatorSources);
    const outputValidators = compileValidators(config.outputValidatorSources);
    // validateAction / validateActionOutput close over the maps ...
}
```

Sandbox-store calls the main-thread helper when composing descriptors and spreads the result into `descriptor.config`. See `packages/runtime/src/sandbox-store.ts`'s `buildPluginDescriptors`.

## 10. Common pitfalls

- **Don't `export default` in a plugin file.** Biome blocks it, and the vite synthetic entry already emits `export { worker as default }`.
- **Don't import main-thread-only packages inside code reachable from `worker()`.** A single transitive import of Ajv, `node:fs`, etc. defeats tree-shaking and bloats the worker bundle. Keep heavy deps in separate helpers (§9).
- **Configs must be JSON-serializable.** No functions, Promises, `Date`s, `RegExp`s, or class instances. `serializePluginDescriptors` rejects non-conforming values at sandbox construction — fail loudly, fail early.
- **Don't mutate `globalThis` directly from plugin source.** Use `guestFunctions` with `public: true`; the sandbox handles naming, installation, and Phase-3 deletion centrally. Manual `globalThis.foo = ...` bypasses the audit-log auto-wrap.
- **Private descriptors need a capture IIFE.** If `public: false` (the default) and you don't export a `guest()` function (bundled as `descriptor.guestSource` by the vite plugin) that captures the private binding into a closure, the binding is deleted before anyone can reach it. Phase 2 evaluates `descriptor.guestSource` before Phase 3's auto-delete specifically for this capture window; see `packages/sdk/src/sdk-support/index.ts` (`guest()` export capturing `__sdkDispatchAction` into a locked `__sdk`) and `packages/sandbox-stdlib/src/console/index.ts` for canonical examples.
- **Always `dispose()` captured `Callable`s** — ideally in a `finally`. Leaking a Callable pins a guest closure past its expected lifetime.

## 11. The vite plugin

Consumers register `sandboxPlugins()` from `@workflow-engine/sandbox/vite` in their vite config. Thereafter, importing a plugin file with the `?sandbox-plugin` query returns a `{ name, dependsOn?, workerSource, guestSource? }` record ready to spread into a `PluginDescriptor` together with a `config`:

```ts
import hostCallActionPlugin from "./plugins/host-call-action?sandbox-plugin";

const descriptor = {
    ...hostCallActionPlugin,
    config: compileActionValidators(workflow.manifest),
};
```

ESLint rules enforcing some of §10's discipline (`no-direct-globalThis-write`, `no-direct-fetch`, `no-process-bridge`) are tracked as future work — design.md alternatives section — and are not yet implemented.
