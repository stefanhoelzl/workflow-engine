import { type Generated, type Kysely, sql } from "kysely";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// QueueStore — per-workflow durable FIFO queues backed by libSQL.
//
// All access to the `queue_items` table goes through this module. Every
// public method requires a fully-qualified tenant tuple at the type level;
// there are no overloads accepting partial scope. Raw `db.selectFrom(
// "queue_items")` outside this module is forbidden by a lint check (see
// queue-store-isolation.test.ts).
// ---------------------------------------------------------------------------

const MAX_ITEM_BYTES = 1024;
// Max UTF-8 byte length of a partition key. Independent of MAX_ITEM_BYTES so a
// long key cannot reduce the item budget. Enforced host-side (queue-host.ts)
// before any statement touches the store.
const MAX_KEY_BYTES = 128;
// Depth cap is WORKFLOW-wide, not per-queue: it bounds the total item count
// across ALL of a workflow's queues (owner, repo, workflow). This is the
// availability backstop on the shared events.db — because there is no
// runtime name gate (any name a tampered guest supplies is accepted), a
// per-queue cap would be defeated by inventing unlimited names. A
// workflow-wide cap bounds total storage regardless of how many names are
// used. (Tenant-wide — drop the `workflow` predicate from the count — would
// be a stronger bound at the cost of coupling unrelated workflows.)
const MAX_WORKFLOW_QUEUE_DEPTH = 1000;

// Column names use camelCase to match the event-store table convention
// (events table: id, seq, kind, "at", workflowSha, …). The table name uses
// snake_case (queue_items) because there's no existing multi-word table to
// anchor against; "events" is single-word. `enqueuedAt` is stored as TEXT
// (ISO-8601); `seq` is an AUTOINCREMENT rowid the DB assigns on insert.
interface QueueItemsTable {
	owner: string;
	repo: string;
	workflow: string;
	queue: string;
	// Partition selector within a queue; '' is the unkeyed partition. Added by
	// migration 0002-queue-key. `get(scope, key)` pops FIFO within one key only.
	key: string;
	seq: Generated<number>;
	enqueuedAt: string;
	invocationId: string;
	triggerKind: string;
	triggerName: string;
	item: string;
}

interface Database {
	// biome-ignore lint/style/useNamingConvention: SQL table name; snake_case is the SQL convention for multi-word tables
	queue_items: QueueItemsTable;
}

interface QueueScope {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue: string;
}

interface WorkflowQueueScope {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly queue?: string;
}

interface ProducerMeta {
	readonly enqueuedAt: Date;
	readonly invocationId: string;
	readonly triggerKind: string;
	readonly triggerName: string;
}

interface PoppedRow {
	readonly item: unknown;
	readonly key: string;
	readonly enqueuedAt: Date;
	readonly invocationId: string;
	readonly triggerKind: string;
	readonly triggerName: string;
}

interface RowWithMeta extends PoppedRow {
	readonly seq: number;
}

type QueueErrorCode =
	| "queue.itemTooLarge"
	| "queue.keyTooLarge"
	| "queue.full"
	| "queue.schemaMismatch"
	| "queue.gone"
	| "queue.notDeclared";

// Single QueueError class used by the store AND the host bridge handlers
// (queue-host.ts). Own enumerable properties (`code`, `item?`) are captured
// by sandbox.ts:serializeHostError into SerializedError.data and re-attached
// on the worker side; the worker matches on `name === "QueueError"` to
// re-wrap as the sandbox-side QueueError. Centralizing the class here keeps
// the throwable surface to one place.
class QueueError extends Error {
	readonly code: QueueErrorCode;
	readonly item?: unknown;
	constructor(code: QueueErrorCode, message: string, item?: unknown) {
		super(message);
		this.code = code;
		this.name = "QueueError";
		if (item !== undefined) {
			this.item = item;
		}
	}
}

