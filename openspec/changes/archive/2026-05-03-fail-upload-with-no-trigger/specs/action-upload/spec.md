## MODIFIED Requirements

### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows/<tenant>` endpoint that accepts a `application/gzip` body containing a tar.gz archive of a workflow bundle for the named tenant. The upload handler SHALL extract the archive into a file map and pass it to the `WorkflowRegistry` for validation, persistence, and registration. The archive SHALL contain at its root a `manifest.json` (of shape `{workflows: [...]}`) and per-workflow bundle files.

The `<tenant>` path parameter SHALL be validated by the `requireTenantMember()` middleware (see `auth` capability) BEFORE the upload handler runs: invalid tenant identifiers AND non-member users SHALL both receive `404 Not Found` with body `{error: "Not Found"}`. The upload handler SHALL NOT receive a request whose `<tenant>` has not been validated and authorized.

Error responses from the upload handler itself (after tenant authorization passes) SHALL include a JSON body. A `415` response SHALL include `{ "error": <string> }`. A `422` response SHALL include `{ "error": <string> }` where `<string>` is a specific reason for the failure (e.g., `missing manifest.json`, `missing workflow module: <path>`, or `invalid manifest: <details>`). When the `422` is caused by manifest validation failing `ManifestSchema`, the body SHALL additionally include `issues: Array<{ path: Array<string | number>, message: string, formatted: string }>` where:

- `path` and `message` are derived from the underlying Zod validation issue, preserving the pre-existing structured shape for non-CLI consumers.
- `formatted` is the result of calling `formatIssue(issue, parsedValue)` from `@workflow-engine/core` against the manifest object that failed validation. The `formatted` string follows the convention `Workflow "<name>": <type> trigger "<name>": <suffix>` (or the action / workflow-root variants). CLI consumers SHALL prefer printing `formatted` over reconstructing the message from `path` + `message`.

The `formatted` field is additive: clients that only consume `path` and `message` continue to work unchanged.

#### Scenario: Successful upload

- **WHEN** a valid tar.gz archive with a correct manifest and all referenced workflow module files is posted to `POST /api/workflows/<tenant>` with a valid auth token whose user passes the `isMember(user, tenant)` check
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** every workflow in the manifest SHALL be registered and available for event matching

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`
- **AND** the response body SHALL be `{ "error": "Not a valid gzip/tar archive" }`

#### Scenario: Manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL include `error` naming the specific failure
- **AND** when the failure is a `ManifestSchema` validation error, the response body SHALL include `issues: Array<{ path, message, formatted }>` reflecting the Zod validation issues
- **AND** each `formatted` entry SHALL be a single-line string rendered via `formatIssue` from `@workflow-engine/core`

#### Scenario: Issue formatted field for empty triggers

- **GIVEN** an upload whose manifest contains a workflow named `"demo"` with `triggers: []`
- **WHEN** the upload handler returns 422
- **THEN** the response body's `issues[]` SHALL contain at least one entry with `formatted` of the form `Workflow "demo": must declare at least one trigger`

#### Scenario: Non-member tenant returns 404

- **GIVEN** `user = { name: "alice", orgs: [] }` on the request context
- **WHEN** `POST /api/workflows/victim` is requested (alice is not a member of the `victim` tenant)
- **THEN** the `requireTenantMember()` middleware SHALL respond with `404 Not Found` before reaching the upload handler
- **AND** the response body SHALL be `{"error": "Not Found"}`

#### Scenario: Invalid tenant identifier returns 404

- **WHEN** `POST /api/workflows/../etc/passwd` is requested
- **THEN** the `requireTenantMember()` middleware SHALL respond with `404 Not Found` indistinguishably from a non-member response
