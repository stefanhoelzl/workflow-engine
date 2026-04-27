## MODIFIED Requirements

### Requirement: Core package has minimal dependencies

The `@workflow-engine/core` package SHALL depend on `zod` (runtime) and `libsodium-wrappers` (runtime, scoped to `secrets-crypto` and not transitively pulled into the sandbox bundle from the main entry). It SHALL NOT depend on vite, typescript, or any build tooling. JSON Schema validation inside `ManifestSchema` SHALL be implemented via Zod's own JSON-Schema rehydration capability; no separate JSON-Schema validation library SHALL appear in the dependency list.

#### Scenario: Core dependency list

- **WHEN** inspecting `packages/core/package.json` dependencies
- **THEN** it lists exactly `zod` and `libsodium-wrappers`
- **AND** it has no devDependencies related to build tooling

#### Scenario: SDK and runtime no longer depend on libsodium directly

- **WHEN** inspecting `packages/sdk/package.json` and `packages/runtime/package.json`
- **THEN** neither lists `libsodium-wrappers` in `dependencies` or `peerDependencies`
- **AND** any libsodium use in those packages SHALL be via `@workflow-engine/core/secrets-crypto`
