## ADDED Requirements

### Requirement: Safe globals — self

The sandbox SHALL expose `globalThis.self` as a reference to `globalThis` itself. The property SHALL NOT carry any capability beyond reference identity. This global is required by the WinterCG Minimum Common API for feature-detection compatibility with npm libraries.

#### Scenario: self reflects globalThis

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self === globalThis`
- **THEN** the result SHALL be `true`

#### Scenario: self has no additional capability

- **GIVEN** a sandbox
- **WHEN** guest code inspects the keys of `self`
- **THEN** the keys SHALL match those of `globalThis`

### Requirement: Safe globals — navigator

The sandbox SHALL expose `globalThis.navigator` as a frozen object containing a single string property `userAgent` whose value SHALL be `` `WorkflowEngine/${VERSION}` `` where `VERSION` is the `@workflow-engine/sandbox` package version. The object SHALL carry no methods, no other properties, and SHALL be non-extensible.

#### Scenario: navigator.userAgent is a version-stamped string

- **GIVEN** a sandbox constructed from `@workflow-engine/sandbox` version X
- **WHEN** guest code reads `navigator.userAgent`
- **THEN** the value SHALL be the string `` `WorkflowEngine/${X}` ``

#### Scenario: navigator is frozen

- **GIVEN** a sandbox
- **WHEN** guest code attempts `navigator.foo = "x"` or `Object.defineProperty(navigator, "foo", …)`
- **THEN** the assignment SHALL fail (silently in non-strict or with TypeError in strict)

### Requirement: Safe globals — reportError

The sandbox SHALL expose `globalThis.reportError(error)` as a guest-side shim that serializes the provided error into a JSON payload `{ name, message, stack?, cause? }` and invokes the `__reportError` host-bridge method. The shim SHALL NOT dispatch a local `ErrorEvent` (EventTarget is not yet shipped). The `cause` field SHALL be recursively serialized using the same schema when present.

This is a partial implementation of the WinterCG Minimum Common API `reportError` requirement; when EventTarget is shipped in a future round, the shim SHALL evolve to also `dispatchEvent(new ErrorEvent(...))` without breaking the bridge contract.

#### Scenario: reportError forwards serialized error to host

- **GIVEN** a sandbox whose `__reportError` host-side implementation captures calls
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the host implementation SHALL receive a payload with `name: "Error"`, `message: "oops"`, and a `stack` string

#### Scenario: reportError accepts non-Error values

- **GIVEN** a sandbox
- **WHEN** guest code calls `reportError("a string")`
- **THEN** the host implementation SHALL receive `{ name: "Error", message: "a string" }` (no stack)

### Requirement: __reportError host bridge

The sandbox SHALL accept a `__reportError(payload)` host method via the construction-time `methods` parameter and SHALL install it as a host-bridged global accessible from the guest. The method SHALL be write-only: the host implementation SHALL return nothing (or `undefined`) and no host state SHALL flow back to the guest through this bridge. The risk class is equivalent to the existing `console.log` channel.

`__reportError` MAY be overridden per run via `sandbox.run(name, ctx, { extraMethods: { __reportError } })`; the per-run override SHALL take precedence over the construction-time method for the duration of that run.

#### Scenario: Construction-time __reportError receives calls

- **GIVEN** `sandbox(src, { __reportError: (p) => captured.push(p) })`
- **WHEN** the guest `reportError` shim calls `__reportError(...)`
- **THEN** the construction-time implementation SHALL be invoked with the payload

#### Scenario: Per-run __reportError overrides construction-time

- **GIVEN** a sandbox constructed with a construction-time `__reportError` impl
- **AND** a `sandbox.run()` call with `extraMethods: { __reportError: runOnly }`
- **WHEN** the guest calls `__reportError(...)` during that run
- **THEN** `runOnly` SHALL be invoked
- **AND** the construction-time impl SHALL NOT be invoked

#### Scenario: No host state returns to guest

- **GIVEN** a sandbox
- **WHEN** guest code calls `const r = __reportError({message: "x"})`
- **THEN** `r` SHALL be `undefined`

## MODIFIED Requirements

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals: the host methods registered via `methods` / `extraMethods`, the built-in host-bridged globals (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `__hostFetch`, `__reportError`), the guest-side shims (`fetch`, `reportError`, `self`, `navigator`), and the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`).

Any addition to this allowlist SHALL be made in the same change proposal that amends `/SECURITY.md §2`, with a written rationale and threat assessment per surface added.

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

#### Scenario: WASM extension globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `structuredClone`
- **THEN** each SHALL be a defined global provided by the WASM extensions

#### Scenario: MCA shim globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `self`, `navigator.userAgent`, `reportError`
- **THEN** each SHALL be a defined global provided by the sandbox init sequence
