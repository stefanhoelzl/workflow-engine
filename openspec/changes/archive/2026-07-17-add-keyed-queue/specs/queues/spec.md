## MODIFIED Requirements

### Requirement: FIFO ordering

The runtime SHALL pop items in the order they were enqueued **within a key partition** (first put, first got, per key). `get(key)` SHALL return the oldest item whose `key` equals the argument; items under any other key SHALL NOT be popped, observed, or reordered by that call. `get()` with no key SHALL be equivalent to `get('')` and SHALL pop only from the unkeyed partition. Concurrent puts within one invocation via `Promise.all` MAY land in any order relative to each other; the runtime SHALL preserve only the order in which puts crossed the host bridge.

#### Scenario: FIFO across invocations within a key

- **GIVEN** invocation 1 calls `put(A)` then `put(B)` then returns (both unkeyed)
- **AND** invocation 2 starts and calls `put(C)` (unkeyed)
- **WHEN** invocation 3 calls `get()` three times
- **THEN** the three results SHALL be `A`, then `B`, then `C` in that order

#### Scenario: Keys are independent FIFO partitions

- **GIVEN** `put(A, "x")` then `put(B, "y")` then `put(C, "x")` in that order
- **WHEN** `get("x")` is called
- **THEN** it SHALL return `A` (the oldest item under key `"x"`), not `B`
- **AND** a subsequent `get("y")` SHALL return `B`
- **AND** a subsequent `get("x")` SHALL return `C`

### Requirement: At-most-once pop semantics

The runtime SHALL atomically remove an item from its key partition and return it to the caller of `get(key)`. If the caller's invocation crashes after `get()` returns but before the item is processed, the item SHALL NOT reappear in the queue. A key partition with no items SHALL return `undefined` from `get(key)`; the runtime SHALL NOT throw on an empty partition, even when other keys of the same queue hold items. Atomicity is provided by the single autocommit `DELETE … RETURNING` statement scoped to the tenant tuple and the key (see "Durability contract").

#### Scenario: Successful get removes the item from its partition

- **GIVEN** a queue with unkeyed items `[A, B, C]`
- **WHEN** the handler calls `await q.get()` and receives `A`
- **THEN** the `queue_items` rows for the queue's unkeyed partition SHALL contain only `B` and `C` after `get` returns
- **AND** any subsequent `get()` from any invocation SHALL pop `B` next

#### Scenario: Empty partition returns undefined even when other keys have items

- **GIVEN** a queue holding items only under key `"alice"`
- **WHEN** the handler calls `await q.get("bob")`
- **THEN** the call SHALL resolve with `undefined`
- **AND** no error event SHALL be emitted
- **AND** the items under key `"alice"` SHALL remain unremoved

#### Scenario: At-most-once on invocation crash

- **GIVEN** a queue with item `A` under key `"k"`
- **WHEN** the handler calls `await q.get("k")` and receives `A`
- **AND** the trigger handler then throws an unhandled error
- **THEN** item `A` SHALL NOT be present in the queue
- **AND** the trigger SHALL be marked failed, but the queue state SHALL reflect the successful pop

### Requirement: Tenant-scoped accessor

Every host-side read or write of `queue_items` SHALL go through a typed accessor that requires `(owner, repo, workflow, queue)` as a compile-time argument tuple and injects those values as `WHERE` clauses on every statement. The accessor SHALL be the only module that constructs SQL against `queue_items`; raw `db.selectFrom("queue_items")`, `db.insertInto("queue_items")`, `db.deleteFrom("queue_items")`, and `db.updateTable("queue_items")` (or equivalent driver-level access) SHALL be forbidden outside the accessor module and SHALL be enforced by a Biome lint rule. The accessor SHALL NOT expose overloads accepting partial tuples.

The `key` partition selector SHALL be a **separate argument**, distinct from the tenant tuple and never part of it. `key` SHALL be a required, explicit `string` at the accessor layer (the unkeyed partition is the empty string `''`; the SDK guest shim is the sole place that defaults an omitted key to `''`). `key` SHALL be injected as an additional predicate **only** on the partition-scoped operations — `put` (as the inserted column value) and `get` (as an added `WHERE` predicate and within the `MIN(seq)` subquery) — and SHALL be returned by `list`. The queue-level operations `count`, `workflowDepth`, `removeDeclaration`, and `reconcile` SHALL remain **key-blind**: they operate across all keys of the queue so that re-upload cleanup and boot reconciliation are unaffected by partitioning.

#### Scenario: Accessor signature refuses partial scope at compile time

- **WHEN** code attempts to call `queueStore.put({owner: "acme", repo: "foo"}, item, "")` without `workflow` and `queue` fields
- **THEN** TypeScript SHALL fail the build with a type error on the missing properties
- **AND** the call SHALL NOT compile

#### Scenario: Lint rule rejects raw queue_items access

