import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import { CompiledQuery, Kysely, type SelectQueryBuilder } from "kysely";
import type { StorageBackend } from "../storage/index.js";
import type {
	BusConsumer,
	InvocationLifecycleEvent,
	SerializedErrorPayload,
} from "./index.js";
import { scanArchive } from "./persistence.js";

// ---------------------------------------------------------------------------
// Invocation index — one row per invocation, updated in place.
// ---------------------------------------------------------------------------
//
// `status` is "pending" while the invocation is in flight, flipping to
// "succeeded" or "failed" on terminal events. `completedAt` and `error`
// are null while pending.

interface InvocationsTable {
	id: string;
	workflow: string;
	trigger: string;
	status: string;
	startedAt: string;
	completedAt: string | null;
	error: unknown;
}

interface Database {
	invocations: InvocationsTable;
}

interface EventStoreOptions {
	logger?: { error(msg: string, data: Record<string, unknown>): void };
	persistence?: { backend: StorageBackend };
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE builder types are deeply generic — constraining them further adds complexity without safety
type QueryBuilder = SelectQueryBuilder<any, any, any>;
type CteCallback = (prev: QueryBuilder) => QueryBuilder;

interface CteChain {
	with(name: string, fn: CteCallback): CteChain;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely where() has complex overloads — accepting any mirrors the underlying API
	where(...args: any[]): QueryBuilder;
}

interface EventStore extends BusConsumer {
	readonly query: SelectQueryBuilder<Database, "invocations", object>;
	with(name: string, fn: CteCallback): CteChain;
	readonly initialized: Promise<void>;
}

const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS invocations (
	id TEXT PRIMARY KEY,
	workflow TEXT NOT NULL,
	trigger TEXT NOT NULL,
	status TEXT NOT NULL,
	startedAt TIMESTAMPTZ NOT NULL,
	completedAt TIMESTAMPTZ,
	error JSON
)`;

function createCteChain(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely's with() return type is deeply generic
	builder: any,
	lastCte: string,
): CteChain {
	return {
		with(name: string, fn: CteCallback): CteChain {
			const prev = lastCte;
			// biome-ignore lint/suspicious/noExplicitAny: Kysely QueryCreator type in CTE callback
			const next = builder.with(name, (qb: any) => fn(qb.selectFrom(prev)));
			return createCteChain(next, name);
		},
		// biome-ignore lint/suspicious/noExplicitAny: Kysely where() has complex overloads
		where(...args: any[]) {
			return builder.selectFrom(lastCte).where(...args);
		},
	};
}

function serializeError(
	error: SerializedErrorPayload | undefined,
): string | null {
	if (error === undefined) {
		return null;
	}
	return JSON.stringify(error);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups DDL, insert/update helpers, and bootstrap
async function createEventStore(
	options?: EventStoreOptions,
): Promise<EventStore> {
	const instance = await DuckDBInstance.create();
	const db = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});
	await db.executeQuery(CompiledQuery.raw(CREATE_TABLE_DDL));

	const logger = options?.logger;

	async function bootstrapFromArchive(backend: StorageBackend): Promise<void> {
		const rows: InvocationsTable[] = [];
		for await (const record of scanArchive(backend)) {
			if (record.status === "pending") {
				// Shouldn't happen (pending lives elsewhere) but skip defensively
				// rather than crashing the whole bootstrap.
				continue;
			}
			rows.push({
				id: record.id,
				workflow: record.workflow,
				trigger: record.trigger,
				status: record.status,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
				error: record.status === "failed" ? serializeError(record.error) : null,
			});
		}
		if (rows.length === 0) {
			return;
		}
		try {
			await db.insertInto("invocations").values(rows).execute();
		} catch (err) {
			logger?.error("event-store.bootstrap-failed", {
				count: rows.length,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const initialized = options?.persistence
		? bootstrapFromArchive(options.persistence.backend)
		: Promise.resolve();

	async function handleStarted(
		event: Extract<InvocationLifecycleEvent, { kind: "started" }>,
	): Promise<void> {
		try {
			await db
				.insertInto("invocations")
				.values({
					id: event.id,
					workflow: event.workflow,
					trigger: event.trigger,
					status: "pending",
					startedAt: event.ts.toISOString(),
					completedAt: null,
					error: null,
				})
				.execute();
		} catch (err) {
			logger?.error("event-store.insert-failed", {
				id: event.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function rowExists(id: string): Promise<boolean> {
		const row = await db
			.selectFrom("invocations")
			.select("id")
			.where("id", "=", id)
			.executeTakeFirst();
		return row !== undefined;
	}

	async function handleCompleted(
		event: Extract<InvocationLifecycleEvent, { kind: "completed" }>,
	): Promise<void> {
		try {
			// Upsert-style: start row may be missing if the `started` event was
			// never seen by this process. Two-step (select-then-update-or-insert)
			// because DuckDB's Kysely dialect does not expose `numUpdatedRows`
			// reliably across versions.
			if (await rowExists(event.id)) {
				await db
					.updateTable("invocations")
					.set({
						status: "succeeded",
						completedAt: event.ts.toISOString(),
						error: null,
					})
					.where("id", "=", event.id)
					.execute();
			} else {
				await db
					.insertInto("invocations")
					.values({
						id: event.id,
						workflow: event.workflow,
						trigger: event.trigger,
						status: "succeeded",
						startedAt: event.ts.toISOString(),
						completedAt: event.ts.toISOString(),
						error: null,
					})
					.execute();
			}
		} catch (err) {
			logger?.error("event-store.update-failed", {
				id: event.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function handleFailed(
		event: Extract<InvocationLifecycleEvent, { kind: "failed" }>,
	): Promise<void> {
		const errorJson = serializeError(event.error);
		try {
			if (await rowExists(event.id)) {
				await db
					.updateTable("invocations")
					.set({
						status: "failed",
						completedAt: event.ts.toISOString(),
						error: errorJson,
					})
					.where("id", "=", event.id)
					.execute();
			} else {
				await db
					.insertInto("invocations")
					.values({
						id: event.id,
						workflow: event.workflow,
						trigger: event.trigger,
						status: "failed",
						startedAt: event.ts.toISOString(),
						completedAt: event.ts.toISOString(),
						error: errorJson,
					})
					.execute();
			}
		} catch (err) {
			logger?.error("event-store.update-failed", {
				id: event.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		initialized,

		query: db.selectFrom("invocations") as SelectQueryBuilder<
			Database,
			"invocations",
			object
		>,

		async handle(event: InvocationLifecycleEvent): Promise<void> {
			if (event.kind === "started") {
				await handleStarted(event);
				return;
			}
			if (event.kind === "completed") {
				await handleCompleted(event);
				return;
			}
			await handleFailed(event);
		},

		with(name: string, fn: CteCallback): CteChain {
			// biome-ignore lint/suspicious/noExplicitAny: Kysely QueryCreator type in CTE callback
			const builder = db.with(name, (qb: any) =>
				fn(qb.selectFrom("invocations")),
			);
			return createCteChain(builder, name);
		},
	};
}

// biome-ignore lint/performance/noBarrelFile: intentional re-export — consumers must not import kysely directly
export { sql } from "kysely";
export type { CteCallback, CteChain, Database, EventStore, InvocationsTable };
export { createEventStore };
