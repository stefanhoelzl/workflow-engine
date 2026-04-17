## MODIFIED Requirements

### Requirement: Action call resolution at build time

The plugin SHALL resolve `await someAction(input)` calls inside handlers by assigning the action's export name to the callable, so that the callable can dispatch correctly at runtime. The plugin SHALL discover each action export by brand-symbol check on the export value (`ACTION_BRAND`), detect aliased action exports (the same Action object exported under multiple names), and call `__setActionName(exportName)` on each Node-side Action instance. This build-time binding SHALL be used for manifest derivation (populating `manifest.actions[*].name`) and for rejecting aliased exports. The plugin SHALL NOT rewrite the callable's source body at build time; the SDK's `action()` factory produces a callable whose body dispatches via `core.dispatchAction()` → `globalThis.__dispatchAction(name, input, handler, outputSchema)`, and that structure SHALL remain intact through the build.

Because the sandbox re-evaluates the bundled SDK source inside a fresh QuickJS context at load time, the VM-side SDK closure is a distinct instance from the Node-side instance the plugin bound. The runtime SHALL append a name-binder shim to the bundle (see the `workflow-loading` capability) that calls `__setActionName(exportName)` at sandbox evaluation time to bind the VM-side closure. After the runtime binder shim completes, the `__setActionName` property SHALL be deleted from each action callable.

#### Scenario: Plugin binds Node-side action names for manifest derivation

- **GIVEN** `export const sendNotification = action({...})` in workflow file `cronitor.ts`
- **WHEN** the plugin walks exports
- **THEN** the plugin SHALL call `sendNotification.__setActionName("sendNotification")` on the Node-side Action instance
- **AND** the resulting manifest SHALL contain an action entry with `name: "sendNotification"`

#### Scenario: Aliased action export fails the build

- **GIVEN** a workflow file that exports the same Action object under two different names (`export const a = ...; export { a as b }`)
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error indicating the action is exported under multiple names

#### Scenario: Callable dispatches through the dispatcher at runtime

- **GIVEN** `await sendNotification({ message: "x" })` inside a trigger handler
- **WHEN** the compiled bundle is loaded into a sandbox and the trigger handler runs
- **THEN** the action callable SHALL reach `globalThis.__dispatchAction("sendNotification", { message: "x" }, handler, outputSchema)` via `core.dispatchAction()`
- **AND** the dispatcher SHALL run the captured host-bridge call to `__hostCallAction`, invoke the handler in-sandbox, validate the output, and return the validated result
