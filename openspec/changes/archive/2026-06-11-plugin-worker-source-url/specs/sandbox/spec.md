# sandbox delta: plugin-worker-source-url

## MODIFIED Requirements

### Requirement: Public API — sandbox() factory

The sandbox package SHALL export a `sandbox(opts)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(opts: {
  source: string;
  plugins: Plugin[];
  filename?: string;
  memoryLimit?: number;
  interruptHandler?: () => boolean;
}): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint.
2. Serialize each plugin into a descriptor `{ name, workerSource, guestSource?, config?, dependsOn? }` where `workerSource` is a pre-bundled ESM source string (loaded inside the worker via `data:text/javascript;base64,<...>` import after appending `\n//# sourceURL=sandbox-plugin:<name>`, so its stack-trace script name is `sandbox-plugin:<name>`) produced by the `?sandbox-plugin` vite transform at build time, `guestSource` is an OPTIONAL pre-bundled IIFE string evaluated as top-level guest script in Phase 2, and `config` is JSON-serializable data.
3. Send the worker an `init` message carrying `source`, `pluginDescriptors`, `filename`, `memoryLimit`, and `interruptHandler` (if any).
4. Inside the worker: topo-sort plugins by `dependsOn`, instantiate QuickJS WASM with WASI imports routed to mutable hook slots, invoke each plugin's `worker(ctx, deps, config)` in topo order to collect `PluginSetup`s, install `guestFunctions` as `vm.newFunction` bindings, populate `wasiHooks` slots, then run boot phases 2 (guest sources), 3 (delete private descriptor globals), 4 (user source).
5. Wait for the worker to reply with `ready` confirming all phases completed.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onEvent()` calls are routed to the worker.

The factory SHALL NOT accept `methods`, `onEvent`, `logger`, or `fetch` top-level options. All of these are plugin-level concerns.

The returned promise SHALL NOT resolve until the worker has reported `ready`. Any failure in phases 0-4 SHALL cause the worker to post `init-error`, dispose the VM, and `process.exit(0)`; the promise SHALL reject with the serialized error.

#### Scenario: Factory signature

- **GIVEN** a valid source string and a plugin list
- **WHEN** `sandbox({ source, plugins: [createWebPlatformPlugin(), createFetchPlugin(), ...] })` is called
- **THEN** the returned promise SHALL resolve with a `Sandbox` exposing `run`, `dispose`, and `onEvent`

#### Scenario: Construction rejects on plugin collision

- **GIVEN** two plugins in the composition both declaring `name: "timers"`
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject before any worker init completes
- **AND** the error SHALL identify the colliding plugin name

#### Scenario: Construction rejects on unsatisfied dependsOn

- **GIVEN** a plugin with `dependsOn: ["nonexistent"]` in the composition
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject
- **AND** the error SHALL identify the missing dependency

#### Scenario: Non-serializable plugin config rejected

- **GIVEN** a plugin descriptor whose `config` contains a function or class instance
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject with a serialization error identifying the offending config path

### Requirement: Boot phase sequence

The sandbox SHALL execute boot in phases:

- **Phase 0**: Load plugin worker modules from `descriptor.workerSource` by appending `\n//# sourceURL=sandbox-plugin:<name>` and importing the result via `data:text/javascript;base64,<...>` dynamic `import()` (the appended comment names the module `sandbox-plugin:<name>` in stack traces); topo-sort; instantiate WASM with WASI imports (mutable hook slots).
- **Phase 1**: For each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`; register `guestFunctions` via `vm.newFunction`; populate `wasiHooks` slots; store `exports`, hooks.
- **Phase 2**: For each plugin in topo order, if `descriptor.guestSource` is defined, `vm.evalCode(descriptor.guestSource, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
- **Phase 3**: For each guest function descriptor with `public !== true`, `delete globalThis[name]`.
- **Phase 4**: `vm.evalCode(userSource, filename)`.

Any failure at any phase SHALL dispose the VM, post `init-error`, `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private globals

- **GIVEN** a plugin with descriptors `{ name: "fetch", public: true }` and `{ name: "$internal", public: false }`
- **WHEN** phase 3 runs
- **THEN** `globalThis.fetch` SHALL remain accessible
- **AND** `globalThis["$internal"]` SHALL be deleted

#### Scenario: Plugin without guestSource skips phase 2 evaluation

- **GIVEN** a plugin whose descriptor omits `guestSource`
- **WHEN** phase 2 iterates to that plugin
- **THEN** no `vm.evalCode` call SHALL be made for it
- **AND** iteration SHALL continue to the next plugin without error
