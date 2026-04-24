## ADDED Requirements

### Requirement: secret() factory registers runtime plaintexts

The SDK SHALL export a `secret(value: string): string` function. When called inside a handler, it SHALL register `value` with the runtime's plaintext scrubber set (via `globalThis.$secrets.addSecret(value)`) and return `value` unchanged. The same `value` MAY be registered multiple times without error; duplicates are de-duplicated in the scrubber set.

After registration, any subsequent occurrence of the exact string `value` in any outbound `WorkerToMain` message (events, done payload, logs) SHALL be replaced with `[secret]` by the secrets plugin's `onPost` hook.

#### Scenario: secret() returns input unchanged

- **WHEN** `const x = secret("hello")` is evaluated inside a handler
- **THEN** `x` SHALL equal `"hello"`

#### Scenario: Registered value is scrubbed from events

- **GIVEN** a handler that calls `secret("myvalue")` and then `console.log("check myvalue here")`
- **WHEN** the run completes and events are archived
- **THEN** the archived `console` event's message SHALL contain `"check [secret] here"` in place of `"myvalue"`

#### Scenario: Registered value is scrubbed from return values

- **GIVEN** a trigger handler that calls `secret("x")` and returns `{ body: "result with x" }`
- **WHEN** the run completes and the `done` message is posted
- **THEN** the archived `trigger.response` event body SHALL contain `"result with [secret]"`

#### Scenario: secret() before the log

- **GIVEN** a handler that calls `console.log(value)` BEFORE `secret(value)`
- **WHEN** the log event is archived
- **THEN** the archived log MAY contain the plaintext (scrubbing applies only to messages posted AFTER registration)

### Requirement: env({secret: true}) rejects default at type level

The SDK's `env()` factory SHALL have type overloads enforcing that `default` cannot coexist with `secret: true`. Calling `env({ default: "x", secret: true })` SHALL be a TypeScript compile-time error. `env({ secret: true })` alone SHALL be valid; the `name` field SHALL default to the key name when assigned into `defineWorkflow({ env })`.

The return value of `env({ secret: true })` SHALL be a branded `SecretEnvRef` distinct from `EnvRef` (non-secret). Both are internal types; author code only sees `string` at `workflow.env.X` access.

#### Scenario: secret true with default fails type-check

- **GIVEN** `env({ name: "TOKEN", default: "x", secret: true })`
- **WHEN** the workflow file is type-checked
- **THEN** TypeScript SHALL emit a compile error rejecting the overload
- **AND** the error message SHALL indicate that `default` is incompatible with `secret: true`

#### Scenario: secret true without default is valid

- **GIVEN** `env({ name: "TOKEN", secret: true })`
- **WHEN** the workflow is type-checked and built
- **THEN** no type error SHALL occur
- **AND** the build pass SHALL route `TOKEN` to `manifest.secretBindings`

#### Scenario: Returned value brands as SecretEnvRef

- **GIVEN** `const ref = env({ name: "X", secret: true })`
- **WHEN** the type of `ref` is inspected
- **THEN** it SHALL be `SecretEnvRef`, not `EnvRef`

### Requirement: Workflow runtime secrets plugin implements lifecycle hooks

The runtime SHALL provide a `secrets` plugin replacing the `env-installer` plugin from the workflow-env-runtime-injection capability. The `secrets` plugin SHALL perform all of the env-installer's duties plus the following:

1. Install `globalThis.$secrets = { addSecret(value: string): void }` via `installGuestGlobals` at Phase 2. `addSecret` SHALL be a guest function that dispatches to the plugin's worker-side `plaintexts.add(value)` (resorting the longest-first cache).
2. On `onBeforeRunStarted(ctx)`, initialize `plaintexts` from `Object.values(ctx.plaintextStore)` (the decrypted secrets from the executor). Sort by descending length.
3. Host→guest call `$secrets/populate(name, envStrings, plaintextStore)` populates `globalThis.workflow.env` with the union of `envStrings` (from manifest.env, per prior change) AND `plaintextStore` (from decrypted manifest.secrets). Secret and non-secret env values SHALL be indistinguishable in the final `workflow.env` record.
4. Implement `onPost(msg)` that walks every string leaf of `msg`, replacing each plaintext literal (longest-first) with `[secret]`. Returns the transformed message.
5. On `onRunFinished()`, host→guest call `$secrets/clear()` (clears `workflow.env` and resets name) AND clear the worker-side `plaintexts` set.

The sandbox composition SHALL include `secrets` in place of `env-installer`. Both plugins SHALL NOT coexist.

#### Scenario: Plaintext in fetch.request event is redacted

- **GIVEN** a handler that calls `fetch("https://api", { headers: { Authorization: `Bearer ${workflow.env.TOKEN}` } })` where `workflow.env.TOKEN === "ghp_abc"`
- **WHEN** the handler completes and events archive
- **THEN** the archived `fetch.request` event's headers SHALL contain `"Bearer [secret]"`
- **AND** SHALL NOT contain `"ghp_abc"` anywhere

#### Scenario: Plaintext reaches external network

- **GIVEN** the same fetch call
- **WHEN** `hardenedFetch` sends the request to the third-party API
- **THEN** the on-wire `Authorization` header SHALL be `"Bearer ghp_abc"` (real plaintext)
- **AND** the third-party API SHALL receive the intended credential

#### Scenario: secret() registers at runtime and subsequent log is scrubbed

- **GIVEN** a handler doing `const sig = secret(computeSig(...))` and then `console.log("sig=" + sig)`
- **WHEN** the run completes
- **THEN** the archived log SHALL contain `"sig=[secret]"`

#### Scenario: Longest-first ordering prevents partial overlap

- **GIVEN** plaintexts `"alpha"` and `"alphabet"` both in the set
- **WHEN** a message containing `"my alphabet soup"` is scrubbed
- **THEN** the output SHALL contain `"my [secret] soup"` (matching `"alphabet"` first)
- **AND** SHALL NOT contain `"my [secret]bet soup"` (which would result from shorter-first)

#### Scenario: Scrubber does not alter messages when no secrets are registered

- **GIVEN** a run with no secrets in manifest and no `secret()` calls
- **WHEN** events flow through `onPost`
- **THEN** the messages SHALL pass through unchanged

### Requirement: Derived plaintext values bypass the scrubber

The scrubber SHALL perform literal-string replacement only. Author-side transformations of plaintexts (base64, hex, slice, hash, reverse, case change) SHALL NOT be detected.

Tenants needing to protect transformed values SHALL pass them through `secret(derivedValue)` explicitly.

This SHALL be documented as a known limitation.

#### Scenario: Base64-encoded plaintext is not scrubbed

- **GIVEN** a handler doing `console.log(btoa(workflow.env.TOKEN))` where `TOKEN = "ghp_xxx"`
- **WHEN** the log event archives
- **THEN** the archived message MAY contain the base64 of `"ghp_xxx"`
- **AND** this is an acceptable documented limitation

#### Scenario: Author wraps derivation via secret()

- **GIVEN** a handler doing `const enc = secret(btoa(workflow.env.TOKEN))` followed by `console.log(enc)`
- **WHEN** the log event archives
- **THEN** the archived message SHALL contain `[secret]` in place of the base64 value
