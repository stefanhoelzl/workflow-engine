# Queues Specification

## Purpose

Provide per-workflow durable FIFO queues identified by `(owner, repo, workflow, queueName)` (sha-independent so re-uploads preserve data). Queue contents live as NDJSON files at `<PERSISTENCE_PATH>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson`, owned exclusively by the runtime. Semantics are FIFO + at-most-once: a successful `get` atomically removes the item via tmpfile + rename and never re-delivers on crash. Items are validated against the queue's JSON Schema both on `put` (reject) and on `get` (drop the bad head and surface it in the typed error). Caps are 1024 UTF-8 bytes per item and 1000 items per queue. Durability is fsync-per-op (append+fsync on put; fsync(tmp)+rename+fsync(parent) on get). The workflow registry creates and unlinks queue files atomically with manifest persistence on upload, and a boot reconciliation sweep brings the on-disk subtree back in sync with the current manifest after crash-resume. Workflow code SHALL have no inspection or peek operations — `put` and `get` are the only guest-facing surface. The runtime MAY read queue files from the host side for read-only inspection (e.g. the `/queue` UI); see the "Host-side read-only inspection" requirement below for the non-mutating, non-blocking, partial-line-tolerant contract.

## Requirements


### Requirement: Queue identity and scope

The runtime SHALL identify a queue by the tuple `(owner, repo, workflow, queueName)`. The workflow `sha` SHALL NOT be part of the identity, so re-uploading the same workflow with a new bundle preserves the queue's data. Queues SHALL be scoped to one workflow file; no cross-workflow, cross-(owner, repo), or global queues exist.

#### Scenario: Re-upload preserves queue data

- **GIVEN** a workflow `acme/widgets/orders.ts` declaring `defineQueue({name: "jobs", schema})` with three items already enqueued under `sha = A`
- **WHEN** the workflow is re-uploaded with a code change producing `sha = B`, with the same `defineQueue({name: "jobs"})` declaration
- **THEN** the file at `<root>/queues/acme/widgets/orders/jobs.ndjson` SHALL retain the three items
- **AND** subsequent `get` calls SHALL pop the items in their original FIFO order

#### Scenario: Cross-workflow access is impossible

- **GIVEN** workflow `acme/widgets/a.ts` declares `defineQueue({name: "jobs"})` and workflow `acme/widgets/b.ts` declares `defineQueue({name: "jobs"})`
- **WHEN** `b`'s handler calls `get()` on its `jobs` queue
- **THEN** the runtime SHALL resolve `<root>/queues/acme/widgets/b/jobs.ndjson` (not `…/a/jobs.ndjson`)
- **AND** items put by `a` SHALL NOT be visible to `b`

### Requirement: On-disk layout

The runtime SHALL persist queue contents at `<PERSISTENCE_PATH>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson`. Each line in the file SHALL be one `JSON.stringify`'d item terminated by `\n`. The runtime SHALL own the entire `<PERSISTENCE_PATH>/queues/` subtree; no other process or capability writes there.

#### Scenario: File path derivation

- **GIVEN** a queue declared as `defineQueue({name: "emailRetry", schema})` in workflow `acme/widgets/notifications.ts`
- **WHEN** the runtime needs to read or write the queue
- **THEN** the file path SHALL be `<PERSISTENCE_PATH>/queues/acme/widgets/notifications/emailRetry.ndjson`

#### Scenario: Newlines inside items do not break framing

- **GIVEN** an item whose JSON serialization contains the substring `\n` inside a string field
- **WHEN** the runtime appends the item via `JSON.stringify`
- **THEN** the literal newline SHALL be escaped as `\\n` per JSON encoding rules
- **AND** the line terminator SHALL be the only real `\n` in the appended bytes

### Requirement: FIFO ordering

The runtime SHALL pop items in the order they were enqueued (first put, first got). Concurrent puts within one invocation via `Promise.all` MAY land in any order relative to each other; the runtime SHALL preserve only the order in which puts crossed the host bridge.

