## ADDED Requirements

### Requirement: Biome configuration at repository root
A `biome.json` at the repository root SHALL configure Biome as the project's linter and formatter.

#### Scenario: Single config file
- **WHEN** inspecting the repository root
- **THEN** a `biome.json` file SHALL exist and be the only linting/formatting config

### Requirement: All linter rules enabled
Biome SHALL be configured with all linter rules enabled across all groups.

#### Scenario: Rule configuration
- **WHEN** inspecting `biome.json`
- **THEN** the linter rules SHALL have `"all": true` at the top level, enabling every rule in every group

#### Scenario: Individual rule overrides
- **WHEN** a specific rule proves too noisy or inapplicable
- **THEN** it SHALL be disabled individually in `biome.json` with a comment explaining the reason

### Requirement: Formatter configuration
Biome SHALL handle all code formatting with consistent settings.

#### Scenario: Formatting defaults
- **WHEN** inspecting `biome.json`
- **THEN** the formatter SHALL be enabled for the entire repository with Biome's defaults (tabs for indentation, 80-char line width)

### Requirement: Lint script
A root `lint` script SHALL run Biome's linter across the repository.

#### Scenario: Running lint
- **WHEN** a developer runs `pnpm lint`
- **THEN** Biome SHALL check all TypeScript files and report any violations

#### Scenario: Lint failure
- **WHEN** Biome detects rule violations
- **THEN** the `lint` script SHALL exit with a non-zero status code

### Requirement: Format script
A root `format` script SHALL run Biome's formatter across the repository.

#### Scenario: Running format
- **WHEN** a developer runs `pnpm format`
- **THEN** Biome SHALL format all supported files in the repository

### Requirement: Ignored paths
Biome SHALL ignore generated files and dependencies.

#### Scenario: Excluded directories
- **WHEN** Biome runs
- **THEN** it SHALL ignore `node_modules`, `dist`, and any build output directories
