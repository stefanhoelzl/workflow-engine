## ADDED Requirements

### Requirement: SANDBOX_MAX_COUNT config variable

`createConfig` SHALL accept an optional `SANDBOX_MAX_COUNT` environment variable. Its value SHALL be coerced from string to a positive integer. It SHALL default to `10` when not provided. The parsed value SHALL be exposed on the returned config object as `sandboxMaxCount: number`.

The variable is non-secret and is intentionally visible in pod specifications for auditability (consistent with the existing `AUTH_ALLOW` carve-out); it SHALL NOT be wrapped by `createSecret`.

Semantically, `sandboxMaxCount` is the soft cap on resident `(owner, workflow.sha)` sandboxes held by the runtime's sandbox cache (see `executor/spec.md` "Sandbox cache is bounded by SANDBOX_MAX_COUNT"). The runtime SHALL pass this value through to `createSandboxStore`.

#### Scenario: Default value

- **WHEN** `createConfig` is called with an environment that does NOT set `SANDBOX_MAX_COUNT`
- **THEN** the returned config SHALL have `sandboxMaxCount` equal to `10`

#### Scenario: Explicit value parsed

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "25" }`
- **THEN** the returned config SHALL have `sandboxMaxCount` equal to `25` (number)

#### Scenario: Non-numeric value rejected

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "abc" }`
- **THEN** it SHALL throw a validation error

#### Scenario: Non-positive value rejected

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "0" }` or `{ SANDBOX_MAX_COUNT: "-3" }`
- **THEN** it SHALL throw a validation error
