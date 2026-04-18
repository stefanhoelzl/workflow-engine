## MODIFIED Requirements

### Requirement: Workflow discovery

The CLI SHALL discover workflow entry files by globbing `<cwd>/src/*.ts` non-recursively. Each matched file is treated as one workflow whose name is derived from the file basename without the `.ts` extension. The complete set of discovered workflows SHALL be packed into a single **tenant tarball** during the build step.

The CLI SHALL exit with a non-zero status and print `no workflows found in src/` to stderr when `src/` does not exist or contains no matching files.

#### Scenario: Single workflow discovered

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts`
- **THEN** the CLI SHALL build a tenant tarball containing exactly one workflow named `foo`

#### Scenario: Multiple workflows discovered

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts` and `src/bar.ts`
- **THEN** the CLI SHALL build a single tenant tarball containing both workflows named `foo` and `bar`

#### Scenario: Helper files in nested directories are not treated as workflows

- **WHEN** the user runs `wfe upload` in a directory that contains `src/foo.ts` and `src/shared/util.ts`
- **THEN** the tenant tarball SHALL include only `foo`

#### Scenario: Missing src directory

- **WHEN** the user runs `wfe upload` in a directory that does not contain a `src/` directory
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include `no workflows found in src/`

#### Scenario: Empty src directory

- **WHEN** the user runs `wfe upload` in a directory where `src/` exists but contains no `.ts` files at the top level
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include `no workflows found in src/`

### Requirement: Build pipeline

The CLI SHALL build workflows using the vite plugin imported from `@workflow-engine/sdk/plugin`. Build output SHALL be written to `<cwd>/dist/bundle.tar.gz` — a single tenant tarball containing the root `manifest.json` (new tenant-manifest schema, see `workflow-manifest`) and one `<name>.js` per workflow at the tarball root. The CLI SHALL NOT support a user-authored `vite.config.ts`; any such file in `cwd` SHALL be ignored.

#### Scenario: CLI uses SDK-internal plugin

- **WHEN** the CLI's vite-config module imports the plugin
- **THEN** it imports from the SDK's internal plugin module

#### Scenario: Build produces single tenant tarball

- **WHEN** `wfe upload` is invoked with `src/foo.ts` and `src/bar.ts`
- **THEN** `dist/bundle.tar.gz` SHALL exist after the build step
- **AND** the tarball SHALL contain `manifest.json` with `workflows: [{name: "foo", ...}, {name: "bar", ...}]`
- **AND** the tarball SHALL contain `foo.js` and `bar.js` at the tarball root

#### Scenario: User vite.config.ts is ignored

- **WHEN** `wfe upload` is invoked in a directory containing a user-authored `vite.config.ts`
- **THEN** the CLI SHALL use its bundled default vite config regardless

### Requirement: Target URL resolution

The CLI SHALL POST the tenant tarball to `<url>/api/workflows/<tenant>`. The `<tenant>` SHALL be resolved from:

1. `--tenant <name>` flag, if provided.
2. `WFE_TENANT` environment variable, if set and non-empty.
3. If neither is provided, the CLI SHALL exit with a non-zero status and print `tenant required: pass --tenant <name> or set WFE_TENANT` to stderr.

The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided.
2. Built-in default: `https://workflow-engine.webredirect.org`.

The CLI SHALL NOT read any environment variable for the URL. The CLI SHALL validate `<tenant>` against the tenant-identifier regex (see `tenant-model`) and exit non-zero with a clear error if it fails.

#### Scenario: Default URL used with explicit tenant flag

- **WHEN** `wfe upload --tenant acme` is invoked with no `--url`
- **THEN** the CLI SHALL POST to `https://workflow-engine.webredirect.org/api/workflows/acme`

#### Scenario: Tenant from env var

- **WHEN** `WFE_TENANT=acme wfe upload` is invoked
- **THEN** the CLI SHALL POST to `<default-url>/api/workflows/acme`

#### Scenario: Flag overrides env var

- **WHEN** `WFE_TENANT=acme wfe upload --tenant contoso` is invoked
- **THEN** the CLI SHALL POST to `<default-url>/api/workflows/contoso`

#### Scenario: Missing tenant

