## ADDED Requirements

### Requirement: Tenant-scoped accessor

Every host-side read or write of `queue_items` SHALL go through a typed accessor that requires `(owner, repo, workflow, queue)` as a compile-time argument tuple and injects those values as `WHERE` clauses on every statement. The accessor SHALL be the only module that constructs SQL against `queue_items`; raw `db.selectFrom("queue_items")`, `db.insertInto("queue_items")`, `db.deleteFrom("queue_items")`, and `db.updateTable("queue_items")` (or equivalent driver-level access) SHALL be forbidden outside the accessor module and SHALL be enforced by a Biome lint rule. The accessor SHALL NOT expose overloads accepting partial tuples.

#### Scenario: Accessor signature refuses partial scope at compile time

- **WHEN** code attempts to call `queueStore.put({owner: "acme", repo: "foo"}, item)` without `workflow` and `queue` fields
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

### Requirement: Item provenance metadata

Every `queue_items` row SHALL carry metadata fields stamped by the host bridge at the moment of `put`: `enqueuedAt` (TIMESTAMPTZ), `invocationId` (the producing invocation's id from the dispatch context), `triggerKind` (the producing trigger's kind, as a free-form string), and `triggerName` (the producing trigger's declared export name). The metadata SHALL be visible to operators via the `/queue` UI (see `queues-ui`) and SHALL be queryable via the tenant-scoped accessor.

The metadata SHALL NOT be exposed to guest code via the `get()` return value. The guest-facing `Queue<T>` contract SHALL remain `put(item: T) → void` and `get() → T | undefined`; the metadata SHALL be host-only / UI-only.

`triggerKind` SHALL be stored as an open string with no database-level enum constraint. Unknown or future trigger kinds (e.g. a future "queue" trigger kind for queue-consumer triggers) SHALL be accepted and rendered with the default-glyph fallback in the UI per `ui-foundation` §"Distinct visual indicator per trigger kind".

#### Scenario: Bridge stamps metadata at put

- **GIVEN** a guest invocation `inv-a3f2` triggered by cron trigger `everyFiveMinutes`
- **WHEN** the guest calls `await q.put({url: "https://example.com"})`
- **THEN** the inserted `queue_items` row SHALL have `invocation_id = "inv-a3f2"`, `trigger_kind = "cron"`, `trigger_name = "everyFiveMinutes"`, and `enqueuedAt` within 100 ms of the bridge entry time

#### Scenario: Guest get() returns only the item value

- **GIVEN** a queue containing one item with full producer metadata
- **WHEN** the guest calls `await q.get()`
- **THEN** the return value SHALL equal the original item value passed to `put`
- **AND** the return value SHALL NOT be wrapped in an object containing metadata fields
- **AND** the metadata fields SHALL NOT be visible to the guest under any property name

#### Scenario: Unknown future trigger kind is accepted

- **GIVEN** a hypothetical future dispatch context with `trigger_kind = "queue"` (a kind the existing `TriggerKindIcon` registry does not yet know)
- **WHEN** the bridge stamps the row
- **THEN** the INSERT SHALL succeed (no DB-level enum rejection)
- **AND** the `/queue` UI SHALL render the row with `TriggerKindIcon`'s default-glyph fallback

## MODIFIED Requirements

### Requirement: Storage layout

The runtime SHALL persist queue contents as rows in a single `queue_items` table inside the runtime's existing DuckDB instance at `<PERSISTENCE_PATH>/events.duckdb`. The table SHALL have the following schema:

- `owner VARCHAR NOT NULL`
- `repo VARCHAR NOT NULL`
- `workflow VARCHAR NOT NULL`
- `queue VARCHAR NOT NULL`
- `seq BIGINT NOT NULL DEFAULT nextval('queue_items_seq')`
- `enqueuedAt TIMESTAMPTZ NOT NULL`
- `invocationId VARCHAR NOT NULL`
- `triggerKind VARCHAR NOT NULL`
- `triggerName VARCHAR NOT NULL`
- `item JSON NOT NULL`
- `PRIMARY KEY (owner, repo, workflow, queue, seq)`

Column names use camelCase to match the existing event-store table convention (events table: `workflowSha`, etc.). The table name uses snake_case (`queue_items`) following standard SQL convention for multi-word identifiers.

The `seq` column SHALL draw its value from a global DuckDB sequence (`queue_items_seq`), one counter across all queues, used solely for FIFO ordering. Implementation note: DuckDB does not support `GENERATED ALWAYS AS IDENTITY` ("Constraint not implemented!"); the equivalent global sequence pattern provides identical observable behavior — monotonic seq assignment in commit order, dense across all queues, never exposed to guests, never displayed to operators.

A queue's *existence* SHALL be determined by its presence in the workflow's manifest (`declaredQueues`); the queue's row count in `queue_items` MAY be zero for a declared queue with no items. No "empty file" or "queue row marker" SHALL be required.

The runtime SHALL own the `queue_items` table exclusively; no other capability SHALL write to it.

#### Scenario: Declared empty queue has zero rows

- **GIVEN** a workflow `acme/widgets/orders.ts` declaring `defineQueue({name: "jobs", schema})` with no items enqueued
- **WHEN** the runtime queries `SELECT COUNT(*) FROM queue_items WHERE (owner, repo, workflow, queue) = ('acme', 'widgets', 'orders', 'jobs')`
- **THEN** the result SHALL be 0
- **AND** the queue SHALL still be considered "declared and present" because the manifest declares it
- **AND** a subsequent `get()` SHALL return `undefined` without error

#### Scenario: Newlines inside items do not break framing

- **GIVEN** an item whose `JSON.stringify` form contains the substring `\n` inside a string field
- **WHEN** the runtime inserts the item
- **THEN** the `item JSON` column SHALL store the JSON value as DuckDB's JSON type
- **AND** subsequent retrieval via `SELECT item FROM queue_items WHERE seq = ?` SHALL yield the original string value verbatim (no FIFO framing concerns apply — rows are not line-delimited)

### Requirement: Durability contract

A successful return from `put` SHALL guarantee that the inserted row survives `SIGKILL`, host crash, or power loss. A successful return from `get` SHALL guarantee that the deleted row remains deleted across the same failure modes. The runtime SHALL achieve this by issuing each `put` as a single autocommit `INSERT` statement and each `get` as a single autocommit `DELETE … RETURNING` statement against DuckDB; DuckDB's WAL `fsync` on autocommit SHALL provide the durability semantics.

The bridge SHALL NOT batch queue operations or hold open transactions across the host-call boundary. Queue ops SHALL NOT be enrolled in the event-store's batched-commit transaction.

#### Scenario: Put commits before bridge reply

- **WHEN** the host bridge handles a `put` request
- **THEN** the bridge SHALL execute `INSERT INTO queue_items (...) VALUES (...)` as a single autocommit statement
- **AND** the bridge SHALL NOT send the reply to the sandbox proxy before the INSERT returns successfully
- **AND** the bridge SHALL NOT wrap the INSERT in a multi-statement transaction

#### Scenario: Get is crash-atomic via autocommit DELETE…RETURNING

- **GIVEN** a queue with three rows
- **WHEN** the host bridge handles a `get` request as `DELETE FROM queue_items WHERE … RETURNING item`
- **AND** the runtime is `SIGKILL`'d at any point during the statement
- **THEN** on subsequent boot, the table SHALL contain either all three rows (DELETE never committed) or exactly the two-row remainder (DELETE committed; popped row gone)
- **AND** the table SHALL NEVER contain a torn state

### Requirement: Per-item size cap

The runtime SHALL reject `put` requests whose item, after `JSON.stringify`, exceeds 1024 UTF-8 bytes. The cap SHALL apply to the item payload alone; the producer metadata columns (`enqueuedAt`, `invocationId`, `triggerKind`, `triggerName`) SHALL NOT count toward the cap. Rejection SHALL surface as a typed `QueueItemTooLarge` error to the guest with `code = "queue.itemTooLarge"`, and no row SHALL be inserted.

#### Scenario: Item exactly at the cap is accepted

- **WHEN** an item whose `JSON.stringify` length is exactly 1024 bytes is `put`
- **THEN** the call SHALL succeed
- **AND** the `queue_items` table SHALL contain the new row

#### Scenario: Item over the cap is rejected

- **WHEN** an item whose `JSON.stringify` length is 1025 bytes is `put`
- **THEN** the host bridge SHALL throw `QueueItemTooLarge` with `code = "queue.itemTooLarge"`
- **AND** no row SHALL be inserted into `queue_items`
- **AND** a `system.error` event with `name = "queue.put"` SHALL be emitted

### Requirement: Workflow-wide depth cap

The runtime SHALL bound the total number of queue items per workflow, not per queue. A `put` SHALL be rejected when the count of `queue_items` rows for `(owner, repo, workflow)` — summed across ALL of that workflow's queue names — already reaches the cap at the moment of the check. Rejection SHALL surface as a typed `QueueFull` error with `code = "queue.full"`, and no row SHALL be inserted.

The cap is workflow-wide (rather than per-queue) because there is no runtime queue-name gate (see "No queue-name gate; host validates declared queues only"): a per-queue cap would be trivially defeated by a tampered guest inventing unlimited names, each starting at zero depth. A workflow-wide cap bounds total storage on the shared `events.duckdb` regardless of how many names are used. The cap MAY alternatively be keyed at the tenant level (drop the `workflow` predicate) for a stronger bound at the cost of coupling unrelated workflows; the workflow-wide keying is the default because it couples only one author's own queues.

The cap check SHALL be performed via `SELECT COUNT(*)` followed by `INSERT` in the same autocommit context. Under concurrent `put` calls within one workflow, snapshot isolation MAY allow the depth to transiently overflow the cap by the number of in-flight puts; items inserted during such an overrun SHALL remain valid and SHALL be consumed in FIFO order. Boot reconciliation SHALL NOT attempt to truncate overruns.

#### Scenario: Cap reached under single-writer access

- **GIVEN** a workflow whose queues collectively contain exactly the cap's worth of rows
- **WHEN** another `put` to any of that workflow's queues is attempted with no other concurrent puts in flight
- **THEN** the host bridge SHALL throw `QueueFull` with `code = "queue.full"`
- **AND** no row SHALL be inserted

#### Scenario: Cap is shared across a workflow's queues

- **GIVEN** a workflow with two queues `a` and `b`, and queue `a` filled to the workflow-wide cap
- **WHEN** a `put` to queue `b` is attempted
- **THEN** the host bridge SHALL throw `QueueFull` (queue `b` has no remaining budget — the cap is workflow-wide)
- **AND** a `put` to a queue belonging to a DIFFERENT workflow SHALL succeed (each workflow has an independent budget)

### Requirement: Schema validation on put for declared queues

The runtime SHALL validate every item against the queue's Zod validator (rehydrated host-side from the workflow's manifest JSON Schema at sandbox construction time) before INSERT, for queues that are DECLARED (i.e. have a validator in the per-sandbox map). Validation failure SHALL throw `QueueSchemaMismatch` with `code = "queue.schemaMismatch"` to the guest, and no row SHALL be inserted.

