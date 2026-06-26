## MODIFIED Requirements

### Requirement: Item provenance metadata

Every `queue_items` row SHALL carry metadata fields stamped by the host at the moment of `put`: `enqueuedAt` (TEXT, ISO-8601), `invocationId` (the producing invocation's id from the dispatch context), `triggerKind` (the producing trigger's kind, as a free-form string), and `triggerName` (the producing trigger's declared export name). The metadata SHALL be visible to operators via the `/queue` UI (see `queues-ui`) and SHALL be queryable via the tenant-scoped accessor.

The metadata SHALL NOT be exposed to guest code via the `get()` return value. The guest-facing `Queue<T>` contract SHALL remain `put(item: T) → void` and `get() → T | undefined`; the metadata SHALL be host-only / UI-only.

`triggerKind` SHALL be stored as an open string with no database-level enum constraint. Unknown or future trigger kinds (e.g. a future "queue" trigger kind for queue-consumer triggers) SHALL be accepted and rendered with the default-glyph fallback in the UI per `ui-foundation` §"Distinct visual indicator per trigger kind".

#### Scenario: Host stamps metadata at put

- **GIVEN** a guest invocation `inv-a3f2` triggered by cron trigger `everyFiveMinutes`
- **WHEN** the guest calls `await q.put({url: "https://example.com"})`
- **THEN** the inserted `queue_items` row SHALL have `invocationId = "inv-a3f2"`, `triggerKind = "cron"`, `triggerName = "everyFiveMinutes"`, and `enqueuedAt` within 100 ms of the host's INSERT time

#### Scenario: Guest get() returns only the item value

- **GIVEN** a queue containing one item with full producer metadata
- **WHEN** the guest calls `await q.get()`
- **THEN** the return value SHALL equal the original item value passed to `put`
- **AND** the return value SHALL NOT be wrapped in an object containing metadata fields
- **AND** the metadata fields SHALL NOT be visible to the guest under any property name

#### Scenario: Unknown future trigger kind is accepted

- **GIVEN** a hypothetical future dispatch context with `triggerKind = "queue"` (a kind the existing `TriggerKindIcon` registry does not yet know)
- **WHEN** the host stamps the row
- **THEN** the INSERT SHALL succeed (no DB-level enum rejection)
- **AND** the `/queue` UI SHALL render the row with `TriggerKindIcon`'s default-glyph fallback

### Requirement: Storage layout

The runtime SHALL persist queue contents as rows in a single `queue_items` table inside the runtime's libSQL database at `<PERSISTENCE_PATH>/events.db` (shared with the event store). The table SHALL have the following schema:

- `seq INTEGER PRIMARY KEY AUTOINCREMENT`
- `owner TEXT NOT NULL`
- `repo TEXT NOT NULL`
- `workflow TEXT NOT NULL`
- `queue TEXT NOT NULL`
- `enqueuedAt TEXT NOT NULL`
- `invocationId TEXT NOT NULL`
- `triggerKind TEXT NOT NULL`
- `triggerName TEXT NOT NULL`
- `item TEXT NOT NULL`

A secondary index over `(owner, repo, workflow, queue, seq)` SHALL exist to bound per-queue FIFO scans (replacing the prior composite primary key, which is now the single-column `seq` rowid).

Column names use camelCase to match the existing event-store table convention (events table: `workflowSha`, etc.). The table name uses snake_case (`queue_items`) following standard SQL convention for multi-word identifiers.

The `seq` column SHALL be an `INTEGER PRIMARY KEY AUTOINCREMENT`: one monotonic counter across all queues, dense in commit order, used solely for FIFO ordering, never exposed to guests, never displayed to operators. The `AUTOINCREMENT` keyword is REQUIRED — without it, SQLite/libSQL may recycle a freed rowid after the DELETEs that popping causes, which would break monotonicity. (DuckDB's `CREATE SEQUENCE` / `nextval()` is not available in libSQL; `INTEGER PRIMARY KEY AUTOINCREMENT` provides the equivalent observable behavior.)

A queue's *existence* SHALL be determined by its presence in the workflow's manifest (`declaredQueues`); the queue's row count in `queue_items` MAY be zero for a declared queue with no items. No "empty file" or "queue row marker" SHALL be required.

The runtime SHALL own the `queue_items` table exclusively; no other capability SHALL write to it. The guest-facing `Queue<T>` interface SHALL expose exactly `put` and `get`; no `peek`, `list`, `count`, or `inspect` operation SHALL be added to the SDK or the guest surface.

#### Scenario: Declared empty queue has zero rows

- **GIVEN** a workflow `acme/widgets/orders.ts` declaring `defineQueue({name: "jobs", schema})` with no items enqueued
- **WHEN** the runtime queries `SELECT COUNT(*) FROM queue_items WHERE (owner, repo, workflow, queue) = ('acme', 'widgets', 'orders', 'jobs')`
- **THEN** the result SHALL be 0
- **AND** the queue SHALL still be considered "declared and present" because the manifest declares it
- **AND** a subsequent `get()` SHALL return `undefined` without error

#### Scenario: seq is monotonic and not reused after a pop

- **GIVEN** a queue with three items at `seq` 1, 2, 3
- **WHEN** the two oldest items are popped (deleting `seq` 1 and 2) and a new item is then put
- **THEN** the new item SHALL receive a `seq` strictly greater than 3
- **AND** no freed `seq` value (1 or 2) SHALL be reused

#### Scenario: Newlines inside items do not break framing

- **GIVEN** an item whose `JSON.stringify` form contains the substring `\n` inside a string field
- **WHEN** the runtime inserts the item
- **THEN** the `item` column SHALL store the JSON value as TEXT
- **AND** subsequent retrieval via `SELECT item FROM queue_items WHERE seq = ?` SHALL yield the original string value verbatim (no FIFO framing concerns apply — rows are not line-delimited)
