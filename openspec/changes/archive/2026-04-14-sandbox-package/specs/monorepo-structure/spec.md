## MODIFIED Requirements

### Requirement: Runtime package layout

The monorepo SHALL contain the following packages under `packages/`:
- `packages/runtime` — the workflow engine runtime (`@workflow-engine/runtime`)
- `packages/sdk` — the workflow-author-facing types and factories (`@workflow-engine/sdk`)
- `packages/vite-plugin` — the workflow build plugin (`@workflow-engine/vite-plugin`)
- `packages/sandbox` — the QuickJS WASM sandbox (`@workflow-engine/sandbox`)

Each package SHALL have a valid `package.json` and follow the conventions established by this capability (ESM, scoped npm name under `@workflow-engine/`, TypeScript source as entry point where applicable).

#### Scenario: Runtime package directory exists

- **WHEN** the repository is cloned and `pnpm install` is run
- **THEN** the directory `packages/runtime` SHALL exist with a valid `package.json`

#### Scenario: Runtime package has a source entry point

- **WHEN** a developer opens the runtime package
- **THEN** it SHALL contain a `src/index.ts` file as the entry point

#### Scenario: Sandbox package exists

- **WHEN** the repository is cloned and `pnpm install` is run
- **THEN** the directory `packages/sandbox` SHALL exist with a valid `package.json`
- **AND** its `name` field SHALL be `@workflow-engine/sandbox`
- **AND** it SHALL ship TypeScript source directly (no build step)
