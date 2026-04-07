### Requirement: PR validation workflow
The system SHALL provide a GitHub Actions workflow at `.github/workflows/ci.yml` that runs on every pull request.

#### Scenario: PR opened or updated
- **WHEN** a pull request is opened, synchronized, or reopened
- **THEN** the workflow SHALL run lint, type check, test, and build steps in sequence

### Requirement: Lint step
The workflow SHALL run `pnpm lint` to validate code with Biome.

#### Scenario: Lint passes
- **WHEN** all source files conform to Biome lint rules
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Lint fails
- **WHEN** any source file violates Biome lint rules
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Type check step
The workflow SHALL run `pnpm check` to validate TypeScript types.

#### Scenario: Type check passes
- **WHEN** all TypeScript files pass strict type checking
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Type check fails
- **WHEN** any TypeScript type error exists
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Test step
The workflow SHALL run `pnpm test` to execute the test suite via Vitest.

#### Scenario: Tests pass
- **WHEN** all tests pass
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Tests fail
- **WHEN** any test fails
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Build step
The workflow SHALL run `pnpm build` to produce the production build via Vite.

#### Scenario: Build succeeds
- **WHEN** the Vite build completes without errors
- **THEN** the step SHALL succeed and the workflow SHALL report success

#### Scenario: Build fails
- **WHEN** the Vite build fails
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: pnpm store caching
The workflow SHALL cache the pnpm store across runs using `actions/setup-node` with pnpm caching enabled.

#### Scenario: Cache hit
- **WHEN** the pnpm lockfile has not changed since the last run
- **THEN** the pnpm store SHALL be restored from cache, reducing install time

#### Scenario: Cache miss
- **WHEN** the pnpm lockfile has changed
- **THEN** the pnpm store SHALL be populated from a fresh install and saved to cache

### Requirement: Node.js version
The workflow SHALL use Node.js 24.

#### Scenario: Node.js setup
- **WHEN** the workflow runs
- **THEN** Node.js 24 SHALL be installed via `actions/setup-node`