- **GIVEN** a file outside the queue accessor module
- **WHEN** the file contains `db.selectFrom("queue_items")` or any equivalent expression naming the `queue_items` table
- **THEN** `pnpm lint` SHALL fail with a rule violation
- **AND** the violation message SHALL direct the author to use the accessor

#### Scenario: Cross-tenant data is invisible across all accessor methods

- **GIVEN** items inserted via accessor with scope `(acme, foo, build, jobs)`
- **WHEN** any accessor method (`put`, `get`, `count`, `list`, `removeDeclaration`, `reconcile`) is invoked with scope `(other, bar, build, jobs)` or `(acme, foo, build, other)` or any other differing tuple
- **THEN** the call SHALL NOT return, modify, or count any of those items
- **AND** an integration test SHALL fuzz this property across at least 20 distinct cross-tenant tuple pairs

#### Scenario: Key partitions are isolated within a tenant

- **GIVEN** items inserted under scope `(acme, foo, build, jobs)` with key `"a"` and, separately, key `"b"`
- **WHEN** `get((acme, foo, build, jobs), "a")` is called
- **THEN** only the oldest item under key `"a"` SHALL be returned and removed
- **AND** the items under key `"b"` SHALL be neither returned nor removed nor reordered

#### Scenario: GC operations ignore the key partition

- **GIVEN** a queue `(acme, foo, build, jobs)` holding items under keys `"a"`, `"b"`, and `''`
- **WHEN** `removeDeclaration` runs for that queue (or `reconcile` finds the queue undeclared)
- **THEN** the DELETE SHALL remove every row of the queue regardless of key
- **AND** `count` and `workflowDepth` for the queue SHALL include rows of every key

### Requirement: Item provenance metadata