#### Scenario: FIFO across invocations

- **GIVEN** invocation 1 calls `put(A)` then `put(B)` then returns
- **AND** invocation 2 starts and calls `put(C)`
- **WHEN** invocation 3 calls `get()` three times
- **THEN** the three results SHALL be `A`, then `B`, then `C` in that order

### Requirement: At-most-once pop semantics

The runtime SHALL atomically remove an item from the queue and return it to the caller of `get()`. If the caller's invocation crashes after `get()` returns but before the item is processed, the item SHALL NOT reappear in the queue. Empty queues SHALL return `undefined` from `get()`; the runtime SHALL NOT throw on empty.

#### Scenario: Successful get removes the item

- **GIVEN** a queue with items `[A, B, C]`
- **WHEN** the handler calls `await q.get()` and receives `A`
- **THEN** the on-disk file SHALL contain only `B` and `C` after `get` returns
- **AND** any subsequent `get` from any invocation SHALL pop `B` next

#### Scenario: Empty queue returns undefined

- **GIVEN** a queue with no items
- **WHEN** the handler calls `await q.get()`
- **THEN** the call SHALL resolve with `undefined`
- **AND** no error event SHALL be emitted

#### Scenario: At-most-once on invocation crash

- **GIVEN** a queue with item `A`
- **WHEN** the handler calls `await q.get()` and receives `A`
- **AND** the trigger handler then throws an unhandled error
- **THEN** item `A` SHALL NOT be present in the queue
- **AND** the trigger SHALL be marked failed, but the queue state SHALL reflect the successful pop

### Requirement: Durability contract

A successful return from `put` SHALL guarantee that the item survives `SIGKILL`, host crash, or power loss. A successful return from `get` SHALL guarantee that the popped item is durably removed from the queue. The runtime SHALL achieve this by `fsync`'ing the appended file on `put` and by `fsync`'ing the tmpfile, performing an atomic `rename`, and `fsync`'ing the parent directory on `get`.

#### Scenario: Put fsync before return

- **WHEN** the host bridge handles a `put` request
- **THEN** the worker SHALL `open(path, 'a')`, `write(line + "\n")`, `fsync(fd)`, `close(fd)`, in that order
- **AND** the bridge response SHALL NOT be sent before `fsync` returns successfully

#### Scenario: Get rename is crash-atomic

- **GIVEN** a queue file at `path` with three items
- **WHEN** the host bridge handles a `get` request
- **AND** the runtime is `SIGKILL`'d at any point during the get
- **THEN** on subsequent boot, the file at `path` SHALL contain either the original three items or exactly the two-item remainder (popped item gone)
- **AND** the file SHALL NEVER contain a torn or partial state

### Requirement: Per-item size cap

The runtime SHALL reject `put` requests whose item, after `JSON.stringify`, exceeds 1024 UTF-8 bytes. Rejection SHALL surface as a typed `QueueItemTooLarge` error to the guest, and the item SHALL NOT be appended to the file.

#### Scenario: Item exactly at the cap is accepted

- **WHEN** an item whose `JSON.stringify` length is exactly 1024 bytes is `put`
- **THEN** the call SHALL succeed
- **AND** the file SHALL contain the new item

#### Scenario: Item over the cap is rejected

- **WHEN** an item whose `JSON.stringify` length is 1025 bytes is `put`
- **THEN** the host bridge SHALL throw `QueueItemTooLarge` with `code = "queue.itemTooLarge"`
- **AND** no bytes SHALL be written to the queue file
- **AND** a `system.error` event with `name = "queue.put"` SHALL be emitted

### Requirement: Per-queue depth cap

The runtime SHALL reject `put` requests when the target queue already contains 1000 items. Rejection SHALL surface as a typed `QueueFull` error to the guest, and the item SHALL NOT be appended.

#### Scenario: Cap reached

