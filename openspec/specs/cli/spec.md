# CLI Specification

## Purpose

Provide `@workflow-engine/cli` — a published npm package with a `wfe` binary — that lets any operator build workflows from source and upload them to a running `@workflow-engine/runtime`. The CLI is the single supported entry point for external users to deploy workflow code; the dev loop (`scripts/dev.ts`) consumes the same programmatic `upload()` function to keep one code path in and out of the monorepo.

## Requirements

### Requirement: Workflow discovery

The CLI SHALL discover workflow entry files by globbing `<cwd>/src/*.ts` non-recursively. Each matched file is treated as one workflow whose name is derived from the file basename without the `.ts` extension.

The CLI SHALL exit with a non-zero status and print `no workflows found in src/` to stderr when `src/` does not exist or contains no matching files.

#### Scenario: Single workflow discovered

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts`
- **THEN** the CLI SHALL build exactly one workflow named `foo`

#### Scenario: Multiple workflows discovered

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts` and `src/bar.ts`
- **THEN** the CLI SHALL build both workflows named `foo` and `bar`

#### Scenario: Helper files in nested directories are not treated as workflows

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts` and `src/shared/util.ts`
- **THEN** the CLI SHALL build only `foo`
- **AND** the CLI SHALL NOT attempt to build `util`

#### Scenario: Missing src directory

- **WHEN** the user runs `wfe upload` in a directory that does not contain a `src/` directory
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include `no workflows found in src/`

#### Scenario: Empty src directory

- **WHEN** the user runs `wfe upload` in a directory where `src/` exists but contains no `.ts` files at the top level
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include `no workflows found in src/`

### Requirement: Build pipeline

The CLI SHALL build workflows using the vite plugin imported from `@workflow-engine/sdk/plugin` (previously `@workflow-engine/vite-plugin`). Build output SHALL be written to `<cwd>/dist/<name>/bundle.tar.gz` for each workflow. The CLI SHALL NOT support a user-authored `vite.config.ts`; any such file in `cwd` SHALL be ignored.

#### Scenario: CLI uses SDK-internal plugin

- **WHEN** the CLI's vite-config module imports the plugin
- **THEN** it imports from the SDK's internal plugin module (not a separate package)

#### Scenario: Build produces bundles for all discovered workflows

- **WHEN** `wfe upload` is invoked with `src/foo.ts` and `src/bar.ts`
- **THEN** `dist/foo/bundle.tar.gz` and `dist/bar/bundle.tar.gz` SHALL exist after the build step

#### Scenario: User vite.config.ts is ignored

- **WHEN** `wfe upload` is invoked in a directory containing a user-authored `vite.config.ts`
- **THEN** the CLI SHALL use its bundled default vite config regardless

### Requirement: CLI code lives in SDK

The CLI source code SHALL live inside `@workflow-engine/sdk` at `src/cli/`. The standalone `@workflow-engine/cli` package SHALL be deleted. The `wfe` binary is provided by SDK's `bin` field.

#### Scenario: Standalone package removed

- **WHEN** inspecting the packages directory
- **THEN** `packages/cli/` does not exist

#### Scenario: CLI source lives in SDK

- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/cli/` contains the CLI source files (cli.ts, build.ts, upload.ts, vite-config.ts)

### Requirement: Target URL resolution

The CLI SHALL POST each bundle to `<url>/api/workflows`. The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided
2. Built-in default: `https://workflow-engine.webredirect.org`

The CLI SHALL NOT read any environment variable for the URL.

#### Scenario: Default URL used when no flag

- **WHEN** `wfe upload` is invoked with no `--url` flag
- **THEN** the CLI SHALL POST to `https://workflow-engine.webredirect.org/api/workflows`

#### Scenario: Flag overrides default

- **WHEN** `wfe upload --url http://localhost:8080` is invoked
- **THEN** the CLI SHALL POST to `http://localhost:8080/api/workflows`

### Requirement: Authentication via GITHUB_TOKEN

The CLI SHALL read the `GITHUB_TOKEN` environment variable. When it is set and non-empty, the CLI SHALL include `Authorization: Bearer <token>` on every upload request. When unset or empty, the CLI SHALL send no `Authorization` header and let the server decide.

#### Scenario: GITHUB_TOKEN present

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set and `wfe upload` is invoked
- **THEN** every upload request SHALL carry `Authorization: Bearer ghp_xxx`

#### Scenario: GITHUB_TOKEN absent

