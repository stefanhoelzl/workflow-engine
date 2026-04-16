## MODIFIED Requirements

### Requirement: WorkflowRegistry exposes workflows with actions and triggers

The `WorkflowRunner` interface SHALL include `invokeHandler(invocationId: string, triggerName: string, payload: unknown): Promise<HttpTriggerResult>` (adding `invocationId` as first parameter) and `onEvent(cb: (event: InvocationEvent) => void): void` (new method for event subscription).

#### Scenario: Registry exposes loaded workflows
- **WHEN** workflows are loaded
- **THEN** each `WorkflowRunner` SHALL expose `invokeHandler` accepting an invocation id, and `onEvent` for subscribing to sandbox events

#### Scenario: invokeHandler passes metadata to sandbox
- **WHEN** `invokeHandler(invocationId, triggerName, payload)` is called
- **THEN** it SHALL call `sb.run()` with the invocation id, workflow name, and workflow SHA from the manifest

## ADDED Requirements

### Requirement: buildSandboxSource appends action dispatcher

`buildSandboxSource` SHALL append a `globalThis.__dispatchAction` implementation as JavaScript source. The dispatcher SHALL:
1. Call `__emitEvent` with `action.request` (name and input)
2. Call `__hostCallAction(name, input)` for host-side input validation
3. Call `handler(input)` to run the user's action handler
4. Call `outputSchema.parse(rawOutput)` to validate the output
5. Call `__emitEvent` with `action.response` (name and output)
6. Return the validated output

On any error in steps 2-4, it SHALL call `__emitEvent` with `action.error` and re-throw.

#### Scenario: Dispatcher appended to source
- **WHEN** a workflow is loaded into the sandbox
- **THEN** the evaluated source SHALL include `globalThis.__dispatchAction` as a function that wraps action calls with event emission

#### Scenario: Successful action dispatch
- **WHEN** an action is called and validation, handler, and output parsing all succeed
- **THEN** the event stream SHALL contain `action.request`, `system.request`/`system.response` for `host.validateAction`, any bridge calls the handler makes, and `action.response`

#### Scenario: Validation failure emits action.error
- **WHEN** `__hostCallAction` throws a validation error
- **THEN** the event stream SHALL contain `action.request`, `system.request`/`system.error` for `host.validateAction`, and `action.error`

#### Scenario: Handler failure emits action.error
- **WHEN** the action handler throws
- **THEN** the event stream SHALL contain `action.request`, successful `host.validateAction` pair, and `action.error`

### Requirement: Bridge methods use named prefixes

When registering bridge methods, the workflow registry SHALL use human-readable method names: `host.validateAction` for `__hostCallAction`, `host.fetch` for `__hostFetch`.

#### Scenario: __hostCallAction registered as host.validateAction
- **WHEN** the `__hostCallAction` method is registered on the bridge
- **THEN** its bridge method name SHALL be `host.validateAction` so events appear with that name
