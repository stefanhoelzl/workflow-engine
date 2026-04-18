## MODIFIED Requirements

### Requirement: Upload workflow bundle via HTTP

The runtime SHALL expose a `POST /api/workflows/<tenant>` endpoint that accepts an `application/gzip` body containing a tar.gz archive of a **whole tenant** bundle. The archive SHALL contain at its root a `manifest.json` (the tenant manifest, listing all workflows) and one `<name>.js` at the tarball root per workflow declared in the manifest. The endpoint SHALL atomically replace the tenant's entire workflow set: every workflow present in the new manifest is registered; every workflow previously registered for the tenant but absent from the new manifest is retired (see `workflow-registry` "Refcounted runners for hot-swap").

The handler SHALL extract the archive into a file map and pass it, together with `<tenant>`, to the `WorkflowRegistry.register(tenant, files)` method for validation, atomic persistence, and registration. Validation SHALL be all-or-nothing: if **any** workflow in the tarball fails validation, the entire upload SHALL be rejected with `422` and the existing tenant bundle (if any) SHALL remain unchanged.

The `<tenant>` path parameter SHALL be validated against the tenant identifier regex (see `tenant-model` "Tenant identifier format"); non-matching values SHALL receive `404 Not Found`. The caller SHALL be a member of `<tenant>` per the membership predicate (see `tenant-model` "Tenant membership predicate"); non-members SHALL receive `404 Not Found` (indistinguishable from unknown tenant to avoid enumeration).

Error responses SHALL include a JSON body. A `415` response SHALL include `{ "error": <string> }`. A `422` response SHALL include `{ "error": <string> }` where `<string>` is a specific reason for the failure (e.g., `missing manifest.json`, `missing workflow module: <path>`, or `invalid manifest: <details>`). When the `422` is caused by manifest validation failing the `ManifestSchema`, the body SHALL additionally include `issues: Array<{ path: Array<string | number>, message: string }>` derived from the underlying Zod validation issues.

#### Scenario: Successful tenant upload

- **WHEN** a valid tar.gz archive with a correct tenant `manifest.json` and all referenced `.js` files is posted to `POST /api/workflows/acme` by a caller whose `UserContext.orgs` includes `"acme"`
- **THEN** the runtime SHALL respond with `204 No Content`
- **AND** every workflow in the tenant manifest SHALL be registered under tenant `"acme"`
- **AND** any previously-registered "acme" workflows absent from the new manifest SHALL be retired

#### Scenario: Invalid tenant identifier

- **WHEN** a request is posted to `POST /api/workflows/foo..bar` (invalid charset)
- **THEN** the runtime SHALL respond with `404 Not Found`
- **AND** the handler SHALL NOT attempt to parse the archive

#### Scenario: Caller is not a member of the tenant

- **WHEN** a caller whose `UserContext.orgs = ["contoso"]` and `UserContext.name = "alice"` posts to `POST /api/workflows/acme`
- **THEN** the runtime SHALL respond with `404 Not Found`
- **AND** the response body SHALL NOT reveal whether the tenant exists

#### Scenario: Caller is the pseudo-tenant (their own login)

- **WHEN** a caller with `UserContext.name = "alice"` posts to `POST /api/workflows/alice`
- **THEN** the runtime SHALL accept the request (membership predicate is satisfied)
- **AND** the upload SHALL proceed to validation and registration

#### Scenario: Invalid gzip/tar archive

- **WHEN** the request body is not a valid gzip or tar archive
- **THEN** the runtime SHALL respond with `415 Unsupported Media Type`
- **AND** the response body SHALL be `{ "error": "Not a valid gzip/tar archive" }`

#### Scenario: Tenant manifest fails validation

- **WHEN** the archive contains a `manifest.json` that is missing, malformed, or does not pass `ManifestSchema` validation
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL include `error` naming the specific failure
- **AND** when the failure is a `ManifestSchema` validation error, the response body SHALL include `issues: Array<{ path, message }>`
- **AND** the existing tenant bundle (if any) SHALL remain unchanged

#### Scenario: Referenced workflow module missing from archive

- **WHEN** the tenant manifest references a workflow module `daily-report.js` but the archive does not contain that file at the tarball root
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity`
- **AND** the response body SHALL be `{ "error": "missing workflow module: daily-report.js" }` (or an equivalent specific message naming the missing path)
- **AND** the existing tenant bundle SHALL remain unchanged

#### Scenario: One bad workflow rejects the whole upload

- **WHEN** a tenant tarball contains three workflow entries and exactly one of them fails validation (e.g. missing module file)
- **THEN** the runtime SHALL respond with `422 Unprocessable Entity` identifying the bad workflow
- **AND** none of the three workflows SHALL be applied
- **AND** the existing tenant bundle SHALL remain unchanged

### Requirement: Hot reload after upload

After a successful upload, the `WorkflowRegistry` SHALL make the tenant's new workflow set available immediately using refcounted hot-swap semantics (see `workflow-registry` "Refcounted runners for hot-swap"). New events SHALL be matched against the updated action list. Invocations already in flight SHALL continue on their prior runner until they emit a terminal event.

#### Scenario: New triggers match uploaded workflows

- **WHEN** tenant "acme" is uploaded with workflow "foo" declaring HTTP trigger path `"orders"`
- **AND** a request is subsequently sent to `POST /webhooks/acme/foo/orders`
- **THEN** the handler SHALL be invoked in "foo"'s new sandbox

#### Scenario: Replaced tenant bundle takes effect for new invocations

- **WHEN** tenant "acme" is re-uploaded, replacing a previously uploaded "acme"
- **AND** a new trigger arrives matching a workflow still present in the new manifest
- **THEN** the new invocation SHALL execute in the new version's sandbox

#### Scenario: In-flight invocation completes with old code

- **WHEN** tenant "acme" is re-uploaded while an invocation from the old "acme/foo" is executing
- **THEN** the in-flight invocation SHALL complete using the old code
- **AND** the old sandbox SHALL be disposed once the invocation emits a terminal event (refcount=0)

#### Scenario: Workflow removed by re-upload returns 404 for new triggers

- **WHEN** tenant "acme" is re-uploaded with a manifest that omits workflow "old"
- **AND** a request is sent to `POST /webhooks/acme/old/<path>`
- **THEN** the runtime SHALL respond with `404 Not Found`
