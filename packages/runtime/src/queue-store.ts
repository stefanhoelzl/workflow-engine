import type { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import { Kysely, sql } from "kysely";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// QueueStore — per-workflow durable FIFO queues backed by DuckDB.
//
// All access to the `queue_items` table goes through this module. Every
// public method requires a fully-qualified tenant tuple at the type level;
// there are no overloads accepting partial scope. Raw `db.selectFrom(
// "queue_items")` outside this module is forbidden by a lint check (see
// queue-store-isolation.test.ts).
// ---------------------------------------------------------------------------

const MAX_ITEM_BYTES = 1024;
// Depth cap is WORKFLOW-wide, not per-queue: it bounds the total item count
// across ALL of a workflow's queues (owner, repo, workflow). This is the
// availability backstop on the shared events.duckdb — because there is no
// runtime name gate (any name a tampered guest supplies is accepted), a
// per-queue cap would be defeated by inventing unlimited names. A
// workflow-wide cap bounds total storage regardless of how many names are
// used. (Tenant-wide — drop the `workflow` predicate from the count — would
// be a stronger bound at the cost of coupling unrelated workflows.)
const MAX_WORKFLOW_QUEUE_DEPTH = 1000;
// Microseconds-to-milliseconds divisor for DuckDB TIMESTAMPTZ values.
const MICROS_PER_MS = 1000n;

// Column names use camelCase to match the event-store table convention
// (events table: id, seq, kind, "at", workflowSha, …). The table name uses
// snake_case (queue_items) because there's no existing multi-word table to
// anchor against; "events" is single-word.
interface QueueItemsTable {
	owner: string;
	repo: string;
	workflow: string;
	queue: string;
	seq: number;
	enqueuedAt: Date;
	invocationId: string;
	triggerKind: string;
	triggerName: string;
	item: string;
}

interface Database {
	// biome-ignore lint/style/useNamingConvention: SQL table name; DuckDB convention for multi-word tables is snake_case
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
	put(scope: QueueScope, item: unknown, producer: ProducerMeta): Promise<void>;
	get(scope: QueueScope): Promise<PoppedRow | undefined>;
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
	readonly instance: DuckDBInstance;
	readonly logger: Logger;
	// Override the workflow-wide depth cap. Defaults to MAX_WORKFLOW_QUEUE_DEPTH.
	// Exists so tests can exercise the cap with a small N instead of inserting
	// the production magnitude (1000) durable rows one at a time.
	readonly maxWorkflowDepth?: number;
}

// DuckDB does not support GENERATED ALWAYS AS IDENTITY ("Constraint not
// implemented!"). We use a global sequence + DEFAULT nextval() instead,
// which yields the same observable property: monotonic seq assignment in
// commit order, dense across all queues, never exposed to guests.
const CREATE_SEQUENCE_DDL = `
CREATE SEQUENCE IF NOT EXISTS queue_items_seq
`;
const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS queue_items (
	owner          VARCHAR     NOT NULL,
	repo           VARCHAR     NOT NULL,
	workflow       VARCHAR     NOT NULL,
	queue          VARCHAR     NOT NULL,
	seq            BIGINT      NOT NULL DEFAULT nextval('queue_items_seq'),
	enqueuedAt     TIMESTAMPTZ NOT NULL,
	invocationId   VARCHAR     NOT NULL,
	triggerKind    VARCHAR     NOT NULL,
	triggerName    VARCHAR     NOT NULL,
	item           JSON        NOT NULL,
	PRIMARY KEY (owner, repo, workflow, queue, seq)
)`;

// Index supports both the tenant-tuple WHERE (used by every accessor method)
// and the MIN(seq)/MAX(seq) lookups behind FIFO get and depth checks.
const CREATE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS queue_items_tuple_seq_idx
	ON queue_items (owner, repo, workflow, queue, seq)
`;

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
	if (typeof value === "string" || typeof value === "number") {
		return new Date(value);
	}
	// DuckDB driver surfaces TIMESTAMPTZ as DuckDBTimestampTZValue carrying
	// a `micros` bigint (microseconds since epoch). Convert to ms for Date.
	if (
		value !== null &&
		typeof value === "object" &&
		"micros" in value &&
		typeof (value as { micros: unknown }).micros === "bigint"
	) {
		const micros = (value as { micros: bigint }).micros;
		return new Date(Number(micros / MICROS_PER_MS));
	}
	throw new Error(
		`queue-store: cannot coerce enqueuedAt value of type ${typeof value}`,
	);
}

function rowToMeta(row: {
	enqueuedAt: unknown;
	invocationId: unknown;
	triggerKind: unknown;
	triggerName: unknown;
	item: unknown;
}): PoppedRow {
	return {
		item: parseItem(row.item),
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
async function createQueueStore(
	options: QueueStoreOptions,
): Promise<QueueStore> {
	const { instance, logger } = options;
	const maxWorkflowDepth = options.maxWorkflowDepth ?? MAX_WORKFLOW_QUEUE_DEPTH;
	const conn = await instance.connect();
	await conn.run(CREATE_SEQUENCE_DDL);
	await conn.run(CREATE_TABLE_DDL);
	await conn.run(CREATE_INDEX_DDL);

	const db = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});

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
				enqueuedAt: producer.enqueuedAt,
				invocationId: producer.invocationId,
				triggerKind: producer.triggerKind,
				triggerName: producer.triggerName,
				item: json,
				// biome-ignore lint/suspicious/noExplicitAny: seq column has a DB-side DEFAULT (nextval); Kysely's generated type still requires it, so cast away the omission
			} as any)
			.execute();
	}

	async function get(scope: QueueScope): Promise<PoppedRow | undefined> {
		// DELETE … WHERE seq = (SELECT MIN(seq) WHERE tenant) RETURNING …
		// Single autocommit statement; DuckDB serializes writes. Validation
		// of the popped item is the bridge's responsibility, AFTER commit.
		const result = await sql<{
			item: unknown;
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
				AND seq = (
					SELECT MIN(seq) FROM queue_items
					WHERE owner = ${scope.owner}
						AND repo = ${scope.repo}
						AND workflow = ${scope.workflow}
						AND queue = ${scope.queue}
				)
			RETURNING item, enqueuedAt, invocationId, triggerKind, triggerName
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
		// Kysely's DuckDB dialect doesn't surface affected-row counts on
		// DELETE; use RETURNING so we can count rows ourselves.
		if (scope.queue !== undefined) {
			const result = await sql<{ seq: bigint }>`
				DELETE FROM queue_items
				WHERE owner = ${scope.owner}
					AND repo = ${scope.repo}
					AND workflow = ${scope.workflow}
					AND queue = ${scope.queue}
				RETURNING seq
			`.execute(db);
			return result.rows.length;
		}
		const result = await sql<{ seq: bigint }>`
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
		await conn.run("SELECT 1");
	}

	async function close(): Promise<void> {
		// Kysely connection close is best-effort; the underlying DuckDBInstance
		// is owned by the caller (main.ts) and closed there.
		await db.destroy();
		conn.disconnectSync();
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
	MAX_WORKFLOW_QUEUE_DEPTH,
	QueueError,
};