Every `queue_items` row SHALL carry metadata fields stamped by the host at the moment of `put`: `enqueuedAt` (TEXT, ISO-8601), `invocationId` (the producing invocation's id from the dispatch context), `triggerKind` (the producing trigger's kind, as a free-form string), and `triggerName` (the producing trigger's declared export name). The metadata SHALL be visible to operators via the `/queue` UI (see `queues-ui`) and SHALL be queryable via the tenant-scoped accessor.

Each row SHALL also carry its `key` — the caller-supplied partition selector. The `key` is **addressing** (which recipient/partition an item is *for*), distinct in meaning from the producer-provenance fields (which invocation/trigger *produced* it). The `key` SHALL NOT be schema-validated (it is a routing label, not payload).

The metadata and the `key` SHALL NOT be exposed to guest code via the `get()` return value. The guest-facing `Queue<T>` contract SHALL be `put(item: T, key?: string) → void` and `get(key?: string) → T | undefined`; the metadata SHALL be host-only / UI-only, and `get(key)` SHALL return the bare item value (the caller already holds the `key` it asked for).

`triggerKind` SHALL be stored as an open string with no database-level enum constraint. Unknown or future trigger kinds (e.g. a future "queue" trigger kind for queue-consumer triggers) SHALL be accepted and rendered with the default-glyph fallback in the UI per `ui-foundation` §"Distinct visual indicator per trigger kind".

#### Scenario: Host stamps metadata and key at put

- **GIVEN** a guest invocation `inv-a3f2` triggered by cron trigger `everyFiveMinutes`
- **WHEN** the guest calls `await q.put({url: "https://example.com"}, "alice")`
- **THEN** the inserted `queue_items` row SHALL have `invocationId = "inv-a3f2"`, `triggerKind = "cron"`, `triggerName = "everyFiveMinutes"`, `key = "alice"`, and `enqueuedAt` within 100 ms of the host's INSERT time

#### Scenario: Guest get() returns only the item value

- **GIVEN** a queue containing one item under key `"alice"` with full producer metadata
- **WHEN** the guest calls `await q.get("alice")`
- **THEN** the return value SHALL equal the original item value passed to `put`
- **AND** the return value SHALL NOT be wrapped in an object containing metadata fields or the key
- **AND** the metadata fields and the key SHALL NOT be visible to the guest under any property name

### Requirement: Storage layout

The runtime SHALL persist queue contents as rows in a single `queue_items` table inside the runtime's libSQL database at `<PERSISTENCE_PATH>/events.db` (shared with the event store). The table SHALL have the following schema:

- `seq INTEGER PRIMARY KEY AUTOINCREMENT`
- `owner TEXT NOT NULL`
- `repo TEXT NOT NULL`
- `workflow TEXT NOT NULL`
- `queue TEXT NOT NULL`
- `key TEXT NOT NULL DEFAULT ''`
- `enqueuedAt TEXT NOT NULL`
- `invocationId TEXT NOT NULL`
- `triggerKind TEXT NOT NULL`
- `triggerName TEXT NOT NULL`
- `item TEXT NOT NULL`

The `key` column SHALL be added to pre-existing databases by migration `0002_queue_key` (see the `database-migrations` capability) as a lossless `ALTER TABLE queue_items ADD COLUMN key TEXT NOT NULL DEFAULT ''`; rows written before the migration SHALL read as the unkeyed partition (`key = ''`). The `key` SHALL be the empty string for the unkeyed partition and SHALL NEVER be NULL (a `NULL` key would never satisfy the `key = ''` predicate that `get()` relies on).

A secondary index over `(owner, repo, workflow, queue, key, seq)` SHALL exist to bound per-partition FIFO scans. The prior `(owner, repo, workflow, queue, seq)` index MAY be retained or dropped; it is immaterial at the workflow-wide depth cap.

Column names use camelCase to match the existing event-store table convention (events table: `workflowSha`, etc.). The table name uses snake_case (`queue_items`) following standard SQL convention for multi-word identifiers.

The `seq` column SHALL be an `INTEGER PRIMARY KEY AUTOINCREMENT`: one monotonic counter across all queues, dense in commit order, used solely for FIFO ordering, never exposed to guests, never displayed to operators. The `AUTOINCREMENT` keyword is REQUIRED — without it, SQLite/libSQL may recycle a freed rowid after the DELETEs that popping causes, which would break monotonicity. (DuckDB's `CREATE SEQUENCE` / `nextval()` is not available in libSQL; `INTEGER PRIMARY KEY AUTOINCREMENT` provides the equivalent observable behavior.)

A queue's *existence* SHALL be determined by its presence in the workflow's manifest (`declaredQueues`); the queue's row count in `queue_items` MAY be zero for a declared queue with no items. Keys are NOT declared — they are runtime values — so a queue MAY hold rows under any number of keys without any manifest change. No "empty file" or "queue row marker" SHALL be required.

The runtime SHALL own the `queue_items` table exclusively; no other capability SHALL write to it. The guest-facing `Queue<T>` interface SHALL expose exactly `put` and `get` (each accepting the optional `key` partition argument); no `peek`, `list`, `count`, or `inspect` operation SHALL be added to the SDK or the guest surface.

#### Scenario: Declared empty queue has zero rows

- **GIVEN** a workflow `acme/widgets/orders.ts` declaring `defineQueue({name: "jobs", schema})` with no items enqueued
- **WHEN** the runtime queries `SELECT COUNT(*) FROM queue_items WHERE (owner, repo, workflow, queue) = ('acme', 'widgets', 'orders', 'jobs')`
- **THEN** the result SHALL be 0
- **AND** the queue SHALL still be considered "declared and present" because the manifest declares it
- **AND** a subsequent `get()` SHALL return `undefined` without error

#### Scenario: key column exists with the unkeyed default

- **GIVEN** the schema after migration `0002_queue_key`
- **WHEN** the schema is inspected via `PRAGMA table_info(queue_items)` and `PRAGMA index_list(queue_items)`
- **THEN** a column `key TEXT NOT NULL DEFAULT ''` SHALL exist
- **AND** a composite index over `(owner, repo, workflow, queue, key, seq)` SHALL exist
- **AND** rows inserted before the migration SHALL read `key = ''`

#### Scenario: seq is monotonic and not reused after a pop

- **GIVEN** a queue with three items at `seq` 1, 2, 3
- **WHEN** the two oldest items are popped (deleting `seq` 1 and 2) and a new item is then put
- **THEN** the new item SHALL receive a `seq` strictly greater than 3
- **AND** no freed `seq` value (1 or 2) SHALL be reused

## ADDED Requirements

### Requirement: Key size cap

The runtime SHALL reject `put` and `get` requests whose `key`, measured as UTF-8 bytes, exceeds 128 bytes. The cap SHALL be enforced host-side in the queue host handler, before any statement touches `queue_items`, and SHALL be independent of the 1024-byte per-item cap (a long key SHALL NOT reduce the item budget). Rejection SHALL surface as a typed `QueueError` to the guest with `code = "queue.keyTooLarge"`, and no row SHALL be inserted (for `put`) or removed (for `get`).

The `key` SHALL NOT be constrained by a character regex: it is a column value, never a filesystem or URL path, so no traversal guard is required; only the length bound applies. Because the workflow-wide depth cap bounds total rows regardless of key cardinality, a tampered guest inventing unlimited distinct keys SHALL NOT amplify storage beyond that cap.

#### Scenario: Key exactly at the cap is accepted

- **WHEN** a `put(item, key)` whose `key` is exactly 128 UTF-8 bytes is issued
- **THEN** the call SHALL succeed
- **AND** the `queue_items` table SHALL contain the new row with that `key`

#### Scenario: Key over the cap is rejected

- **WHEN** a `put(item, key)` whose `key` is 129 UTF-8 bytes is issued
- **THEN** the host handler SHALL throw `QueueError` with `code = "queue.keyTooLarge"`
- **AND** no row SHALL be inserted into `queue_items`

#### Scenario: A long key does not consume item budget

- **GIVEN** an item whose `JSON.stringify` length is exactly 1024 bytes and a `key` of 100 bytes
- **WHEN** `put(item, key)` is issued
- **THEN** the call SHALL succeed (the key is not counted against the 1024-byte item cap)
