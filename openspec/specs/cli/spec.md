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

The CLI SHALL build workflows using a pure `buildWorkflows(cwd)` core module exported from `@workflow-engine/sdk/cli` (or equivalent internal path). The core SHALL return an in-memory pair `{ files: Map<name, bytes>, manifest: UnsealedManifest }` where `manifest` matches today's `{ workflows: [...] }` shape and carries `secretBindings` for each workflow that declared `env({secret:true})`.

`buildWorkflows` SHALL be the single implementation of workflow discovery, env resolution, trigger collection, and per-workflow JS production used by every code path that needs workflow JS or manifest data. It SHALL invoke Vite/Rolldown via the programmatic API with a private internal-only emit-to-memory plugin; nothing else SHALL re-implement these concerns.

The CLI SHALL NOT support a user-authored `vite.config.ts`; any such file in `cwd` SHALL be ignored. The previously-public `@workflow-engine/sdk/plugin` export and its `packages/sdk/src/plugin/` directory SHALL be deleted.

#### Scenario: Single build implementation shared across entry points

- **WHEN** inspecting the CLI source
- **THEN** the `wfe build` subcommand and the internal `bundle` function SHALL both invoke the same exported `buildWorkflows` function
- **AND** there SHALL be no duplicate implementations of workflow discovery

#### Scenario: Public Vite plugin is removed

- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/plugin/` SHALL NOT exist
- **AND** `packages/sdk/package.json`'s `exports` SHALL NOT contain a `./plugin` subpath
- **AND** the only consumer of the in-memory build implementation SHALL be `buildWorkflows`

#### Scenario: User vite.config.ts is ignored

- **WHEN** the CLI runs in a directory containing a user-authored `vite.config.ts`
- **THEN** the CLI SHALL use its bundled internal vite/rolldown configuration regardless

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

### Requirement: CLI seals and uploads workflows with secret bindings

The `wfe upload` CLI SHALL seal and POST workflows in a single in-memory pipeline routed through an internal `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>` function. The pipeline SHALL:

1. Call `buildWorkflows(cwd)` to obtain `{ files, manifest }` in memory.
2. If any workflow in `manifest.workflows` has non-empty `secretBindings`:
   - Call `GET <url>/api/workflows/<owner>/public-key` once (with the resolved auth headers). Validate the response shape `{ algorithm: "x25519", publicKey: <b64>, keyId: <hex> }`.
   - For each binding on each affected workflow, read `process.env[name]`, call `sealCiphertext(plaintext, pubkey)` from `@workflow-engine/core/secrets-crypto`, base64-encode the returned bytes into `manifest.workflows[i].secrets[name]`, set `manifest.workflows[i].secretsKeyId = keyId`, and remove the `secretBindings` field. The CLI SHALL NOT call `crypto_box_seal` directly; only `sealCiphertext` from core.
3. Pack a single tenant tarball in-memory containing `manifest.json` (sealed) at the root plus one `<name>.js` per workflow at the root, from the `files` map.
4. Return the tarball bytes.

The CLI SHALL NOT contain its own `crypto_box_seal` invocation; all sealing SHALL go through `sealCiphertext` from `@workflow-engine/core/secrets-crypto`. The CLI SHALL NOT depend directly on `libsodium-wrappers`. `packages/sdk/package.json`'s `dependencies` SHALL NOT list `libsodium-wrappers`.

`wfe upload` SHALL then POST the returned bytes to `<url>/api/workflows/<owner>` with `Content-Type: application/gzip` and the resolved auth headers, as before.

The pipeline SHALL NOT write the built JS files, unsealed manifest, sealed manifest, or tarball to disk. All processing between `buildWorkflows` and the HTTP POST SHALL be in-memory.

If no workflow has a non-empty `secretBindings`, the CLI SHALL pack and POST the tarball without fetching the public key.

#### Scenario: Sealing routes through core

- **WHEN** `wfe upload` runs against a bundle with secret bindings
- **THEN** the only `crypto_box_seal` invocation SHALL be inside `@workflow-engine/core/secrets-crypto`
- **AND** `packages/sdk/` SHALL NOT contain a direct call to any libsodium API

#### Scenario: SDK package does not depend on libsodium directly

- **WHEN** inspecting `packages/sdk/package.json`
- **THEN** the `dependencies` SHALL NOT list `libsodium-wrappers` or any other libsodium binding

#### Scenario: Bundle with secret bindings is sealed and uploaded

- **GIVEN** a workflow declaring `env({name: "TOKEN", secret: true})` and `process.env.TOKEN = "ghp_xxx"`
- **WHEN** `wfe upload --owner acme --url https://example` runs
- **THEN** the CLI SHALL fetch `https://example/api/workflows/acme/public-key`
- **AND** SHALL seal `"ghp_xxx"` against the returned pk via `sealCiphertext` from core
- **AND** SHALL POST a bundle whose workflow manifest has `secrets: { TOKEN: <base64 ciphertext> }` and `secretsKeyId: <hex>`
- **AND** SHALL NOT include `secretBindings` in the POSTed manifest
- **AND** the response SHALL be 204

