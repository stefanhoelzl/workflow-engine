<!--
Historical note (superseded): This delta proposed a breaking migration from
`pending/`/`archive/` to `events/pending/`/`events/archive/`, and a
`workflows/{name}/` unpacked layout. That migration was NOT implemented.
The canonical storage-backend layout is `openspec/specs/storage-backend/spec.md`:
event prefixes remain `pending/` and `archive/`, and tenant bundles are stored
at `workflows/{tenant}.tar.gz`. This file is kept verbatim as a historical
record of the proposal at the time of archival.
-->

## MODIFIED Requirements

### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following methods:
- `init(): Promise<void>` — initialize the backend (create directories, verify access)
- `write(path: string, data: string): Promise<void>` — write data atomically to a path
- `read(path: string): Promise<string>` — read data from a path
- `list(prefix: string): AsyncIterable<string>` — yield all paths under a prefix recursively, one per iteration
- `remove(path: string): Promise<void>` — remove a path
- `move(from: string, to: string): Promise<void>` — move a path from source to destination

Paths SHALL use forward-slash separators (e.g. `events/pending/000001_evt_abc.json`).

#### Scenario: Interface contract

- **GIVEN** a `StorageBackend` implementation
- **WHEN** `write("dir/file.json", "content")` is called followed by `read("dir/file.json")`
- **THEN** `read` SHALL return `"content"`

#### Scenario: List yields matching paths recursively

- **GIVEN** files at `workflows/foo/manifest.json`, `workflows/foo/actions/handle.js`, and `events/pending/001.json`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/manifest.json"` and `"workflows/foo/actions/handle.js"`
- **AND** it SHALL NOT yield `"events/pending/001.json"`

#### Scenario: Move relocates a file

- **GIVEN** a file at `events/pending/a.json`
- **WHEN** `move("events/pending/a.json", "events/archive/a.json")` is called
- **THEN** `read("events/archive/a.json")` SHALL return the original content
- **AND** `list("events/pending/")` SHALL NOT yield `"events/pending/a.json"`

#### Scenario: Remove deletes a file

- **GIVEN** a file at `events/pending/a.json`
- **WHEN** `remove("events/pending/a.json")` is called
- **THEN** `list("events/pending/")` SHALL NOT yield `"events/pending/a.json"`

### Requirement: Filesystem backend

The system SHALL provide a filesystem-backed `StorageBackend` implementation created via a factory function that accepts a root directory path.

- `init` SHALL create the root directory recursively if it does not exist
- `write` SHALL use a write-then-rename pattern (write to `<path>.tmp`, then rename to `<path>`) for atomicity
- `read` SHALL read UTF-8 file content
- `list` SHALL yield paths recursively relative to the root directory using `readdir({ recursive: true })`
- `remove` SHALL delete the file using `fs.unlink`
- `move` SHALL use `fs.rename`

#### Scenario: Atomic write survives crash

- **GIVEN** a filesystem backend
- **WHEN** the process crashes during `write("events/pending/file.json", data)`
- **THEN** either the complete file exists or only a `.tmp` file remains
- **AND** no partial JSON is written to the target path

#### Scenario: Init creates directories

- **GIVEN** a filesystem backend with root `/data/storage`
- **WHEN** `init()` is called
- **THEN** the directory `/data/storage` SHALL exist

#### Scenario: Recursive listing

- **GIVEN** a filesystem backend with files at `workflows/foo/manifest.json` and `workflows/foo/actions/handle.js`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/manifest.json"` and `"workflows/foo/actions/handle.js"`

## ADDED Requirements

### Requirement: Storage layout with events and workflows prefixes

Event persistence SHALL use `events/pending/` and `events/archive/` prefixes (previously `pending/` and `archive/`). Workflow storage SHALL use `workflows/{name}/` prefix. This is a **BREAKING** change to the storage layout.

#### Scenario: Event written to events prefix

- **WHEN** a pending event is persisted
- **THEN** it SHALL be written to `events/pending/{counter}_evt_{id}.json`

#### Scenario: Event archived to events prefix

- **WHEN** a terminal event is persisted
- **THEN** it SHALL be written to `events/archive/{counter}_evt_{id}.json`

#### Scenario: Workflow stored under workflows prefix

- **WHEN** workflow "foo" is uploaded
- **THEN** its manifest SHALL be stored at `workflows/foo/manifest.json`
- **AND** its action files SHALL be stored at `workflows/foo/actions/{name}.js`
