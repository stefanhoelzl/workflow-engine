## MODIFIED Requirements

### Requirement: Workflow loading instantiates one sandbox per workflow

The runtime SHALL load each workflow's manifest, read the per-workflow bundle file path from `manifest.module`, and instantiate exactly one `Sandbox` per workflow with that bundle source. The sandbox SHALL be created via `sandbox(source, methods)` where `methods` includes the `__hostCallAction` bridge implementation scoped to the workflow's actions. The runtime SHALL append JS source to the bundle that, after the bundle IIFE has evaluated, captures `__hostCallAction` and `__emitEvent` into an IIFE closure, installs a locked `__dispatchAction` global via `Object.defineProperty({writable: false, configurable: false})`, and deletes the captured names from `globalThis`.

The runtime SHALL NOT append any additional source for action-name binding (action names are baked into each `action({...})` call at build time by the vite-plugin) or for trigger-handler shimming (trigger values are themselves callable per the `http-trigger` capability; `Sandbox.run(triggerExportName, payload, ctx)` invokes them directly).

After sandbox initialization completes, the `__hostCallAction` and `__emitEvent` names SHALL NOT be present on `globalThis` from guest code's perspective; the dispatcher holds its own captured references for the life of the VM.

#### Scenario: One sandbox created per loaded workflow

- **GIVEN** two workflows `cronitor` and `notify` discovered at startup
- **WHEN** workflow loading completes
- **THEN** exactly two `Sandbox` instances SHALL exist, one per workflow
- **AND** each sandbox SHALL have the workflow's bundle evaluated

#### Scenario: __hostCallAction bound to workflow's manifest

- **GIVEN** a workflow with actions `a` and `b` in its manifest
- **WHEN** the sandbox is created
- **THEN** the host-side `__hostCallAction(name, input)` implementation passed via `methods` SHALL look up `name` in the workflow's manifest action list
- **AND** SHALL throw if `name` is not declared

#### Scenario: Post-init surface hides host-bridge names

- **GIVEN** a loaded workflow whose sandbox initialization has completed
- **WHEN** guest code in the workflow evaluates `typeof globalThis.__hostCallAction` and `typeof globalThis.__emitEvent`
- **THEN** both expressions SHALL evaluate to `"undefined"`
- **AND** `typeof globalThis.__dispatchAction` SHALL evaluate to `"function"`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, "__dispatchAction").writable` SHALL be `false`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, "__dispatchAction").configurable` SHALL be `false`

#### Scenario: Trigger invocation uses the export name directly

- **GIVEN** a workflow with a trigger exported as `myTrigger`
- **WHEN** the runtime invokes the trigger via `WorkflowRunner.invokeHandler`
- **THEN** the runtime SHALL call `Sandbox.run("myTrigger", payload, ctx)` (the user's export name, no shim prefix)
- **AND** `Sandbox.run` SHALL invoke `globalThis[IIFE_NAMESPACE].myTrigger(payload)` since the trigger value is itself callable
