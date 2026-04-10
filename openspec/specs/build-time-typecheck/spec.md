### Requirement: Production builds enforce TypeScript type checking

The `workflowPlugin` SHALL run TypeScript type checking against all workflow entry files during the `buildStart` Vite hook. The build SHALL fail if any type errors are found.

#### Scenario: Build fails on type error
- **WHEN** a workflow file contains a TypeScript type error (e.g., passing `{ wrong: true }` to an emit expecting `{ message: string }`)
- **AND** a production build is run (no `build.watch`)
- **THEN** the Vite build SHALL fail with an error
- **AND** the error output SHALL include the file path, line number, and source context of each type error

#### Scenario: Build succeeds with valid types
- **WHEN** all workflow files pass TypeScript type checking
- **AND** a production build is run
- **THEN** the `buildStart` hook SHALL complete without error
- **AND** the build SHALL proceed to the existing `generateBundle` logic

#### Scenario: Type checking skipped in watch mode
- **WHEN** the Vite build is running in watch mode (`build.watch` is set)
- **THEN** the `buildStart` hook SHALL NOT run TypeScript type checking
- **AND** the build SHALL proceed directly to bundling

### Requirement: Plugin ships fixed strict compiler options

The plugin SHALL use a hardcoded set of TypeScript compiler options for type checking. The plugin SHALL NOT read or require a tsconfig file from the workflow project for build-time checking.

#### Scenario: Strict mode enforced
- **WHEN** the plugin type-checks workflow files
- **THEN** it SHALL use these compiler options: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `noEmit: true`, `isolatedModules: true`, `skipLibCheck: true`, `target: "esnext"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`

#### Scenario: No user-configurable tsconfig
- **WHEN** the plugin is configured
- **THEN** it SHALL NOT accept a `tsconfig` option
- **AND** it SHALL NOT search for or read `tsconfig.json` files from the filesystem

### Requirement: Type checking scoped to declared workflow entries

The plugin SHALL type-check only the files listed in the `workflows` option (and their transitive imports). It SHALL NOT glob or scan for additional TypeScript files.

#### Scenario: Only declared workflows are checked
- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **AND** other `.ts` files exist in the same directory
- **THEN** only `cronitor.ts` and its transitive imports SHALL be type-checked

### Requirement: TypeScript as peer dependency

The `@workflow-engine/vite-plugin` package SHALL declare `typescript` as a peer dependency with a minimum version of `>=5.0.0`.

#### Scenario: Missing TypeScript installation
- **WHEN** a project uses `@workflow-engine/vite-plugin` without `typescript` installed
- **THEN** the package manager SHALL warn about the missing peer dependency

### Requirement: Pretty error formatting

Type errors SHALL be formatted using `ts.formatDiagnosticsWithColorAndContext` to include source lines, carets, and color output.

#### Scenario: Error output format
- **WHEN** a workflow file has a type error at line 15, column 3
- **THEN** the error output SHALL include the file path, line number, the source line content, and a caret indicating the error position
