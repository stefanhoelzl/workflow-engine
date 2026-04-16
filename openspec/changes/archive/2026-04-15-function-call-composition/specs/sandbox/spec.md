## ADDED Requirements

### Requirement: __hostCallAction bridge global

The sandbox SHALL install a host-bridge global `__hostCallAction(actionName, input)` available to guest code. The global SHALL accept the action's name (string) and its input (JSON-serializable value). The host SHALL: validate `input` against the action's declared input JSON Schema (from the manifest); on success, emit an audit-log entry and return `undefined`. The host SHALL NOT dispatch the action's handler — the SDK's in-sandbox callable is the sole dispatcher, via a direct JS function call in the same QuickJS context. On input-validation failure, the host SHALL throw a serializable error back into the calling guest context.

The new global SHALL be installed alongside the existing host-bridged globals (`console`, timers, `performance`, `crypto`, `__hostFetch`) at sandbox construction time. It SHALL count as one additional surface in the host-bridge JSON-marshaled boundary documented in `/SECURITY.md §2`.

#### Scenario: Action dispatched in same sandbox via SDK wrapper

- **GIVEN** a workflow with two actions `a` and `b` loaded into one sandbox
- **AND** `a`'s handler calls `await b(input)` (the SDK callable)
- **WHEN** `a` is running
- **THEN** the SDK wrapper SHALL call `__hostCallAction("b", input)` which the host handles by validating input and audit-logging
- **AND** the SDK wrapper SHALL invoke `b`'s handler via a direct JS function call in the same QuickJS context
- **AND** the SDK wrapper SHALL validate the handler's return value against `b`'s output Zod schema using the bundled Zod
- **AND** the validated result SHALL be returned to `a`'s caller

#### Scenario: Input validation failure throws into caller; handler does not run

- **GIVEN** action `b` with `input: z.object({ x: z.number() })`
- **WHEN** the SDK wrapper invokes `__hostCallAction("b", { x: "not a number" })`
- **THEN** the host SHALL throw a validation error across the bridge
- **AND** `b`'s handler SHALL NOT execute
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Output validation failure throws into caller

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** the SDK wrapper invokes `b(validInput)`
- **THEN** the host bridge call SHALL succeed (input is valid)
- **AND** the handler SHALL execute and return `42`
- **AND** the SDK wrapper SHALL call the output schema's `.parse(42)` which throws
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Action handler exception propagates as rejection

- **GIVEN** action `b` whose handler throws `new Error("boom")`
- **WHEN** the SDK wrapper invokes `b(validInput)`
- **THEN** the host bridge call SHALL succeed
- **AND** the handler SHALL throw inside the sandbox
- **AND** the SDK wrapper SHALL let the rejection propagate to the caller

#### Scenario: Bridge is JSON-marshaled

- **GIVEN** an action input crossing the bridge
- **WHEN** input crosses the host/sandbox boundary
- **THEN** values SHALL be JSON-serializable (objects, arrays, primitives, `null`)
- **AND** non-serializable values (functions, symbols, classes) SHALL produce a serialization error

### Requirement: Action call host wiring

The runtime SHALL register `__hostCallAction` per-workflow at sandbox construction time. The host implementation SHALL look up the called action by name in the workflow's manifest, validate the input against the JSON Schema from the manifest, audit-log the invocation, and return. The host SHALL NOT invoke the handler — dispatch is performed by the SDK wrapper inside the sandbox.

#### Scenario: Unknown action name throws

- **GIVEN** a workflow whose manifest does not contain an action named `"missing"`
- **WHEN** the guest calls `__hostCallAction("missing", input)`
- **THEN** the host SHALL throw an error indicating the action is not declared in the manifest
