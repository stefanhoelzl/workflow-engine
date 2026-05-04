## ADDED Requirements

### Requirement: Host-side read-only inspection

The runtime MAY read queue files for host-side inspection (e.g. the `/queue` UI surface). Such reads SHALL be the only host-side path that observes queue contents outside of the `put`/`get` lifecycle code, and SHALL conform to the following invariants:

- **Read-only**: the inspection path SHALL NOT modify file contents, file metadata, or filesystem state. It SHALL NOT use `appendFile`, `writeFile`, `rename`, `unlink`, `truncate`, or any other mutating syscall against `<PERSISTENCE_PATH>/queues/`.
- **Non-blocking**: the inspection path SHALL NOT acquire any advisory or exclusive lock that could block a concurrent guest `put` or `get`. The reader SHALL open files for read only.
- **Partial-line tolerant**: when reading a queue file concurrently with a `put` (which appends one line per call), the reader MAY observe a partial trailing line. The inspection path SHALL skip any line whose `JSON.parse` throws and SHALL surface the remaining valid items to the caller. Items that fail schema validation are out of scope for this requirement (they are dropped by `get` per the existing "Schema validation on get" requirement before they could appear in inspection results).
- **Rename-safe**: when reading a queue file concurrently with a `get` (which performs `writeFile(tmp) + rename`), POSIX `open()` semantics guarantee the reader observes either the pre-rename or post-rename inode in full. The inspection path SHALL rely on this guarantee and SHALL NOT introduce coordination beyond it.

The guest workflow code SHALL NOT have access to any inspection or peek operation. The guest-facing `Queue<T>` interface SHALL expose exactly `put` and `get`; no `peek`, `list`, `count`, `inspect`, or equivalent operation SHALL be added to the SDK or to the queue plugin's host-call surface.

#### Scenario: Guest code has no peek API

- **GIVEN** a workflow declaring `const jobs = defineQueue({name: "jobs", schema})`
- **WHEN** workflow code attempts to call `jobs.peek()`, `jobs.list()`, `jobs.count()`, or any inspection method
- **THEN** the operation SHALL fail at TypeScript compile time (no such method on `Queue<T>`)
- **AND** at runtime no such method SHALL exist on the handle

#### Scenario: Host inspection observes committed lines during concurrent put

- **GIVEN** a queue file containing two committed lines `{"a":1}\n{"b":2}\n`
- **WHEN** a guest `put({"c":3})` is in flight (the appendFile syscall has not yet returned)
- **AND** a host-side inspection read is issued concurrently
- **THEN** the inspection SHALL observe at least the two committed items `{a:1}` and `{b:2}`
- **AND** the inspection SHALL NOT throw or surface a parse error if the file contains a partial trailing line — the partial line SHALL be silently dropped
- **AND** the guest `put` SHALL complete normally without delay attributable to the inspection read

#### Scenario: Host inspection during concurrent get observes consistent inode

- **GIVEN** a queue file containing items `[A, B, C]`
- **WHEN** a guest `get()` performs its `writeFile(tmp) + rename` sequence
- **AND** a host-side inspection read is issued concurrently
- **THEN** the inspection SHALL observe either the pre-rename file (containing `[A, B, C]`) or the post-rename file (containing `[B, C]`), in full
- **AND** the inspection SHALL NOT observe a torn mix of the two states

#### Scenario: Inspection read does not modify the queue file

- **GIVEN** a queue file containing items `[A, B, C]` with mtime `T0`
- **WHEN** a host-side inspection read completes
- **THEN** the file's content SHALL still be `[A, B, C]`
- **AND** the file's mtime SHALL still be `T0` (no write occurred)
- **AND** a subsequent guest `get()` SHALL pop `A`