- **GIVEN** a queue file containing exactly 1000 lines
- **WHEN** another `put` is attempted
- **THEN** the host bridge SHALL throw `QueueFull` with `code = "queue.full"`
- **AND** the file SHALL still contain exactly 1000 lines

### Requirement: Schema validation on put

The runtime SHALL validate every item against the queue's JSON Schema (compiled host-side from the workflow's manifest at sandbox construction) before writing to the file. Validation failure SHALL throw `QueueSchemaMismatch` with `code = "queue.schemaMismatch"` to the guest, and the item SHALL NOT be persisted.

#### Scenario: Invalid put rejected

- **GIVEN** a queue with schema `z.object({url: z.string().url()})`
- **WHEN** `put({url: "not-a-url"})` is called
- **THEN** the host bridge SHALL throw `QueueSchemaMismatch`
- **AND** the file SHALL be unchanged

### Requirement: Schema validation on get; bad item dropped

The runtime SHALL validate every popped item against the queue's CURRENT schema (the schema in force at `get` time, which may differ from the schema at `put` time after a re-upload) before returning. If validation fails, the item SHALL be dropped from the queue (atomically with the get's rename) and the runtime SHALL throw `QueueSchemaMismatch` to the guest. The error payload SHALL carry the dropped item so the author can recover it from the corresponding `system.error` event.

#### Scenario: Schema regression drops the head item

- **GIVEN** a queue containing one item enqueued under schema `S1`
- **AND** the workflow has been re-uploaded with an incompatible schema `S2`
- **WHEN** `await q.get()` is called
- **THEN** the file SHALL no longer contain the item (it was removed by the rename)
- **AND** the bridge SHALL throw `QueueSchemaMismatch` with the dropped item embedded in the error payload
- **AND** a `system.error` event with `name = "queue.get"` SHALL be emitted carrying the same payload

### Requirement: QueueGone on orphaned in-flight invocations

When an invocation running on an orphaned sandbox (an older `sha` that was superseded by a re-upload that removed the queue declaration) calls `put` or `get`, the host bridge SHALL throw `QueueGone` with `code = "queue.gone"`. The plugin worker SHALL detect this via `ENOENT` from `open()`.

#### Scenario: Queue dropped during in-flight invocation

- **GIVEN** invocation 1 is in flight on `sha = A` and has not yet returned
- **WHEN** an upload bumps the workflow to `sha = B` and removes the `defineQueue({name: "jobs"})` declaration
- **AND** invocation 1 then calls `await jobs.put(item)`
- **THEN** the host bridge SHALL throw `QueueGone`
- **AND** the orphaned invocation's trigger SHALL be marked failed via the standard `trigger.error` path

### Requirement: QueueNotDeclared for unknown names

The host bridge SHALL reject `put` and `get` requests whose `name` does not match any queue in the per-sandbox declared list (built from the manifest at sandbox construction). Rejection SHALL throw `QueueNotDeclared` with `code = "queue.notDeclared"`.

#### Scenario: Bridge call with unknown queue name

- **GIVEN** the workflow declares `defineQueue({name: "jobs"})` but no `defineQueue({name: "ghost"})`
- **WHEN** the host bridge receives a request `{op: "put", name: "ghost", item: {}}` (e.g., via a tampered guest)
- **THEN** the bridge SHALL throw `QueueNotDeclared`
- **AND** no filesystem operation SHALL be attempted

### Requirement: Atomic upload-time file lifecycle

When the workflow registry processes an upload that adds a queue declaration, the registry SHALL create an empty file for the new queue at the canonical path before returning success. When an upload removes a queue declaration, the registry SHALL `unlink` the file. When a workflow is removed entirely, the registry SHALL remove the workflow's queue subtree. These filesystem effects SHALL be performed atomically with the manifest persistence.

#### Scenario: New queue declared