#### Scenario: Missing secret env var fails upload at build phase

- **GIVEN** a workflow declares `env({name: "TOKEN", secret: true})` and `process.env.TOKEN` is unset
- **WHEN** `wfe upload` runs
- **THEN** `buildWorkflows` SHALL fail with `Missing environment variable: TOKEN`
- **AND** no public-key fetch SHALL be issued
- **AND** no network POST SHALL be made

#### Scenario: Bundle without secret bindings skips PK fetch

- **GIVEN** a workflow with no `env({secret:true})` declarations
- **WHEN** `wfe upload` runs
- **THEN** the CLI SHALL NOT call the public-key endpoint
- **AND** the tarball SHALL be POSTed without a `secrets` or `secretsKeyId` field in any workflow manifest

#### Scenario: Public-key fetch failure aborts upload

- **GIVEN** a workflow with secret bindings
- **WHEN** the public-key fetch returns 401 or 404 or the connection fails
- **THEN** upload SHALL fail with a descriptive error
- **AND** no bundle SHALL be POSTed

#### Scenario: Plaintext and tarball are not written to disk

- **GIVEN** a workflow with secret bindings and a valid `process.env`
- **WHEN** `wfe upload` runs
- **THEN** no filesystem write in or around `dist/` SHALL contain plaintext secret values
- **AND** no `dist/bundle.tar.gz` SHALL be produced on the upload path
- **AND** no `dist/manifest.json` SHALL be produced on the upload path

#### Scenario: keyId matches server response

- **GIVEN** a bundle successfully sealed
- **WHEN** the POSTed manifest is inspected
- **THEN** each sealed workflow manifest's `secretsKeyId` SHALL equal the `keyId` field from the public-key endpoint response

### Requirement: Build-only subcommand

The `wfe` binary SHALL expose a `build` subcommand that invokes `buildWorkflows(cwd)` and writes only the per-workflow `<name>.js` files to `<cwd>/dist/`. It SHALL NOT write `<cwd>/dist/manifest.json`, SHALL NOT pack `<cwd>/dist/bundle.tar.gz`, and SHALL NOT perform any network I/O, authentication, or target-URL resolution.

The `build` subcommand SHALL fail fast when a workflow declares an env binding (plaintext or `secret: true`) whose resolved value is absent: stderr SHALL include `Missing environment variable: <name>` and the command SHALL exit with status `1`. No JS file SHALL be written to `<cwd>/dist/` in that case.

The `build` subcommand SHALL NOT accept `--url`, `--owner`, `--tenant`, `--user`, `--token`, or read `GITHUB_TOKEN`. Passing any authentication-related flag or environment variable SHALL have no effect on its behaviour.

#### Scenario: Build subcommand writes only JS files to dist

- **WHEN** `wfe build` is invoked in a directory containing `src/foo.ts` and `src/bar.ts`
- **THEN** `<cwd>/dist/foo.js` and `<cwd>/dist/bar.js` SHALL exist
- **AND** `<cwd>/dist/manifest.json` SHALL NOT exist
- **AND** `<cwd>/dist/bundle.tar.gz` SHALL NOT exist
- **AND** the command SHALL exit with status `0`
- **AND** SHALL NOT issue any HTTP request

#### Scenario: Build subcommand performs no authentication

- **GIVEN** `GITHUB_TOKEN=ghp_xxx` is set in the environment
- **WHEN** `wfe build` is invoked
- **THEN** no HTTP request SHALL be issued (the token is ignored by design)

#### Scenario: Build fails fast on missing plaintext env var

- **GIVEN** a workflow declares `env({name: "API_URL"})` with no default
- **AND** `process.env.API_URL` is unset
- **WHEN** `wfe build` is invoked
- **THEN** stderr SHALL include `Missing environment variable: API_URL`
- **AND** the command SHALL exit with status `1`

#### Scenario: Build fails fast on missing secret env var

- **GIVEN** a workflow declares `env({name: "TOKEN", secret: true})`
- **AND** `process.env.TOKEN` is unset
- **WHEN** `wfe build` is invoked
- **THEN** stderr SHALL include `Missing environment variable: TOKEN`
- **AND** the command SHALL exit with status `1`

#### Scenario: Build subcommand fails on missing workflows

- **WHEN** `wfe build` is invoked in a directory where `src/` does not exist or contains no top-level `.ts` files
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include `no workflows found in src/`

