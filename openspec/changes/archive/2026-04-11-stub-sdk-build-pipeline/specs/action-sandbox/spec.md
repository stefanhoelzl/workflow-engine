## MODIFIED Requirements

### Requirement: Sandbox interface

The system SHALL provide a `Sandbox` interface with a `spawn` method:

```
spawn(source: string, ctx: ActionContext, options?: SpawnOptions): Promise<SandboxResult>
```

Where `SpawnOptions` includes:
- `signal?: AbortSignal` — accepted but not acted upon
- `filename?: string` — filename for error stack traces (defaults to `"action.js"`)
- `exportName?: string` — the named export to extract from the module (defaults to `"default"`)

The `createSandbox()` factory SHALL instantiate the QuickJS WASM module once and return a `Sandbox` object. Each `spawn()` call SHALL create a fresh QuickJS context from the shared module.

#### Scenario: Sandbox created at startup

- **GIVEN** the runtime starting up
- **WHEN** `createSandbox()` is called
- **THEN** a `Sandbox` object is returned with a `spawn` method
- **AND** the QuickJS WASM module is instantiated once

#### Scenario: Spawn executes action in fresh context

- **GIVEN** a `Sandbox` instance
- **WHEN** `spawn(source, ctx)` is called twice with different sources
- **THEN** each invocation runs in its own QuickJS context
- **AND** no state leaks between invocations

### Requirement: Action source as ES module

The sandbox SHALL evaluate action source code as an ES module using `vm.evalCode(source, filename, { type: "module" })`. The sandbox SHALL extract the handler function from the module namespace using `vm.getProp(moduleNamespace, exportName)` where `exportName` comes from `SpawnOptions` (defaulting to `"default"`). The handler SHALL be called with the bridged ctx object.

#### Scenario: Named export handler called

- **GIVEN** source code containing `var sendMessage = async (ctx) => { await ctx.emit("done", {}) }; export { sendMessage };`
- **AND** `options.exportName` is `"sendMessage"`
- **WHEN** `spawn(source, ctx, options)` is called
- **THEN** the `sendMessage` export is extracted from the module namespace and called with the QuickJS ctx handle
- **AND** `ctx.emit("done", {})` bridges to the host

#### Scenario: Default export handler called (backward compatibility)

- **GIVEN** source code `export default async (ctx) => { await ctx.emit("done", {}) }`
- **AND** no `exportName` is specified in options
- **WHEN** `spawn(source, ctx)` is called
- **THEN** the default export function is extracted and called with the QuickJS ctx handle
- **AND** `ctx.emit("done", {})` bridges to the host

#### Scenario: Module with bundled dependencies

- **GIVEN** source code that includes inlined npm library code and a named export handler that uses it
- **WHEN** `spawn(source, ctx, { exportName: "myAction" })` is called
- **THEN** the module evaluates successfully including the inlined library code
- **AND** the named export handler executes correctly using the library functions

