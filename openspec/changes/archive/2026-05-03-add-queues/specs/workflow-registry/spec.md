## ADDED Requirements

### Requirement: Atomic queue file lifecycle on tenant registration

When `registerTenant(tenant, files)` succeeds, the workflow registry SHALL diff the previous manifest's queue declarations against the new manifest's queue declarations for each workflow and perform the following filesystem operations before returning success:

- For each queue **added** in the new manifest: create an empty file at `<root>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson` with `mkdir -p` for parent directories, `open(path, 'a')` to create, `close`, and `fsync(parentDir)`.
- For each queue **removed** from the new manifest: `unlink` the file at the canonical path (tolerating `ENOENT` for crash-resume idempotence) and `fsync(parentDir)`.
- For each workflow **removed** from the manifest: `rm -rf` the workflow's queue subtree.

The registry SHALL NOT consider an upload successful until all such filesystem effects have completed.

#### Scenario: Add queue on upload

- **GIVEN** a workflow has no queues registered
- **WHEN** an upload registers a workflow declaring `defineQueue({name: "jobs", schema})`
- **THEN** after `registerTenant` returns success, the file at `<root>/queues/<owner>/<repo>/<workflow>/jobs.ndjson` SHALL exist and be zero-byte
- **AND** the parent directory SHALL have been `fsync`'d

#### Scenario: Remove queue on upload

- **GIVEN** a workflow registered with `defineQueue({name: "jobs"})` and a non-empty queue file
- **WHEN** an upload registers a new manifest without that queue declaration
- **THEN** after `registerTenant` returns success, the queue file SHALL be `unlink`'d
- **AND** the queue's items SHALL be unrecoverable from the runtime

#### Scenario: Remove workflow drops its queue subtree

- **GIVEN** a workflow with several queue files
- **WHEN** an upload removes the workflow entirely from the manifest
- **THEN** the workflow's queue directory `<root>/queues/<owner>/<repo>/<workflow>/` SHALL be removed recursively

### Requirement: Boot reconciliation sweep for queue files

After `registry.recover()` runs at startup, the registry SHALL invoke a queue reconciliation sweep that, for each loaded workflow, walks `<root>/queues/<owner>/<repo>/<workflow>/`, unlinks any file whose stem is not a declared queue name in the workflow's current manifest, and creates empty files for any declared queue whose file is missing. The sweep SHALL tolerate a missing `<root>/queues/` directory.

The sweep SHALL log one info-level entry per file unlinked and one per file created, including `owner`, `repo`, `workflow`, `queueName`, and the action taken.

#### Scenario: Missing root directory

- **GIVEN** the runtime starts on a host where `<root>/queues/` does not exist (fresh deployment)
- **WHEN** the boot sweep runs
- **THEN** the sweep SHALL complete without error
- **AND** SHALL NOT create the `<root>/queues/` directory until a queue is actually declared

#### Scenario: Reconcile orphan and missing files

- **GIVEN** a workflow currently declares queues `jobs` and `emails`
- **AND** the on-disk subtree contains `jobs.ndjson` (with content), `emails.ndjson` (missing), and `old.ndjson` (orphan from a removed declaration)
- **WHEN** the boot sweep runs
- **THEN** `old.ndjson` SHALL be unlinked
- **AND** `emails.ndjson` SHALL be created as a zero-byte file
- **AND** `jobs.ndjson` SHALL be left untouched
- **AND** info logs SHALL be emitted for the unlink and the create
