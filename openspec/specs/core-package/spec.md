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

The `@workflow-engine/core` package SHALL use ES modules (`"type": "module"`) and export two entry points via the `exports` field: the main `"."` entry and a `"./test-utils"` subpath for test-only helpers.

#### Scenario: Core exports field

- **WHEN** inspecting `packages/core/package.json`
- **THEN** it has `"type": "module"` and `"exports": { ".": "./src/index.ts", "./test-utils": "./src/test-utils.ts" }`

### Requirement: Test-utils subpath is test-only

The `@workflow-engine/core/test-utils` subpath SHALL be imported only from `*.test.ts` files and test-support modules. It SHALL NOT be imported from production runtime, SDK, or sandbox code paths. The subpath exports `makeEvent()` — a helper that fabricates `InvocationEvent` fixtures with sensible defaults — and is used by the runtime package's unit tests (event-store, persistence, recovery, dashboard, integration) to avoid duplicating boilerplate.

#### Scenario: Test-utils is consumed only by tests

- **WHEN** grepping the monorepo for `from "@workflow-engine/core/test-utils"` imports
- **THEN** every match is in a `*.test.ts` file (or a test-support module co-located with tests)

### Requirement: Core package exports the secret-sentinel module

The `@workflow-engine/core` package SHALL export `encodeSentinel` and `SENTINEL_SUBSTRING_RE` from its main entrypoint (`packages/core/src/index.ts`), providing the single source of truth for the `\x00secret:NAME\x00` encoding used to reference workflow secrets in trigger descriptor string fields. The helpers are inlined into `index.ts` (matching the existing convention documented in the `Guest-globals contract` section: the `?sandbox-plugin` esbuild transform resolves `@workflow-engine/core` directly to `index.ts` and does not reliably pick up sibling `.ts` modules).

The exports SHALL be exactly:

- `encodeSentinel(name: string): string` — returns `"\x00secret:" + name + "\x00"`. The `name` SHALL match `/^[A-Za-z_][A-Za-z0-9_]*$/`; otherwise `encodeSentinel` SHALL throw a descriptive `Error`.
- `SENTINEL_SUBSTRING_RE: RegExp` — a global regex equal to `/\x00secret:([A-Za-z_][A-Za-z0-9_]*)\x00/g` capturing the sentinel name in group 1. The regex is suitable for both `String.prototype.replace` and iterating `matchAll`.

All producers (the SDK's build-time env resolver) and consumers (the runtime's main-side trigger-config resolver) SHALL import these from `@workflow-engine/core`. The encoding SHALL NOT be re-implemented elsewhere.

#### Scenario: encodeSentinel returns the canonical byte sequence

- **WHEN** `encodeSentinel("MY_SECRET")` is called
- **THEN** the return SHALL equal the 19-code-unit string starting with `\x00secret:` and ending with `\x00`, containing `MY_SECRET` between

#### Scenario: encodeSentinel rejects invalid names

- **WHEN** `encodeSentinel("has-dash")`, `encodeSentinel("")`, or `encodeSentinel("has space")` is called
- **THEN** the call SHALL throw `Error` with a message identifying the invalid name

#### Scenario: SENTINEL_SUBSTRING_RE matches a whole-value sentinel

- **WHEN** `"\x00secret:TOKEN\x00".match(SENTINEL_SUBSTRING_RE)` is evaluated (via replace or matchAll)
- **THEN** exactly one match SHALL be found with capture group 1 equal to `"TOKEN"`

#### Scenario: SENTINEL_SUBSTRING_RE matches embedded sentinels

- **WHEN** `"Bearer \x00secret:TOKEN\x00 rest".replace(SENTINEL_SUBSTRING_RE, (_, n) => `<${n}>`)` is evaluated
- **THEN** the result SHALL be `"Bearer <TOKEN> rest"`

#### Scenario: SENTINEL_SUBSTRING_RE matches multiple sentinels in one string

- **WHEN** `"\x00secret:A\x00-\x00secret:B\x00".replace(SENTINEL_SUBSTRING_RE, (_, n) => n.toLowerCase())` is evaluated
- **THEN** the result SHALL be `"a-b"`
