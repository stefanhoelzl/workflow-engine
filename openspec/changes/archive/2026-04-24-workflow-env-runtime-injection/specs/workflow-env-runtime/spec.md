## ADDED Requirements

### Requirement: RuntimeWorkflow interface

The `@workflow-engine/core` package SHALL export a `RuntimeWorkflow<Env>` interface describing the shape installed on the guest VM's `globalThis.workflow` at sandbox init. The interface SHALL be generic over the env record shape with a default of `Readonly<Record<string, string>>`.

```ts
export interface RuntimeWorkflow<
  Env extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> {
  readonly name: string;
  readonly env: Env;
}
```

The interface SHALL form the contract between plugins that install `globalThis.workflow` and SDK code that reads it.

#### Scenario: SDK defineWorkflow consumes the typed interface

- **GIVEN** a tenant workflow source calling `defineWorkflow({ env: { TOKEN: env({name:"TOKEN"}) } })`
- **WHEN** the SDK's `defineWorkflow` reads `globalThis.workflow`
- **THEN** it SHALL type-narrow from `RuntimeWorkflow` to the author's declared env shape
- **AND** `workflow.env.TOKEN` SHALL type as `string`
- **AND** `workflow.env.UNKNOWN` SHALL be a TypeScript compile-time error

#### Scenario: Plugin assigns a RuntimeWorkflow value

- **GIVEN** a plugin in the guest VM assigning `{ name: "wf", env: {} }` to `globalThis.workflow`
- **WHEN** the plugin typechecks against `RuntimeWorkflow`
- **THEN** the assignment SHALL compile without errors

### Requirement: RuntimeSecrets interface

The core package SHALL export a `RuntimeSecrets` interface describing the shape installed on `globalThis.$secrets`. The interface SHALL expose one method:

```ts
export interface RuntimeSecrets {
  addSecret(value: string): void;
}
```

The interface exists as part of the contract even if no plugin installs `$secrets` in this change. The workflow-secrets change implements the installer.

#### Scenario: RuntimeSecrets is exported from core

- **WHEN** a consumer imports `{ RuntimeSecrets }` from `@workflow-engine/core`
- **THEN** the import SHALL succeed with the interface definition above

### Requirement: GuestGlobals aggregate interface

The core package SHALL export a `GuestGlobals` interface aggregating every runtime-installed guest global as named properties:

```ts
export interface GuestGlobals {
  workflow: RuntimeWorkflow;
  $secrets: RuntimeSecrets;
}
```

`GuestGlobals` SHALL serve as the single type definition for the full set of runtime-installed globals. Adding a future global SHALL require exactly one field addition to `GuestGlobals`.

#### Scenario: GuestGlobals keys match global identifiers

- **GIVEN** the `GuestGlobals` interface
- **THEN** each key in `GuestGlobals` SHALL correspond to the exact name of a `globalThis.*` identifier the runtime installs
- **AND** each value type SHALL describe the shape of that identifier

### Requirement: Ambient global type augmentation

The core package SHALL augment the TypeScript ambient global scope so that `globalThis.workflow` and `globalThis.$secrets` are typed correctly across all consumers that import from core.

```ts
declare global {
  var workflow: GuestGlobals["workflow"];
  var $secrets: GuestGlobals["$secrets"];
}
```

Consumers reading these globals SHALL receive the types defined in `GuestGlobals` without `any` casts.

#### Scenario: SDK reads typed globalThis.workflow

- **GIVEN** SDK code that reads `globalThis.workflow.env.X`
- **WHEN** the code is type-checked
- **THEN** `globalThis.workflow` SHALL type as `RuntimeWorkflow<Readonly<Record<string, string>>>`
- **AND** `globalThis.workflow.env` SHALL type as `Readonly<Record<string, string>>`

### Requirement: installGuestGlobals helper

The core package SHALL export `installGuestGlobals(globals: Partial<GuestGlobals>): void`. The helper SHALL install each provided key onto `globalThis` via `Object.defineProperty` with `writable: false` and `configurable: false`. The helper SHALL accept a partial of `GuestGlobals` so plugins may contribute subsets.

```ts
export function installGuestGlobals(globals: Partial<GuestGlobals>): void {
  for (const key of Object.keys(globals) as (keyof GuestGlobals)[]) {
    Object.defineProperty(globalThis, key, {
      value: globals[key],
      writable: false,
      configurable: false,
    });
  }
}
```

#### Scenario: installGuestGlobals installs workflow key

- **GIVEN** a call `installGuestGlobals({ workflow: { name: "wf", env: {} } })`
- **WHEN** the call returns
- **THEN** `globalThis.workflow` SHALL equal `{ name: "wf", env: {} }`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, "workflow").writable` SHALL be `false`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, "workflow").configurable` SHALL be `false`

#### Scenario: installGuestGlobals accepts partial

- **GIVEN** a call `installGuestGlobals({ workflow: { name: "wf", env: {} } })` that omits `$secrets`
- **WHEN** the call returns
- **THEN** `globalThis.workflow` SHALL be installed
- **AND** `globalThis.$secrets` SHALL remain `undefined`

#### Scenario: Second install of the same key throws

- **GIVEN** `installGuestGlobals({ workflow: X })` has already been called
- **WHEN** `installGuestGlobals({ workflow: Y })` is called again
- **THEN** the second call SHALL throw a `TypeError` because the property is non-configurable

### Requirement: Env-installer plugin mutates workflow.env per invocation

The runtime SHALL provide an `env-installer` plugin that:

1. At Phase 2 (guest source), calls `installGuestGlobals({ workflow: { name, env: envObject } })` where `envObject` is a mutable module-scoped `Record<string, string>` and `name` is read from a closure variable.
2. At `onBeforeRunStarted` (worker-side), invokes a registered guest function `$env/populate(name, envStrings)` via host→guest call. The guest function SHALL mutate `envObject` in place: first delete all existing keys, then assign each entry from `envStrings`, and set the closure name variable.
3. At `onRunFinished` (worker-side), invokes a registered guest function `$env/clear()` via host→guest call. The guest function SHALL delete all keys from `envObject` and reset the closure name variable.

The plugin SHALL read `envStrings` from the run context (`ctx.envStrings = manifest.env`) passed into the sandbox via the `run` message.

#### Scenario: Populate before handler

- **GIVEN** a run with `manifest.env = { TOKEN: "ghp_xxx", REGION: "us-east-1" }` and `manifest.name = "wf"`
- **WHEN** the env-installer plugin's `onBeforeRunStarted` fires
- **THEN** `globalThis.workflow.env.TOKEN` SHALL equal `"ghp_xxx"`
- **AND** `globalThis.workflow.env.REGION` SHALL equal `"us-east-1"`
- **AND** `globalThis.workflow.name` SHALL equal `"wf"`

#### Scenario: Clear after handler

- **GIVEN** an `onBeforeRunStarted` populated `workflow.env` with entries
- **WHEN** `onRunFinished` fires
- **THEN** `globalThis.workflow.env` SHALL have no own keys
- **AND** `globalThis.workflow.name` SHALL equal `""`

#### Scenario: Consecutive runs see fresh env values

- **GIVEN** run 1 populated `workflow.env = { TOKEN: "v1" }` and completed
- **WHEN** run 2 fires with `manifest.env = { TOKEN: "v2", EXTRA: "x" }`
- **THEN** after `onBeforeRunStarted` for run 2, `globalThis.workflow.env.TOKEN` SHALL equal `"v2"`
- **AND** `globalThis.workflow.env.EXTRA` SHALL equal `"x"`
- **AND** no stale keys from run 1 SHALL remain