- **WHEN** `GITHUB_TOKEN` is unset and `wfe upload` is invoked
- **THEN** upload requests SHALL omit the `Authorization` header

#### Scenario: 401 surfaced to the user

- **WHEN** the server returns `401 Unauthorized` for a bundle
- **THEN** the CLI SHALL print `✗ <name>` followed by indented `status: 401` and the server's `error` field to stderr
- **AND** the CLI SHALL continue attempting remaining bundles

### Requirement: Upload semantics

For each discovered bundle, the CLI SHALL POST the contents of `dist/<name>/bundle.tar.gz` to the resolved `/api/workflows` endpoint with `Content-Type: application/gzip`. The CLI SHALL attempt every bundle even if earlier ones fail (best-effort). The CLI SHALL NOT retry a failed request.

The CLI SHALL exit with status `0` only when every bundle received a `204 No Content` response. On any failure (build error, network error, or non-`204` HTTP response), the CLI SHALL exit with status `1`.

#### Scenario: All bundles succeed

- **WHEN** three bundles each receive `204 No Content`
- **THEN** the CLI SHALL exit with status `0`

#### Scenario: One bundle fails, others succeed

- **WHEN** bundle `foo` receives `204`, bundle `bar` receives `422`, and bundle `baz` receives `204`
- **THEN** the CLI SHALL still attempt the upload for `baz`
- **AND** the CLI SHALL exit with status `1`

#### Scenario: Network error on first bundle

- **WHEN** the first bundle's POST fails with a network error (e.g., connection refused)
- **THEN** the CLI SHALL still attempt remaining bundles
- **AND** the CLI SHALL exit with status `1`

#### Scenario: No retry

- **WHEN** a bundle receives a non-204 response
- **THEN** the CLI SHALL NOT retry that bundle in the same invocation

### Requirement: Output formatting

For each bundle, the CLI SHALL print a status line to stderr: `✓ <name>` on success, `✗ <name>` on failure. On failure, the CLI SHALL additionally print indented detail lines showing `status: <http-status-or-"network-error">`, `error: <server-or-network-error-message>`, and when the response body contains an `issues` array, `issues:` followed by one indented line per issue in `<path>: <message>` form.

After all bundles have been attempted, the CLI SHALL print a summary to stderr: `Uploaded: <n>` and `Failed: <n>`.

#### Scenario: Success line

- **WHEN** bundle `foo` receives `204 No Content`
- **THEN** stderr SHALL include a line `✓ foo`

#### Scenario: Failure line with server error

- **WHEN** bundle `bar` receives `422` with body `{"error":"missing action module: bar.js"}`
- **THEN** stderr SHALL include `✗ bar`
- **AND** stderr SHALL include an indented line `status: 422`
- **AND** stderr SHALL include an indented line `error: missing action module: bar.js`

#### Scenario: Failure line with structured issues

- **WHEN** bundle `baz` receives `422` with body `{"error":"invalid manifest","issues":[{"path":["actions",0,"name"],"message":"required"}]}`
- **THEN** stderr SHALL include `✗ baz`
- **AND** stderr SHALL include an indented `issues:` block with the line `actions[0].name: required`

#### Scenario: Summary

- **WHEN** two bundles succeed and one fails
- **THEN** stderr SHALL include `Uploaded: 2`
- **AND** stderr SHALL include `Failed: 1`

### Requirement: Programmatic API

The SDK SHALL export `build`, `upload`, `NoWorkflowsFoundError`, `UploadOptions`, and `UploadResult` from the `./cli` subpath export. The `scripts/dev.ts` and any other programmatic consumers SHALL import from `@workflow-engine/sdk/cli`.

The programmatic `upload(options)` function has a signature equivalent to the `wfe upload` command. The function SHALL accept at least `{ cwd: string, url: string }` and return a promise that resolves to the same exit-code-equivalent status the CLI would produce. The `scripts/dev.ts` orchestrator SHALL consume this exported function directly, without spawning the `wfe` binary as a subprocess.

#### Scenario: Importing programmatic API

- **WHEN** a script imports `{ upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the same `upload` function as the previous `@workflow-engine/cli` package

#### Scenario: Programmatic call matches CLI behavior

- **WHEN** `upload({ cwd: '/path/to/project', url: 'http://localhost:8080' })` is invoked
- **THEN** the function SHALL perform the same discovery, build, and upload steps as `wfe upload --url http://localhost:8080` run in `/path/to/project`
