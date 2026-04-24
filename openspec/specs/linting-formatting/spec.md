# Linting + Formatting Specification

## Purpose

Own the repository's linter + formatter configuration (Biome) and the `pnpm lint` / `pnpm format` scripts. Biome is chosen as a single tool covering both linting (incl. type-adjacent checks) and formatting for TypeScript, JSON, and JSONC files; Terraform files are formatted by `tofu fmt` (see `infrastructure`).

## Requirements

### Requirement: Biome configuration at repository root
A `biome.jsonc` at the repository root SHALL configure Biome as the project's linter and formatter. JSONC (JSON with Comments) is used so that every disabled rule can carry an inline justification.

#### Scenario: Single config file
- **WHEN** inspecting the repository root
- **THEN** a `biome.jsonc` file SHALL exist and be the only linting/formatting config

### Requirement: All recommended linter rules enabled
Biome SHALL be configured with every recommended rule enabled across all groups. Biome 2.x does not support a repository-wide `"all": true` switch (the historic 1.x form was removed); the spec therefore fixes the surface at "recommended per group" with explicit per-rule enablement for non-recommended rules when the codebase wants them.

#### Scenario: Rule configuration
- **WHEN** inspecting `biome.jsonc`
- **THEN** each rule group (`a11y`, `complexity`, `correctness`, `performance`, `security`, `style`, `suspicious`) SHALL be enabled at error severity — either by the shorthand string form (`"group": "error"`, which is equivalent to `{ "recommended": true }` at error level) or by the explicit `{ "recommended": true, ... }` object form when the group also carries per-rule overrides
- **AND** new rules that Biome subsequently promotes to the `recommended` set SHALL therefore become active automatically on the next Biome upgrade

#### Scenario: Individual rule overrides
- **WHEN** a specific rule proves too noisy or inapplicable for a code region
- **THEN** it SHALL be disabled individually in `biome.jsonc` (either at the top-level `linter.rules` object or in an `overrides[]` entry scoped to the relevant `includes` glob)
- **AND** the disable SHALL carry an inline `//` comment above it explaining the reason (mirroring the `biome-ignore` in-source convention)

### Requirement: Formatter configuration
Biome SHALL handle all code formatting with consistent settings.

#### Scenario: Formatting defaults
- **WHEN** inspecting `biome.jsonc`
- **THEN** the formatter SHALL be enabled for the entire repository with Biome's defaults (tabs for indentation, 80-char line width, LF line endings, double quotes for JS/TS strings)

### Requirement: Lint script
A root `lint` script SHALL run Biome's combined `check` command across the repository, failing on any warning.

#### Scenario: Running lint
- **WHEN** a developer runs `pnpm lint`
- **THEN** it SHALL execute `biome check --error-on-warnings .`, which runs the linter, import sorter, and formatter-drift check in a single pass

#### Scenario: Lint failure
- **WHEN** Biome detects rule violations or formatter drift
- **THEN** the `lint` script SHALL exit with a non-zero status code

### Requirement: Format script
A root `format` script SHALL run Biome's writer mode across the repository and format Terraform files.

#### Scenario: Running format
- **WHEN** a developer runs `pnpm format`
- **THEN** it SHALL execute `biome check --write .` (applies safe lint fixes + formats all supported files) followed by `tofu fmt -recursive infrastructure/`

### Requirement: Ignored paths
Biome SHALL ignore generated files and dependencies.

#### Scenario: Excluded directories
- **WHEN** Biome runs
- **THEN** `files.includes` SHALL exclude `node_modules`, `**/dist`, `.persistence`, `**/.terraform`, the pre-bundled sandbox shims (`packages/runtime/src/action-dispatcher.js`, `packages/sdk/src/plugin/sandbox-globals*.js`), the sandbox build output (`packages/sandbox/dist`), and the vendored WPT tree (`packages/sandbox-stdlib/test/wpt/vendor`)