- **WHEN** `wfe upload` is invoked without `--tenant` and with no `WFE_TENANT` set
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include `tenant required`

#### Scenario: Invalid tenant rejected client-side

- **WHEN** `wfe upload --tenant "bad/name"` is invoked
- **THEN** the CLI SHALL exit with a non-zero status
- **AND** stderr SHALL include a regex-failure message (e.g. `tenant must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,62}`)
- **AND** the CLI SHALL NOT send a request

### Requirement: Upload semantics

The CLI SHALL POST the contents of `dist/bundle.tar.gz` **exactly once** to the resolved `/api/workflows/<tenant>` endpoint with `Content-Type: application/gzip`. There is no per-workflow POST loop: one tenant bundle, one request.

The CLI SHALL exit with status `0` when the response is `204 No Content`. On any failure (build error, network error, or non-`204` HTTP response), the CLI SHALL exit with status `1`. The CLI SHALL NOT retry a failed request.

#### Scenario: Single POST per upload

- **WHEN** `wfe upload` is invoked in a directory with 5 discovered workflows
- **THEN** the CLI SHALL make exactly one HTTP request
- **AND** the request path SHALL be `/api/workflows/<tenant>`

#### Scenario: Successful upload

- **WHEN** the single POST receives `204 No Content`
- **THEN** the CLI SHALL exit with status `0`

#### Scenario: Failed upload

- **WHEN** the POST receives `422` or a non-`204` response
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include the failure details (see "Output formatting")

#### Scenario: Network error

- **WHEN** the POST fails with a network error (e.g., connection refused)
- **THEN** the CLI SHALL exit with status `1`

#### Scenario: No retry

- **WHEN** the POST receives a non-204 response
- **THEN** the CLI SHALL NOT retry in the same invocation

### Requirement: Output formatting

The CLI SHALL print a status line to stderr: `✓ <tenant>` on success, `✗ <tenant>` on failure. On failure, the CLI SHALL additionally print indented detail lines showing `status: <http-status-or-"network-error">`, `error: <server-or-network-error-message>`, and when the response body contains an `issues` array, `issues:` followed by one indented line per issue in `<path>: <message>` form.

The previous per-bundle summary (`Uploaded: N`, `Failed: N`) SHALL be removed since exactly one tarball is uploaded per invocation.

#### Scenario: Success line

- **WHEN** tenant "acme" receives `204 No Content`
- **THEN** stderr SHALL include a line `✓ acme`

#### Scenario: Failure line with server error

- **WHEN** tenant "acme" receives `422` with body `{"error":"missing workflow module: bar.js"}`
- **THEN** stderr SHALL include `✗ acme`
- **AND** stderr SHALL include an indented line `status: 422`
- **AND** stderr SHALL include an indented line `error: missing workflow module: bar.js`

#### Scenario: Failure line with structured issues

- **WHEN** tenant "acme" receives `422` with body `{"error":"invalid manifest","issues":[{"path":["workflows",0,"name"],"message":"required"}]}`
- **THEN** stderr SHALL include `✗ acme`
- **AND** stderr SHALL include an indented `issues:` block with the line `workflows[0].name: required`

### Requirement: Programmatic API

The SDK SHALL export `build`, `upload`, `NoWorkflowsFoundError`, `UploadOptions`, and `UploadResult` from the `./cli` subpath export. The `scripts/dev.ts` and any other programmatic consumers SHALL import from `@workflow-engine/sdk/cli`.

The programmatic `upload(options)` function SHALL accept at least `{ cwd: string, url: string, tenant: string }` and return a promise that resolves to the same exit-code-equivalent status the CLI would produce. The `scripts/dev.ts` orchestrator SHALL consume this exported function directly, without spawning the `wfe` binary as a subprocess.

#### Scenario: Importing programmatic API

- **WHEN** a script imports `{ upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the `upload` function

#### Scenario: Programmatic call matches CLI behavior

- **WHEN** `upload({ cwd: '/path/to/project', url: 'http://localhost:8080', tenant: 'acme' })` is invoked
- **THEN** the function SHALL perform the same discovery, build, and single-POST upload as `wfe upload --tenant acme --url http://localhost:8080` run in `/path/to/project`