A name with no validator is undeclared. Because the SDK statically binds authors to declared queue handles, an undeclared name is reachable only by a tampered guest; such a `put` SHALL be stored without schema validation (it pollutes only the guest's own tenant partition, is bounded by the workflow-wide cap, and is removed by boot reconciliation as a non-manifest tuple). This is acceptable because schema validation is an author-correctness contract, not a security boundary.

#### Scenario: Invalid put to a declared queue rejected

- **GIVEN** a declared queue with schema `z.object({url: z.string().url()})`
- **WHEN** `put({url: "not-a-url"})` is called
- **THEN** the host bridge SHALL throw `QueueSchemaMismatch`
- **AND** no row SHALL be inserted into `queue_items`

### Requirement: Schema validation on get for declared queues; bad item dropped

For DECLARED queues, the runtime SHALL validate every popped item against the queue's CURRENT Zod validator (which MAY differ from the validator in force at `put` time after a re-upload). The bridge SHALL issue the `DELETE … RETURNING` statement in autocommit and SHALL perform validation **after** the DELETE has committed; the DELETE SHALL NOT be conditional on validation success and SHALL NOT be rolled back on validation failure. If validation fails, the bridge SHALL throw `QueueSchemaMismatch` to the guest with the dropped item AND the producer metadata fields (`invocationId`, `triggerKind`, `triggerName`, `enqueuedAt`) embedded in the error payload. The corresponding `system.error` event with `name = "queue.get"` SHALL carry the same fields for operator root-cause attribution. A popped item from an undeclared name (no validator) SHALL be returned as-is.

#### Scenario: Schema regression drops the head item with producer metadata

- **GIVEN** a declared queue containing one item enqueued under schema `S1` by invocation `inv-p1` via cron trigger `produceJobs` at time `T0`
- **AND** the workflow has been re-uploaded with an incompatible schema `S2`
- **WHEN** `await q.get()` is called
- **THEN** the `queue_items` row SHALL no longer exist for this queue (the DELETE committed before validation ran)
- **AND** the bridge SHALL throw `QueueSchemaMismatch` whose payload includes the dropped item AND `{invocationId: "inv-p1", triggerKind: "cron", triggerName: "produceJobs", enqueuedAt: T0}`
- **AND** a `system.error` event with `name = "queue.get"` SHALL be emitted carrying the same payload

#### Scenario: Validation occurs after the DELETE commits

- **GIVEN** a declared queue with one item whose stored value will fail current-schema validation
- **WHEN** `await q.get()` is called
- **THEN** the bridge SHALL execute exactly one `DELETE … RETURNING` statement
- **AND** the bridge SHALL NOT issue a `SELECT` to pre-validate the row
- **AND** the bridge SHALL NOT issue a second pop attempt after validation throws
- **AND** the row SHALL be gone from the table regardless of validation outcome

### Requirement: Orphaned in-flight invocations operate against their dispatch-time manifest

An invocation runs against the manifest it was dispatched under for its entire lifetime — consistent with every other manifest-derived resource (env, secrets, action validators), which are all snapshotted into the sandbox at construction. A re-upload's metadata swap does NOT drain in-flight invocations: an old-`sha` invocation keeps running on its (not-yet-disposed) sandbox. The host bridge SHALL NOT consult the live registry on `put`/`get`, and SHALL NOT fail an orphan invocation's queue op merely because a concurrent re-upload removed the queue declaration. The op SHALL succeed against the invocation's own tenant partition; any rows it writes for a now-undeclared name are bounded by the workflow-wide depth cap, invisible to the `/queue` UI (which lists current-manifest queues), and removed by boot reconciliation as non-manifest tuples.

`QueueGone` (`code = "queue.gone"`) SHALL be reserved for the host-call channel failing — e.g. the channel is torn down at run-end while a call is in flight. The worker SHALL surface such a transport failure as `QueueGone` so the guest sees a typed error rather than a raw channel error.

#### Scenario: Queue dropped during in-flight invocation — op succeeds against the frozen partition

- **GIVEN** invocation 1 is in flight on `sha = A` and has not yet returned
- **WHEN** an upload bumps the workflow to `sha = B` and removes the `defineQueue({name: "jobs"})` declaration (DELETEing the existing `jobs` rows)
- **AND** invocation 1 then calls `await jobs.put(item)`
- **THEN** the put SHALL succeed (the invocation operates against its dispatch-time manifest; no live-registry check fails it)
- **AND** the inserted row SHALL be invisible to the `/queue` UI and to new sandboxes built from `sha = B`
- **AND** the row SHALL be removed by boot reconciliation as a non-manifest tuple

#### Scenario: Host-call channel drop surfaces as QueueGone

- **GIVEN** an in-flight `put`/`get` whose host call has been dispatched
- **WHEN** the run ends and the host-call channel rejects the pending call
- **THEN** the worker SHALL surface the rejection to the guest as `QueueGone` with `code = "queue.gone"`

### Requirement: Config-less worker; host is the sole policy authority

The queue plugin's sandbox-side worker SHALL be config-less: the runtime composer SHALL NOT inject any per-workflow config into the queue plugin descriptor. The worker SHALL carry no `owner`, `workflow`, `declaredQueues`, `validators`, `queuesRoot`, or schema field. All per-workflow knowledge (the declared-queue set and the per-queue validators) SHALL live MAIN-side in the queue host handlers, derived from the workflow manifest at sandbox construction.

The worker SHALL be pure transport: it captures the per-invocation context (`repo`, `invocationId`, `triggerKind`, `triggerName`) from `RunInput.extras.queue`, routes by `op` to the matching host method (`queue.put` / `queue.get`), forwards the call, and maps host-side `QueueError`s back to the guest surface. The worker SHALL NOT validate the queue name, the op, or the item beyond the `op` discriminator required to pick a host method.

Host-side validators SHALL be Zod validators rehydrated from JSON Schemas at sandbox construction and held in the per-sandbox handler closure, keyed by queue name. The validator map's key set is the declared-queue set — there is NO separate name gate. The host applies schema validation (declared queues only), the workflow-wide depth cap, the per-item size cap, and the `enqueuedAt` stamp.

#### Scenario: Queue plugin descriptor carries no config

- **GIVEN** a workflow with two declared queues `jobs` and `emails`
- **WHEN** the sandbox is constructed
- **THEN** the queue plugin descriptor SHALL be spread with no `config` field
- **AND** the worker SHALL have no knowledge of `owner`, `workflow`, the declared-queue set, validators, or schemas

#### Scenario: Host handler holds the validators

- **GIVEN** a workflow with declared queue `jobs` whose schema is `z.object({url: z.string()})`
- **WHEN** the sandbox is constructed
- **THEN** the per-sandbox queue host handler closure SHALL contain a Zod validator keyed by `"jobs"`
- **AND** the validator SHALL be invoked on every `put` to `jobs` before INSERT and on every `get` from `jobs` after the DELETE commits

#### Scenario: enqueuedAt is stamped host-side

- **WHEN** a guest `put` is forwarded to the host
- **THEN** the worker SHALL NOT include an `enqueuedAt` field in the host-call args
- **AND** the host handler SHALL stamp `enqueuedAt` at INSERT time so it is monotonic with the row's `seq`

### Requirement: Upload-time row lifecycle

When the workflow registry processes an upload that adds a queue declaration, the registry SHALL NOT insert any marker row; the queue's existence is determined solely by the manifest entry. When an upload removes a queue declaration, the registry SHALL invoke the tenant-scoped accessor to `DELETE` all rows for the `(owner, repo, workflow, queue)` tuple. When a workflow is removed entirely, the registry SHALL `DELETE` all rows for the `(owner, repo, workflow)` tuple. These DELETEs SHALL run after the manifest persist completes; their failure SHALL be logged but SHALL NOT roll back the manifest persist (orphan rows are corrected by boot reconciliation on the next restart).

#### Scenario: New queue declared

- **GIVEN** a workflow has no queues
- **WHEN** an upload introduces `defineQueue({name: "jobs", schema})`
- **THEN** after the upload returns 200, no row SHALL be inserted into `queue_items` for the new queue
- **AND** a subsequent `put` SHALL succeed and insert the queue's first row
- **AND** a subsequent `get` on the empty queue SHALL return `undefined`

#### Scenario: Queue declaration removed

- **GIVEN** a workflow currently declares `defineQueue({name: "jobs"})` and `queue_items` contains 5 rows for that tuple
- **WHEN** an upload removes the declaration
- **THEN** after the upload returns 200, the manifest SHALL no longer declare `"jobs"`
- **AND** the registry SHALL issue `DELETE FROM queue_items WHERE (owner, repo, workflow, queue) = T`
- **AND** the 5 rows SHALL be unrecoverable from the runtime

#### Scenario: Workflow removed entirely

- **GIVEN** a workflow with 3 declared queues, totaling 17 rows across them
- **WHEN** the workflow is removed via upload
- **THEN** the registry SHALL issue `DELETE FROM queue_items WHERE (owner, repo, workflow) = (o, r, w)`
- **AND** all 17 rows SHALL be removed

### Requirement: Boot reconciliation sweep

After `registry.recover()` runs at startup, the runtime SHALL execute a single SQL statement that DELETEs every row whose `(owner, repo, workflow, queue)` tuple is not present in the current manifests' declared queue set. The sweep SHALL tolerate an empty or absent `queue_items` table (treat as "no rows to reconcile"). The sweep SHALL log an info entry naming each removed tuple and its row count.

The previous file-system "missing file" reconciliation case SHALL NOT have an analog: a declared queue with zero rows is a normal state requiring no recovery.

#### Scenario: Orphan rows from SIGKILL between manifest persist and DELETE

- **GIVEN** an upload removed `defineQueue({name: "old"})` but `SIGKILL` hit between manifest persist and the registry's DELETE
- **WHEN** the runtime restarts and the boot sweep runs
- **THEN** the sweep SHALL DELETE all rows for `(owner, repo, workflow, "old")` because `"old"` is not in the current manifest's declared queue set
- **AND** the sweep SHALL log an info entry naming the removed tuple and its row count

#### Scenario: Declared empty queue requires no action

- **GIVEN** an upload introduced `defineQueue({name: "new"})` but no items have ever been enqueued
- **WHEN** the runtime restarts and the boot sweep runs
- **THEN** no rows for `("owner", "repo", "workflow", "new")` SHALL be inserted by the sweep
- **AND** a subsequent `put` SHALL succeed on the empty declared queue

### Requirement: QueueNotDeclared for unknown names

The host handler SHALL reject `put` and `get` requests whose `name` is not a member of the declared-queue set for the sandbox (and not present in the current workflow's manifest). Rejection SHALL throw `QueueNotDeclared` with `code = "queue.notDeclared"` before any SQL is constructed. Declared-set membership is the sole name gate: because the build pipeline regex-validates every declared queue name at upload time (`QUEUE_NAME_RE`), the declared set only ever contains valid names, so any name not in the set — including path-traversal-shaped strings — is uniformly rejected as `queue.notDeclared`. The host SHALL NOT re-validate `name` against a regex on the wire (the name is a column value, never a path; there is nothing to guard against).

#### Scenario: Bridge call with unknown queue name

- **GIVEN** the workflow declares `defineQueue({name: "jobs"})` but no `defineQueue({name: "ghost"})`
- **WHEN** the host handler receives a request `{queue: "ghost", …}`
- **THEN** the handler SHALL throw `QueueNotDeclared` with `code = "queue.notDeclared"`
- **AND** no SQL SHALL be issued against `queue_items`

#### Scenario: Path-traversal-shaped name is rejected as undeclared

- **WHEN** the host handler receives a request `{queue: "../../other-tenant/workflow/q", …}` (e.g. via a tampered guest)
- **THEN** the handler SHALL throw `QueueNotDeclared` because the name is not a member of the declared set
- **AND** no SQL SHALL be issued against `queue_items`
- **AND** no path-construction or filesystem operation SHALL be attempted (there are none — the name is a column value)

## REMOVED Requirements

### Requirement: On-disk layout

**Reason**: Replaced by the `Storage layout` requirement, which stores queue contents in a DuckDB table rather than NDJSON files under `<PERSISTENCE_PATH>/queues/`.

**Migration**: Existing NDJSON queue files are abandoned on upgrade; queues start empty on first boot after the upgrade. Documented in `docs/upgrades.md`.

### Requirement: Atomic upload-time file lifecycle

**Reason**: Replaced by the `Upload-time row lifecycle` requirement. Filesystem effects (file create on declare, unlink on remove, parent-dir fsync) no longer apply; the manifest alone declares a queue's existence, and removal becomes a SQL DELETE.

**Migration**: No data migration. Upgrade documentation in `docs/upgrades.md`.

### Requirement: Path-traversal defense in depth

**Reason**: The queue name is no longer used as a filesystem path segment; it is a column value in a parameterized SQL statement. The path-traversal class no longer exists. Queue-name regex validation is preserved (folded into `QueueNotDeclared for unknown names`) as defense in depth against tampered guest input, but `O_NOFOLLOW` and symlink scenarios have no analog.

**Migration**: None. The regex check survives; only the FS-specific scenarios go away.

### Requirement: Host-side read-only inspection

**Reason**: The `/queue` UI now reads queue contents via the tenant-scoped SQL accessor, which inherits DuckDB's MVCC isolation. The previous invariants — partial-line tolerance, rename-safety, non-blocking file reads, mutating-syscall avoidance — are filesystem-specific and have no analog when reads are SQL SELECTs. The guest-facing prohibition on `peek`/`list`/`count`/`inspect` operations is preserved as part of the `Storage layout` requirement (the guest contract remains `put`/`get` only).

**Migration**: None. The UI behavior is preserved; only the mechanism changes.