- **GIVEN** a workflow has no queues
- **WHEN** an upload introduces `defineQueue({name: "jobs", schema})`
- **THEN** after the upload returns 200, the file `<root>/queues/<owner>/<repo>/<workflow>/jobs.ndjson` SHALL exist with size zero
- **AND** the parent directory SHALL have been `fsync`'d

#### Scenario: Queue declaration removed

- **GIVEN** a workflow currently declares `defineQueue({name: "jobs"})` and the file contains 5 items
- **WHEN** an upload removes the declaration
- **THEN** after the upload returns 200, the file SHALL no longer exist
- **AND** the 5 items SHALL be unrecoverable from the runtime

### Requirement: Boot reconciliation sweep

After `registry.recover()` runs at startup, the runtime SHALL walk `<root>/queues/<owner>/<repo>/<workflow>/` for every loaded workflow, unlink any file whose stem is not a declared queue name, and create empty files for any declared queue whose file is missing. The sweep SHALL tolerate a missing `<root>/queues/` directory (treat as "no queues anywhere"). The sweep SHALL fsync each created file and the parent directory before returning.

#### Scenario: Orphan file from SIGKILL between manifest persist and unlink

- **GIVEN** an upload removed `defineQueue({name: "old"})` but `SIGKILL` hit between manifest persist and the `unlink`
- **WHEN** the runtime restarts and the boot sweep runs
- **THEN** `old.ndjson` SHALL be unlinked because `old` is not in the current manifest's queues
- **AND** the sweep SHALL log an info entry naming the removed file

#### Scenario: Missing file from SIGKILL between manifest persist and create

- **GIVEN** an upload introduced `defineQueue({name: "new"})` but `SIGKILL` hit between manifest persist and the file create
- **WHEN** the runtime restarts and the boot sweep runs
- **THEN** an empty `new.ndjson` SHALL be created
- **AND** the sweep SHALL fsync the file and parent directory

### Requirement: Sandbox plugin config shape

The runtime composer SHALL inject a frozen config into the queue plugin descriptor at sandbox construction containing `(owner, repo, workflow, queuesRoot, declaredQueues, validators)`. `declaredQueues` SHALL be the array of queue names from the workflow's manifest. `validators` SHALL be Ajv-compiled validator functions keyed by queue name, derived from the JSON Schemas in the manifest. The plugin worker SHALL refuse to operate against any queue name not in `declaredQueues`.

#### Scenario: Config built from manifest

- **GIVEN** a workflow with two declared queues `jobs` and `emails`
- **WHEN** the sandbox is constructed
- **THEN** the queue plugin's config SHALL contain `declaredQueues = ["jobs", "emails"]`
- **AND** `validators.jobs` SHALL be an Ajv-compiled validator for the `jobs` schema
- **AND** the config object SHALL be frozen via `Object.freeze`

### Requirement: Path-traversal defense in depth

The host bridge SHALL re-validate `name` against the queue-name regex `^[a-z][a-zA-Z0-9]*$` on every `put`/`get` call before constructing a path, even though the build pipeline already enforces the same regex. Validation failure SHALL throw `QueueNotDeclared`. The plugin worker SHALL open files with `O_NOFOLLOW` so that a symlink planted at the queue path causes `open` to fail rather than silently traverse.

#### Scenario: Tampered guest sends a traversal name

- **WHEN** the host bridge receives a request `{op: "get", name: "../../other-tenant/workflow/q"}`
- **THEN** the bridge SHALL throw `QueueNotDeclared` because the name fails the regex
- **AND** no `open()` syscall SHALL be issued

#### Scenario: Symlink at queue path

- **GIVEN** an operator has erroneously planted a symlink at `<root>/queues/acme/widgets/orders/jobs.ndjson` pointing into another tenant's tree
- **WHEN** the queue plugin attempts to `open` that path
- **THEN** the `open` SHALL fail with `ELOOP` due to `O_NOFOLLOW`
- **AND** the bridge SHALL surface the failure as `QueueGone` (the file did not open) rather than silently following the symlink

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
