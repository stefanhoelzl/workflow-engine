## ADDED Requirements

### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows` endpoint that accepts a `application/gzip` body containing a tar.gz archive of a workflow bundle. The upload handler SHALL extract the archive into a file map and pass it to the WorkflowRegistry for validation, persistence, and registration. The archive SHALL contain at its root a `manifest.json` and an `actions/` directory with `.js` action source files.

#### Scenario: Successful upload

- **WHEN** a valid tar.gz archive with a correct manifest and all referenced action files is posted to `POST /api/workflows` with a valid auth token
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** the workflow SHALL be registered and available for event matching

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`

#### Scenario: Manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`

#### Scenario: Referenced action source file missing from archive

- **WHEN** the manifest references an action module `actions/handleFoo.js` but the archive does not contain that file
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`

### Requirement: Hot reload after upload

After a successful upload, the WorkflowRegistry SHALL make the workflow available immediately. New events SHALL be matched against the updated action list. Actions already executing SHALL finish with the old code.

#### Scenario: New events match uploaded workflow

- **WHEN** workflow "foo" is uploaded with an action listening on event type "order.created"
- **AND** an "order.created" event is subsequently triggered
- **THEN** the scheduler SHALL execute "foo"'s action

#### Scenario: Replaced workflow takes effect immediately

- **WHEN** workflow "foo" is uploaded, replacing a previously uploaded "foo"
- **AND** an event matching "foo"'s action is triggered
- **THEN** the scheduler SHALL execute the new version's action code

#### Scenario: In-flight action completes with old code

- **WHEN** workflow "foo" is being replaced while an action from the old "foo" is executing
- **THEN** the in-flight action SHALL complete using the old code
- **AND** subsequent events SHALL use the new code

#### Scenario: Invalid upload removes existing workflow

- **WHEN** workflow "foo" exists in the registry
- **AND** a new upload for "foo" fails validation (e.g., missing action source)
- **THEN** the existing "foo" SHALL be removed from the registry
- **AND** the runtime SHALL log the removal with the error reason