interface QueueStore {
	put(
		scope: QueueScope,
		item: unknown,
		key: string,
		producer: ProducerMeta,
	): Promise<void>;
	get(scope: QueueScope, key: string): Promise<PoppedRow | undefined>;
	count(scope: QueueScope): Promise<number>;
	list(
		scope: QueueScope,
		offset: number,
		limit: number,
	): Promise<readonly RowWithMeta[]>;
	removeDeclaration(scope: WorkflowQueueScope): Promise<number>;
	reconcile(declaredTuples: readonly QueueScope[]): Promise<number>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

interface QueueStoreOptions {
	readonly db: Kysely<Database>;
	readonly logger: Logger;
	// Override the workflow-wide depth cap. Defaults to MAX_WORKFLOW_QUEUE_DEPTH.
	// Exists so tests can exercise the cap with a small N instead of inserting
	// the production magnitude (1000) durable rows one at a time.
	readonly maxWorkflowDepth?: number;
}

// libSQL has no sequence type; `seq` is an `INTEGER PRIMARY KEY AUTOINCREMENT`
// rowid. The AUTOINCREMENT keyword is REQUIRED — without it SQLite/libSQL may
// recycle a freed rowid after the DELETEs that popping causes, breaking the
// monotonic, never-reused FIFO ordering. This yields the same observable
// property as DuckDB's former `nextval()` sequence: dense, monotonic seq in
// commit order, never exposed to guests.
// The `queue_items` table + its tenant-tuple index are created by the migration
// runner (see migrations/0001-initial.ts), not this factory. The index over
// (owner, repo, workflow, queue, seq) supports the tenant-tuple WHERE used by
// every accessor method and the MIN(seq)/MAX(seq) lookups behind FIFO get and
// depth checks.

function tooLargeError(scope: QueueScope, bytes: number): QueueError {
	return new QueueError(
		"queue.itemTooLarge",
		`queue "${scope.queue}" item exceeds size cap: ${String(bytes)} > ${String(MAX_ITEM_BYTES)} bytes`,
	);
}

function fullError(scope: QueueScope, cap: number): QueueError {
	return new QueueError(
		"queue.full",
		`workflow "${scope.owner}/${scope.repo}/${scope.workflow}" queues are at capacity (${String(cap)} items total across all queues)`,
	);
}

function parseItem(raw: unknown): unknown {
	if (typeof raw === "string") {
		return JSON.parse(raw);
	}
	return raw;
}

function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	// `enqueuedAt` is stored as TEXT (ISO-8601); libSQL returns it as a string.
	// Accept number too (epoch ms) for robustness.
	if (typeof value === "string" || typeof value === "number") {
		return new Date(value);
	}
	throw new Error(
		`queue-store: cannot coerce enqueuedAt value of type ${typeof value}`,
	);
}

function rowToMeta(row: {
	key: unknown;
	enqueuedAt: unknown;
	invocationId: unknown;
	triggerKind: unknown;
	triggerName: unknown;
	item: unknown;
}): PoppedRow {
	return {
		item: parseItem(row.item),
		key: String(row.key),
		enqueuedAt: toDate(row.enqueuedAt),
		invocationId: String(row.invocationId),
		triggerKind: String(row.triggerKind),
		triggerName: String(row.triggerName),
	};
}

