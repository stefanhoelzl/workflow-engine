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

The CLI SHALL POST the built tenant tarball to `<url>/api/workflows/<tenant>`. The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided.
2. Built-in default: `https://workflow-engine.webredirect.org`.

The `<tenant>` path segment SHALL be resolved from:

1. `--tenant <name>` flag, if provided.
2. `WFE_TENANT` environment variable (trimmed), if set and non-empty.

If neither source yields a non-empty tenant, the CLI SHALL print `tenant required: pass --tenant <name> or set WFE_TENANT` to stderr and exit with status `1` BEFORE attempting any build or upload.

The CLI SHALL NOT read any environment variable for the URL.

#### Scenario: Default URL used when no flag

- **WHEN** `wfe upload --tenant acme` is invoked with no `--url` flag
- **THEN** the CLI SHALL POST to `https://workflow-engine.webredirect.org/api/workflows/acme`

#### Scenario: Flag overrides default URL

- **WHEN** `wfe upload --url http://localhost:8080 --tenant acme` is invoked
- **THEN** the CLI SHALL POST to `http://localhost:8080/api/workflows/acme`

#### Scenario: WFE_TENANT fallback

- **GIVEN** `WFE_TENANT=acme` is set
- **WHEN** `wfe upload` is invoked with no `--tenant` flag
- **THEN** the CLI SHALL POST to `<default-url>/api/workflows/acme`

#### Scenario: Missing tenant fails fast

- **WHEN** `wfe upload` is invoked with no `--tenant` flag AND no `WFE_TENANT` environment variable
- **THEN** the CLI SHALL print `tenant required: pass --tenant <name> or set WFE_TENANT` to stderr
- **AND** exit with status `1`
- **AND** SHALL NOT build any workflow or issue any upload request

### Requirement: Authentication via GITHUB_TOKEN or --user

The CLI SHALL support two mutually-exclusive authentication modes for upload requests:

1. **GitHub** (production): when `GITHUB_TOKEN` is set and non-empty, the CLI SHALL include `X-Auth-Provider: github` and `Authorization: Bearer <token>` on every upload request.
2. **Local** (dev only): when `--user <name>` is passed (or the programmatic `upload({ user })` option is set) and non-empty, the CLI SHALL include `X-Auth-Provider: local` and `Authorization: User <name>` on every upload request.

The two modes SHALL be mutually exclusive. If both `GITHUB_TOKEN` and `--user` are supplied, the CLI SHALL exit with status `1` and print an error to stderr identifying the conflict; no upload SHALL be attempted.

When neither mode is supplied, the CLI SHALL omit both headers and let the server decide (today's server SHALL respond `401 Unauthorized`).

#### Scenario: GITHUB_TOKEN present sends github headers

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set and `wfe upload` is invoked without `--user`
- **THEN** every upload request SHALL carry `X-Auth-Provider: github` and `Authorization: Bearer ghp_xxx`

#### Scenario: --user sends local headers

- **WHEN** `wfe upload --tenant dev --user dev` is invoked without `GITHUB_TOKEN`
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User dev`

#### Scenario: Both modes supplied is rejected

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set AND `wfe upload --user dev` is invoked
- **THEN** the CLI SHALL exit with status `1`
- **AND** print an error to stderr identifying that the two modes are mutually exclusive
- **AND** SHALL NOT send any upload request

#### Scenario: Neither mode omits both headers

- **WHEN** `GITHUB_TOKEN` is unset and `--user` is not passed
- **THEN** upload requests SHALL omit both `Authorization` and `X-Auth-Provider`

#### Scenario: 401 surfaced to the user

- **WHEN** the server returns `401 Unauthorized` for a bundle
- **THEN** the CLI SHALL print `✗ <name>` followed by indented `status: 401` and the server's `error` field to stderr
- **AND** the CLI SHALL continue attempting remaining bundles

### Requirement: Upload semantics

The CLI SHALL POST a single tarball per invocation (not per-bundle) — the build step packages all discovered workflows into one `.tar.gz` containing a root `manifest.json` (`{workflows: [...]}`) plus one `<name>.js` per workflow. The tarball SHALL be POSTed to the resolved `/api/workflows/<tenant>` endpoint with `Content-Type: application/gzip`.

The CLI SHALL NOT retry a failed request.

The CLI SHALL exit with status `0` only when the upload received a `204 No Content` response. On any failure (build error, network error, tenant missing, or non-`204` HTTP response), the CLI SHALL exit with status `1`.

#### Scenario: Successful upload

- **WHEN** a valid tenant bundle is built and the server responds `204 No Content`
- **THEN** the CLI SHALL exit with status `0`

#### Scenario: Build error

- **WHEN** the build step fails (e.g., TypeScript error, missing handler)
- **THEN** the CLI SHALL exit with status `1`
- **AND** no upload request SHALL be issued

#### Scenario: Network error

- **WHEN** the upload request fails with a network error (e.g., connection refused)
- **THEN** the CLI SHALL exit with status `1`

#### Scenario: Server returns 4xx or 5xx

- **WHEN** the server responds with any non-`204` status (e.g., `401`, `404`, `422`, `500`)
- **THEN** the CLI SHALL print the status + error body to stderr
- **AND** exit with status `1`
- **AND** SHALL NOT retry

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

The SDK SHALL export an `upload(options)` programmatic API. The `options` shape SHALL be:

```ts
interface UploadOptions {
  cwd: string;       // workflows directory
  url: string;       // base URL of the runtime
  tenant: string;    // tenant id
  user?: string;     // local-provider login (mutually exclusive with token)
  token?: string;    // GitHub Bearer token (mutually exclusive with user)
}
```

If both `user` and `token` are supplied, the function SHALL reject with an error identifying the conflict; no HTTP request SHALL be made. If neither is supplied, no `Authorization` or `X-Auth-Provider` header SHALL be sent.

The `user` option SHALL drive the same headers as the CLI's `--user` flag (`X-Auth-Provider: local` + `Authorization: User <name>`). The `token` option SHALL drive `X-Auth-Provider: github` + `Authorization: Bearer <token>`.

#### Scenario: upload() with user sets local headers

- **WHEN** `await upload({ cwd, url, tenant: "dev", user: "dev" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User dev`

#### Scenario: upload() with token sets github headers

- **WHEN** `await upload({ cwd, url, tenant: "dev", token: "ghp_xxx" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: github` and `Authorization: Bearer ghp_xxx`

#### Scenario: upload() with both user and token rejects

- **WHEN** `await upload({ cwd, url, tenant: "dev", user: "dev", token: "ghp_xxx" })` is invoked
- **THEN** the promise SHALL reject with an error identifying the mutual-exclusion violation
- **AND** SHALL NOT send any HTTP request
