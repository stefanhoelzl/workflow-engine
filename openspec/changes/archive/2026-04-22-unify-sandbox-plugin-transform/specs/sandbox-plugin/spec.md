## MODIFIED Requirements

### Requirement: PluginSetup shape

The sandbox package SHALL define a `PluginSetup` type that a plugin's `worker()` function returns.

```ts
type PluginSetup = {
  exports?: Record<string, unknown>;
  guestFunctions?: GuestFunctionDescription<any, any>[];
  wasiHooks?: WasiHooks;
  onBeforeRunStarted?: (runInput: { name: string; input: unknown }) => boolean | void;
  onRunFinished?: (result: RunResult, runInput: { name: string; input: unknown }) => void;
};
```

- `exports`: arbitrary values available to dependent plugins via `deps[pluginName][exportKey]`.
- `guestFunctions`: host-callable bindings installed via `vm.newFunction`.
- `wasiHooks`: hook implementations for WASI overrides (clock, random, fd_write).
- `onBeforeRunStarted`: called before every run. Returns truthy to preserve refStack state through the run.
- `onRunFinished`: called after every run, in reverse topo order. Receives the run outcome and the original run input.

Guest-side source is NOT returned from `worker()`; it is carried on `PluginDescriptor.guestSource` when the plugin file exports a `guest` function (see "Plugin file contract" and "JSON-serializable plugin descriptor" requirements).

#### Scenario: Plugin returning void provides nothing

- **GIVEN** a plugin whose `worker()` returns `undefined`
- **WHEN** the sandbox is constructed
- **THEN** the plugin SHALL be registered with no guest functions, no hooks, no exports, no guest source

### Requirement: JSON-serializable plugin descriptor

The sandbox SHALL transfer plugin descriptors from the main thread to the worker via `postMessage`. Each descriptor SHALL be JSON-serializable with this shape: `{ name: string, workerSource: string, guestSource?: string, dependsOn?: readonly string[], config?: unknown }`.

- `workerSource` is a pre-bundled ESM source string whose default export is the plugin's `worker(ctx, deps, config)` function. The worker loads it via `data:text/javascript;base64,<...>` dynamic import.
- `guestSource` is OPTIONAL: a pre-bundled IIFE source string evaluated as a top-level script inside the guest VM in Phase 2. Emitted by the `?sandbox-plugin` vite transform when the plugin file exports a `guest` function; omitted otherwise.
- Both strings are produced at build time by the `?sandbox-plugin` vite transform.
- `config` is JSON-serializable data. Functions, closures, class instances, and non-serializable values in `config` SHALL cause construction to fail.

#### Scenario: Function in config fails

- **GIVEN** a plugin factory passed config `{ logger: () => {} }`
- **WHEN** the plugin descriptor is serialized for the worker
- **THEN** sandbox construction SHALL throw with an error naming the offending config path

#### Scenario: Descriptor without guestSource

- **GIVEN** a plugin file that exports `worker` but no `guest`
- **WHEN** the `?sandbox-plugin` vite transform resolves the plugin's import
- **THEN** the emitted descriptor SHALL have a `workerSource` string
- **AND** the descriptor SHALL omit the `guestSource` field

#### Scenario: Descriptor with guestSource

- **GIVEN** a plugin file that exports both `worker` and `guest`
- **WHEN** the `?sandbox-plugin` vite transform resolves the plugin's import
- **THEN** the emitted descriptor SHALL have both a `workerSource` and a `guestSource` string
- **AND** evaluating `guestSource` as a top-level script SHALL invoke the `guest` function

### Requirement: Boot phase sequence

The sandbox SHALL execute plugin boot in these phases:

