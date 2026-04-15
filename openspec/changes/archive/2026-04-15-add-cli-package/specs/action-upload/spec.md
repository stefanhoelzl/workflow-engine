## MODIFIED Requirements

### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows` endpoint that accepts a `application/gzip` body containing a tar.gz archive of a workflow bundle. The upload handler SHALL extract the archive into a file map and pass it to the WorkflowRegistry for validation, persistence, and registration. The archive SHALL contain at its root a `manifest.json` and an `actions/` directory with `.js` action source files.

Error responses SHALL include a JSON body. A `415` response SHALL include `{ "error": <string> }`. A `422` response SHALL include `{ "error": <string> }` where `<string>` is a specific reason for the failure (e.g., `missing manifest.json`, `missing action module: <path>`, or `invalid manifest: <details>`). When the `422` is caused by manifest validation failing the `ManifestSchema`, the body SHALL additionally include `issues: Array<{ path: Array<string | number>, message: string }>` derived from the underlying Zod validation issues.

#### Scenario: Successful upload

- **WHEN** a valid tar.gz archive with a correct manifest and all referenced action files is posted to `POST /api/workflows` with a valid auth token
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** the workflow SHALL be registered and available for event matching

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`
- **AND** the response body SHALL be `{ "error": "Not a valid gzip/tar archive" }`

#### Scenario: Manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL include `error` naming the specific failure (e.g., `missing manifest.json` or `invalid manifest: <message>`)
- **AND** when the failure is a `ManifestSchema` validation error, the response body SHALL include `issues: Array<{ path, message }>` reflecting the Zod validation issues

#### Scenario: Referenced action source file missing from archive

- **WHEN** the manifest references an action module `actions/handleFoo.js` but the archive does not contain that file
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL be `{ "error": "missing action module: actions/handleFoo.js" }` (or an equivalent specific message naming the missing path)
