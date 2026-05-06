## MODIFIED Requirements

### Requirement: Action output validated at the host-side bridge handler

The action-dispatch plugin's guest-function-descriptor handler for `__sdkDispatchAction` SHALL, after the captured `handler(input)` guest callable resolves with a raw value, validate the raw value against the action's declared output schema using the host-side validator exported by the `host-call-action` plugin (`validateActionOutput(name, raw)`). The validator's underlying schema SHALL be a single instance constructed once at plugin boot from the manifest's per-action output schema, reused for every action invocation for the lifetime of the sandbox. Per-request validator construction is forbidden. Validation SHALL run on the host before the dispatcher handler resolves to the guest caller. Validation failure SHALL throw a `ValidationError` (carrying the same `issues` array shape used by input validation) back into the guest caller; the guest SHALL observe the throw as a rejection of its `await __sdk.dispatchAction(...)` call.

Output validation SHALL NOT run inside the sandbox. The SDK's `action()` callable SHALL NOT construct or pass a `completer` closure for output validation; the `__sdk.dispatchAction` surface SHALL accept `(name, input, handler)` and SHALL NOT accept a `completer` argument.

#### Scenario: Invalid action output throws into caller host-side

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host-side input validation SHALL succeed (input is valid)
- **AND** `b`'s handler SHALL execute and return `42`
- **AND** the action-dispatch plugin's dispatcher handler SHALL invoke `validateActionOutput("b", 42)` on the host
- **AND** the host-side validator SHALL throw a ValidationError whose `issues` array describes the type mismatch
- **AND** the rejection SHALL propagate to the guest caller before any value is returned from `__sdk.dispatchAction`

#### Scenario: Valid action output flows through unchanged

- **GIVEN** action `b` with `output: z.string()` whose handler returns `"ok"`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host-side validator SHALL return the validated value
- **AND** the dispatcher handler SHALL resolve to `"ok"` and the caller SHALL receive `"ok"`

#### Scenario: Guest cannot supply a lenient validator

- **GIVEN** a tampered SDK bundle that attempts to pass a no-op closure as a fourth `completer` argument to `__sdk.dispatchAction`
- **WHEN** the call is dispatched
- **THEN** the action-dispatch plugin's handler SHALL ignore any extra argument
- **AND** output validation SHALL still run host-side via `validateActionOutput(name, raw)`
- **AND** a return value that does not match the declared output schema SHALL still throw
