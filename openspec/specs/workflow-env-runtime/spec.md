# workflow-env-runtime Specification

## Purpose

Define the runtime-installed guest globals (`globalThis.workflow`, `globalThis.$secrets`) that expose build-time-resolved env values and the secrets API to workflow code executing inside the QuickJS sandbox. This capability owns the cross-package type contract (`RuntimeWorkflow`, `RuntimeSecrets`, `GuestGlobals`) in `@workflow-engine/core`, the `installGuestGlobals` helper that plugins use to mount these globals with non-writable/non-configurable property descriptors, and the runtime's `env-installer` plugin that populates `workflow.env` from the manifest on every invocation.

## Requirements

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

The runtime's `secrets` plugin SHALL install this shape at sandbox init, backing `addSecret` with a guest-function call that dispatches to a host-side handler adding `value` to the plugin's worker-side plaintext-scrubber set.

When the `secrets` plugin is absent (e.g., in a test sandbox composition), `globalThis.$secrets` SHALL be undefined, and SDK helpers calling `$secrets.addSecret` SHALL gracefully no-op rather than throw.

#### Scenario: RuntimeSecrets is exported from core

- **WHEN** a consumer imports `{ RuntimeSecrets }` from `@workflow-engine/core`
- **THEN** the import SHALL succeed with the interface definition above

#### Scenario: $secrets.addSecret registers a value

- **GIVEN** a sandbox with the secrets plugin active
- **WHEN** guest code invokes `globalThis.$secrets.addSecret("abc")`
- **THEN** the plugin's worker-side plaintext set SHALL include `"abc"`
- **AND** subsequent `onPost` invocations SHALL redact `"abc"` from outbound messages

#### Scenario: Multiple registrations of same value dedupe

- **GIVEN** repeated calls `$secrets.addSecret("x"); $secrets.addSecret("x")`
- **WHEN** the scrubber runs
- **THEN** `"x"` SHALL be redacted (whether stored once or twice is an implementation detail)

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

The per-invocation population of `globalThis.workflow` (including the union of `manifest.env` and decrypted secret plaintexts) is owned by the `secrets` plugin defined in the `workflow-secrets` capability.

### Requirement: Build-time globalThis.workflow.env carries sentinel strings for secret entries

In the Vite plugin's Node VM discovery context (where the workflow IIFE is evaluated to extract the manifest), the SDK's `defineWorkflow` build-time branch SHALL populate each secret entry of the returned `wf.env` record with a sentinel string produced by `encodeSentinel(ref.name ?? key)`, where `ref` is the `SecretEnvRef` from `config.env` and `key` is its property-key.

This replaces the current build-time behavior of skipping secret entries (which left `wf.env.SECRET_X === undefined`). The change is localized to the SDK's build-time env resolver; no new runtime global is introduced and the sandbox-side `globalThis.workflow` installation (performed by the `secrets` plugin with decrypted plaintext values for secret entries) is unchanged.

The `RuntimeWorkflow<Env>` interface in `@workflow-engine/core` is unchanged: `env` is still typed `Readonly<Record<string, string>>`. Sentinel values are valid `string` instances; no type-system changes are required.

#### Scenario: Build-time access returns a sentinel string

- **GIVEN** a workflow `defineWorkflow({ env: { TOKEN: env({ secret: true }) } })` evaluated in the Vite plugin's Node VM
- **WHEN** the build-time code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL be a `string`
- **AND** the returned value SHALL equal `encodeSentinel("TOKEN")` (byte-for-byte `"\x00secret:TOKEN\x00"`)

#### Scenario: Sandbox runtime access is unchanged

- **GIVEN** the `secrets` plugin has installed `globalThis.workflow = { name, env: { TOKEN: "plaintext_value" } }` (frozen, non-configurable) in the sandbox
- **WHEN** guest code reads `workflow.env.TOKEN` or `wf.env.TOKEN` (the latter via `defineWorkflow`'s runtime branch)
- **THEN** the returned value SHALL equal `"plaintext_value"`
- **AND** the value SHALL NOT contain the byte sequence `\x00secret:`
