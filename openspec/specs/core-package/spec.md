# Core Package Specification

## Purpose

Provide `@workflow-engine/core` — an internal, private package that holds the shared contract types consumed by both the SDK and the runtime. By centralising the manifest schema, trigger payload/result types, and the Zod v4 namespace in one place, both the SDK (build-time) and the runtime (load-time) validate against the same definitions without creating a circular dependency between them.

## Requirements

### Requirement: Core package provides shared contract types

The `@workflow-engine/core` package SHALL export the shared contract consumed by both SDK and runtime. It SHALL contain `ManifestSchema` (Zod validator), `Manifest` type, `HttpTriggerResult` type, `HttpTriggerPayload` type, and a `z` re-export from Zod v4. It SHALL depend only on `zod` and `ajv`.

#### Scenario: Runtime imports manifest validation from core

- **WHEN** the runtime imports `ManifestSchema` and `Manifest`
- **THEN** they resolve from `@workflow-engine/core`

#### Scenario: Runtime imports z from core

- **WHEN** the runtime imports `z` from `@workflow-engine/core`
- **THEN** it receives the Zod v4 `z` namespace

#### Scenario: Runtime imports HttpTriggerResult from core

- **WHEN** the runtime imports `HttpTriggerResult`
- **THEN** it resolves from `@workflow-engine/core`

### Requirement: Core package is internal

The `@workflow-engine/core` package SHALL NOT be published to npm. It SHALL be consumed only via `workspace:*` protocol by other packages in the monorepo.

#### Scenario: Core package.json is private

- **WHEN** inspecting `packages/core/package.json`
- **THEN** it has `"private": true`

### Requirement: Core package has minimal dependencies

The `@workflow-engine/core` package SHALL depend only on `zod` (runtime) and `ajv` (runtime, for JSON Schema validation inside `ManifestSchema`). It SHALL NOT depend on vite, typescript, or any build tooling.

#### Scenario: Core dependency list

- **WHEN** inspecting `packages/core/package.json` dependencies
- **THEN** it lists only `zod` and `ajv`
- **THEN** it has no devDependencies related to build tooling

### Requirement: Core package is ESM

The `@workflow-engine/core` package SHALL use ES modules (`"type": "module"`) and export a single entry point via the `exports` field.

#### Scenario: Core exports field

- **WHEN** inspecting `packages/core/package.json`
- **THEN** it has `"type": "module"` and `"exports": { ".": "./src/index.ts" }`