1. **Phase 0 — Module load**: load plugin worker modules from `descriptor.workerSource`, topo-sort, instantiate WASM with WASI imports (hook slots initially empty).
2. **Phase 1 — Plugin worker()**: for each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`. Register returned `guestFunctions` as `vm.newFunction` bindings on `globalThis`. Populate `wasiHooks` slots (collision throws). Store `exports`, `onBeforeRunStarted`, `onRunFinished`.
3. **Phase 2 — Guest source eval**: for each plugin in topo order, if `descriptor.guestSource` is defined, `vm.evalCode(descriptor.guestSource, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
4. **Phase 3 — Private delete**: for each `guestFunctions` entry with `public !== true`, `delete globalThis[name]`.
5. **Phase 4 — User source**: `vm.evalCode(userSource, filename)`.

On failure at any phase, the sandbox SHALL dispose the VM, post an `init-error` worker message, and `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private descriptor globals

- **GIVEN** a plugin with guest function descriptor `{ name: "__internal", public: false }`
- **WHEN** phase 3 executes
- **THEN** `globalThis.__internal` SHALL be `undefined`
- **AND** any plugin guest source that captured `__internal` into an IIFE closure in phase 2 SHALL retain access via the closure

#### Scenario: Failure in phase 2 triggers cleanup

- **GIVEN** plugin[0] and plugin[1] succeed in phase 2, plugin[2] guest source throws
- **WHEN** phase-2 evaluation encounters the error
- **THEN** the sandbox SHALL dispose the VM
- **AND** post `{ type: "init-error", error: <serialized> }` to main
- **AND** the worker process SHALL exit
- **AND** user source (phase 4) SHALL NOT have been evaluated

#### Scenario: Plugin without guestSource skips phase 2

- **GIVEN** a plugin whose descriptor omits `guestSource`
- **WHEN** phase-2 iteration reaches that plugin
- **THEN** no `vm.evalCode` call SHALL be made for it
- **AND** iteration SHALL continue to the next plugin

## ADDED Requirements

### Requirement: Plugin file contract

A plugin source file consumed by the `?sandbox-plugin` vite transform SHALL export:

- `name: string` — the plugin's unique identifier.
- `worker: (ctx: SandboxContext, deps: DepsMap, config: SerializableConfig) => PluginSetup | void | Promise<PluginSetup | void>` — the host-side setup function bundled into `descriptor.workerSource`.
- OPTIONAL `dependsOn: readonly string[]` — names of plugins whose exports must be available via `deps` during `worker()`.
- OPTIONAL `guest: () => void` — a zero-argument function bundled into `descriptor.guestSource` as an IIFE and evaluated as top-level guest script in Phase 2. The function SHALL NOT accept arguments; any guest-side dynamic input flows via host-installed `guestFunctions` that `guest()` captures-and-deletes per the existing plugin discipline.

#### Scenario: Missing worker export fails the transform

- **GIVEN** a plugin source file with no `worker` export
- **WHEN** the `?sandbox-plugin` vite transform resolves an import of that file
- **THEN** the transform SHALL throw with an error naming the missing export

#### Scenario: guest export is zero-argument

- **GIVEN** a plugin source file whose `guest` export is declared with an argument
- **WHEN** the TypeScript type-check runs against the plugin
- **THEN** the file SHALL fail to compile because `guest` must be typed as `() => void`

### Requirement: Vite transform produces two bundles per plugin

The `?sandbox-plugin` vite transform SHALL run two independent rollup builds per plugin file:

- **Worker pass**: synthetic entry `export { worker as default } from "<plugin-path>";`; output format `esm`; `treeshake: { moduleSideEffects: false }`; `node:*` marked external (worker runs in a Node `worker_thread`).
- **Guest pass** (only if the plugin file exports `guest`): synthetic entry `import { guest } from "<plugin-path>"; guest();`; output format `iife`; default tree-shaking; no module is marked external (guest code MUST NOT reach Node builtins; such an import SHALL fail the bundle).

The transform SHALL emit a virtual module whose default export is `{ name, dependsOn, workerSource, guestSource }` (with `guestSource` present only when the guest pass ran).

#### Scenario: Worker pass drops guest-only imports

- **GIVEN** a plugin file whose `guest` function imports `web-streams-polyfill` and whose `worker` does not reference it
- **WHEN** the `?sandbox-plugin` transform produces `workerSource`
- **THEN** the emitted ESM string SHALL NOT contain `web-streams-polyfill` content

#### Scenario: Guest pass bundle-time-fails on node builtins

- **GIVEN** a plugin file whose `guest` function imports `node:fs`
- **WHEN** the `?sandbox-plugin` transform runs the guest pass
- **THEN** the rollup build SHALL fail with a resolution or external-import error

## REMOVED Requirements

### Requirement: PluginSetup.source

**Reason**: Guest-side source is now carried on `PluginDescriptor.guestSource` at build time rather than returned from `worker()` at runtime. The sole consumer (`web-platform`'s `config.bundleSource` passthrough) is removed in the same change.

**Migration**: Plugins that previously returned `PluginSetup.source` SHALL instead export a `guest(): void` function from the plugin source file. The `?sandbox-plugin` vite transform bundles it into `descriptor.guestSource` automatically. Existing string literals (e.g. `buildConsoleSource()`, `SDK_SUPPORT_SOURCE`) are converted to inline TypeScript inside `guest()` and re-bundled by the transform.
