## ADDED Requirements

### Requirement: Vitest root configuration
A `vitest.config.ts` at the repository root SHALL configure Vitest for the entire monorepo.

#### Scenario: Config file exists
- **WHEN** inspecting the repository root
- **THEN** a `vitest.config.ts` file SHALL exist

### Requirement: Test discovery across packages
Vitest SHALL discover and run tests from all workspace packages.

#### Scenario: Test file pattern
- **WHEN** Vitest runs from the root
- **THEN** it SHALL discover test files matching `**/*.test.ts` and `**/*.spec.ts` within `packages/*/src/`

#### Scenario: No tests exist yet
- **WHEN** a developer runs `pnpm test` before any tests are written
- **THEN** Vitest SHALL exit successfully with zero tests found (not an error)

### Requirement: Test script
A root `test` script SHALL run Vitest.

#### Scenario: Running tests
- **WHEN** a developer runs `pnpm test`
- **THEN** Vitest SHALL execute all discovered tests and report results

#### Scenario: Test failure exit code
- **WHEN** any test fails
- **THEN** the `test` script SHALL exit with a non-zero status code

### Requirement: TypeScript support in tests
Vitest SHALL support TypeScript test files without additional configuration.

#### Scenario: TypeScript test execution
- **WHEN** a test file is written in TypeScript (`.test.ts`)
- **THEN** Vitest SHALL transform and execute it using Vite's built-in TypeScript support
