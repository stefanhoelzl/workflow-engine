## ADDED Requirements

### Requirement: Shared base TypeScript configuration
A `tsconfig.base.json` at the repository root SHALL define the shared strict TypeScript compiler settings used by all packages.

#### Scenario: Strict mode flags
- **WHEN** inspecting `tsconfig.base.json`
- **THEN** it SHALL enable `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`, `isolatedModules`, and `verbatimModuleSyntax`

#### Scenario: Target and module settings
- **WHEN** inspecting `tsconfig.base.json`
- **THEN** it SHALL target `ES2025` with `module: "NodeNext"` and `moduleResolution: "NodeNext"`

### Requirement: Project references
A root `tsconfig.json` SHALL declare project references for cross-package type checking. Initially only `runtime` is referenced; more packages will be added as they are created.

#### Scenario: Root references
- **WHEN** inspecting the root `tsconfig.json`
- **THEN** it SHALL contain a reference to `packages/runtime`

#### Scenario: Incremental type checking
- **WHEN** a developer runs `tsc --build` at the repository root
- **THEN** TypeScript SHALL type-check all packages respecting their dependency order

### Requirement: Per-package TypeScript configuration
Each package SHALL have its own `tsconfig.json` that extends the shared base.

#### Scenario: Base extension
- **WHEN** inspecting any package's `tsconfig.json`
- **THEN** it SHALL extend `../../tsconfig.base.json`

#### Scenario: Package-scoped source files
- **WHEN** inspecting any package's `tsconfig.json`
- **THEN** it SHALL set `include` to `["src"]` and `outDir` to `"dist"`

#### Scenario: Composite mode for references
- **WHEN** inspecting any package's `tsconfig.json`
- **THEN** it SHALL enable `composite: true` and `declaration: true`

### Requirement: Type-check-only workflow
TypeScript SHALL be used exclusively for type checking, not for code emission.

#### Scenario: No emit on type check
- **WHEN** a developer runs `pnpm check`
- **THEN** TypeScript SHALL report type errors without producing any output files
