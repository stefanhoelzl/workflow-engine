## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Env-installer plugin mutates workflow.env per invocation

**Reason**: The `env-installer` plugin introduced in the workflow-env-runtime-injection change is subsumed by the new `secrets` plugin. `secrets` installs `globalThis.workflow` (replacing env-installer's role) AND `globalThis.$secrets`, merges `plaintextStore` into `workflow.env` alongside `envStrings`, implements the scrubber via `onPost`, and clears both on run end. The env-installer plugin file SHALL be deleted; the sandbox production composition SHALL use `secrets` in its slot.

**Migration**: The `secrets` plugin's `$secrets/populate(name, envStrings, plaintextStore)` and `$secrets/clear()` guest functions replace `env-installer`'s `$env/populate` and `$env/clear`. Tests for `env-installer` behavior SHALL be migrated to cover the `secrets` plugin's equivalent paths. Sandbox composition in `sandbox-store.ts` swaps the plugin.