function tupleKey(t: {
	owner: string;
	repo: string;
	workflow: string;
	queue: string;
}): string {
	return `${t.owner} ${t.repo} ${t.workflow} ${t.queue}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups DB setup, helper queries, and the public accessor surface that all share the connection — splitting them would leak the connection as module state (mirrors event-store.ts's createEventStore)
// biome-ignore lint/suspicious/useAwait: async is this factory's contract (returns Promise<QueueStore>, awaited at every call site); schema DDL moved to the migration runner so no await remains in the body
async function createQueueStore(
	options: QueueStoreOptions,
): Promise<QueueStore> {
	const { db, logger } = options;
	const maxWorkflowDepth = options.maxWorkflowDepth ?? MAX_WORKFLOW_QUEUE_DEPTH;
	// Schema is ensured by the migration runner before this factory is called;
	// the factory issues no DDL.

	// Per-queue count — used by the /queue UI for card stats.
	async function count(scope: QueueScope): Promise<number> {
		const result = await db
			.selectFrom("queue_items")
			.where("owner", "=", scope.owner)
			.where("repo", "=", scope.repo)
			.where("workflow", "=", scope.workflow)
			.where("queue", "=", scope.queue)
			.select((eb) => eb.fn.countAll<bigint>().as("c"))
			.executeTakeFirst();
		return Number(result?.c ?? 0n);
	}

	// Workflow-wide count — the depth-cap denominator. Counts every row for
	// (owner, repo, workflow) across ALL queue names so the cap can't be
	// amplified by inventing names.
	async function workflowDepth(scope: QueueScope): Promise<number> {
		const result = await db
			.selectFrom("queue_items")
			.where("owner", "=", scope.owner)
			.where("repo", "=", scope.repo)
			.where("workflow", "=", scope.workflow)
			.select((eb) => eb.fn.countAll<bigint>().as("c"))
			.executeTakeFirst();
		return Number(result?.c ?? 0n);
	}

	async function put(
		scope: QueueScope,
		item: unknown,
		key: string,
		producer: ProducerMeta,
	): Promise<void> {
		const json = JSON.stringify(item);
		if (typeof json !== "string") {
			throw tooLargeError(scope, 0);
		}
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes > MAX_ITEM_BYTES) {
			throw tooLargeError(scope, bytes);
		}
		const depth = await workflowDepth(scope);
		if (depth >= maxWorkflowDepth) {
			throw fullError(scope, maxWorkflowDepth);
		}
		await db
			.insertInto("queue_items")
			.values({
				owner: scope.owner,
				repo: scope.repo,
				workflow: scope.workflow,
				queue: scope.queue,
				key,
				enqueuedAt: producer.enqueuedAt.toISOString(),
				invocationId: producer.invocationId,
				triggerKind: producer.triggerKind,
				triggerName: producer.triggerName,
				item: json,
			})
			.execute();
	}

	async function get(
		scope: QueueScope,
		key: string,
	): Promise<PoppedRow | undefined> {
		// DELETE … WHERE seq = (SELECT MIN(seq) WHERE tenant AND key) RETURNING …
		// The key partitions the FIFO: both the outer predicate and the MIN(seq)
		// subselect are scoped to (tenant tuple, key), so a get on one key never
		// pops another key's items. Single autocommit statement; libSQL
		// serializes writes. Validation of the popped item is the bridge's
		// responsibility, AFTER commit.
		const result = await sql<{
			item: unknown;
			key: unknown;
			enqueuedAt: unknown;
			invocationId: unknown;
			triggerKind: unknown;
			triggerName: unknown;
		}>`
			DELETE FROM queue_items
			WHERE owner = ${scope.owner}
				AND repo = ${scope.repo}
				AND workflow = ${scope.workflow}
				AND queue = ${scope.queue}
				AND key = ${key}
				AND seq = (
					SELECT MIN(seq) FROM queue_items
					WHERE owner = ${scope.owner}
						AND repo = ${scope.repo}
						AND workflow = ${scope.workflow}
						AND queue = ${scope.queue}
						AND key = ${key}
				)
			RETURNING item, key, enqueuedAt, invocationId, triggerKind, triggerName
		`.execute(db);
		const row = result.rows[0];
		if (!row) {
			return;
		}
		return rowToMeta(row);
	}

	async function list(
		scope: QueueScope,
		offset: number,
		limit: number,
	): Promise<readonly RowWithMeta[]> {
		const rows = await db
			.selectFrom("queue_items")
			.where("owner", "=", scope.owner)
			.where("repo", "=", scope.repo)
			.where("workflow", "=", scope.workflow)
			.where("queue", "=", scope.queue)
			.select([
				"seq",
				"key",
				"enqueuedAt",
				"invocationId",
				"triggerKind",
				"triggerName",
				"item",
			])
			.orderBy("seq", "asc")
			.offset(offset)
			.limit(limit)
			.execute();
		return rows.map((row) => ({
			...rowToMeta(row),
			seq: Number(row.seq),
		}));
	}

	async function removeDeclaration(scope: WorkflowQueueScope): Promise<number> {
		// Count deleted rows via RETURNING (uniform across drivers) rather than
		// relying on an affected-row count.
		if (scope.queue !== undefined) {
			const result = await sql<{ seq: number }>`
				DELETE FROM queue_items
				WHERE owner = ${scope.owner}
					AND repo = ${scope.repo}
					AND workflow = ${scope.workflow}
					AND queue = ${scope.queue}
				RETURNING seq
			`.execute(db);
			return result.rows.length;
		}
		const result = await sql<{ seq: number }>`
			DELETE FROM queue_items
			WHERE owner = ${scope.owner}
				AND repo = ${scope.repo}
				AND workflow = ${scope.workflow}
			RETURNING seq
		`.execute(db);
		return result.rows.length;
	}

	async function reconcile(
		declaredTuples: readonly QueueScope[],
	): Promise<number> {
		// Collect distinct (o,r,w,q) tuples present in the table, set-diff
		// against the manifest's declared tuples, DELETE the difference.
		// Doing this in app code avoids constructing a giant NOT-IN SQL
		// clause and keeps the reconcile cost proportional to orphan tuples.
		const present = await db
			.selectFrom("queue_items")
			.select(["owner", "repo", "workflow", "queue"])
			.distinct()
			.execute();
		const declaredKey = new Set(declaredTuples.map(tupleKey));
		const orphans = present.filter((p) => !declaredKey.has(tupleKey(p)));
		if (orphans.length === 0) {
			return 0;
		}
		// Each orphan tuple is independent — fire DELETEs concurrently.
		const counts = await Promise.all(
			orphans.map(async (o) => {
				const removed = await removeDeclaration(o);
				logger.info("queue-store.reconcile-removed", {
					owner: o.owner,
					repo: o.repo,
					workflow: o.workflow,
					queue: o.queue,
					rows: removed,
				});
				return removed;
			}),
		);
		return counts.reduce((a, b) => a + b, 0);
	}

	async function ping(): Promise<void> {
		await sql`SELECT 1`.execute(db);
	}

	async function close(): Promise<void> {
		// Destroys this Kysely handle only; the underlying libSQL client is owned
		// by the caller (main.ts) and closed there (db.destroy() is a no-op on an
		// injected client).
		await db.destroy();
	}

	return {
		put,
		get,
		count,
		list,
		removeDeclaration,
		reconcile,
		ping,
		close,
	};
}

export type {
	Database,
	PoppedRow,
	ProducerMeta,
	QueueErrorCode,
	QueueScope,
	QueueStore,
	QueueStoreOptions,
	RowWithMeta,
	WorkflowQueueScope,
};
export {
	createQueueStore,
	MAX_ITEM_BYTES,
	MAX_KEY_BYTES,
	MAX_WORKFLOW_QUEUE_DEPTH,
	QueueError,
};
