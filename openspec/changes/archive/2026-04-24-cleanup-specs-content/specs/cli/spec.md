## MODIFIED Requirements

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
