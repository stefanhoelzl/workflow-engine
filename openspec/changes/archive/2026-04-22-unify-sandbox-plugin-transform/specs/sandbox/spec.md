## MODIFIED Requirements

### Requirement: Boot phase sequence

The sandbox SHALL execute boot in phases:

- **Phase 0**: Load plugin worker modules from `descriptor.workerSource` via `data:text/javascript;base64,<...>` dynamic `import()`; topo-sort; instantiate WASM with WASI imports (mutable hook slots).
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
