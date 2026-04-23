import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import type { InvocationEvent } from "@workflow-engine/core";
import { CompiledQuery, Kysely, type SelectQueryBuilder } from "kysely";
import type { StorageBackend } from "../storage/index.js";
import type { BusConsumer } from "./index.js";
import { scanArchive } from "./persistence.js";

// ---------------------------------------------------------------------------
// Events table — one row per InvocationEvent, append-only.
// ---------------------------------------------------------------------------

interface EventsTable {
	id: string;
	seq: number;
	kind: string;
	ref: number | null;
	at: string;
	ts: number;
	tenant: string;
	workflow: string;
	workflowSha: string;
	name: string;
	input: unknown;
	output: unknown;
	error: unknown;
	// Runtime-only metadata stamped by the executor's onEvent widener.
	// Populated on `trigger.request` rows with `{ dispatch: { source, user? } }`;
	// NULL for every other event kind and for legacy archive records that
	// predate this column.
	meta: unknown;
}

interface Database {
	events: EventsTable;
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
	query(tenant: string): SelectQueryBuilder<Database, "events", object>;
	ping(): Promise<void>;
	with(name: string, fn: CteCallback): CteChain;
	readonly initialized: Promise<void>;
}

const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	ref INTEGER,
	"at" TIMESTAMPTZ NOT NULL,
	ts BIGINT NOT NULL,
	tenant TEXT NOT NULL,
	workflow TEXT NOT NULL,
	workflowSha TEXT NOT NULL,
	name TEXT NOT NULL,
	input JSON,
	output JSON,
	error JSON,
	meta JSON,
	PRIMARY KEY (id, seq)
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

function eventToRow(event: InvocationEvent): EventsTable {
	return {
		id: event.id,
		seq: event.seq,
		kind: event.kind,
		ref: event.ref,
		at: event.at,
		ts: event.ts,
		tenant: event.tenant,
		workflow: event.workflow,
		workflowSha: event.workflowSha,
		name: event.name,
		input: event.input === undefined ? null : JSON.stringify(event.input),
		output: event.output === undefined ? null : JSON.stringify(event.output),
		error: event.error === undefined ? null : JSON.stringify(event.error),
		meta: event.meta === undefined ? null : JSON.stringify(event.meta),
	};
}

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
		const rows: EventsTable[] = [];
		for await (const event of scanArchive(backend)) {
			rows.push(eventToRow(event));
		}
		if (rows.length === 0) {
			return;
		}
		try {
			await db.insertInto("events").values(rows).execute();
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

	return {
		initialized,

		query(tenant: string): SelectQueryBuilder<Database, "events", object> {
			return db
				.selectFrom("events")
				.where("tenant", "=", tenant) as SelectQueryBuilder<
				Database,
				"events",
				object
			>;
		},

		async ping(): Promise<void> {
			await db.executeQuery(CompiledQuery.raw("SELECT 1"));
		},

		async handle(event: InvocationEvent): Promise<void> {
			try {
				await db.insertInto("events").values(eventToRow(event)).execute();
			} catch (err) {
				logger?.error("event-store.insert-failed", {
					id: event.id,
					seq: event.seq,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		with(name: string, fn: CteCallback): CteChain {
			// biome-ignore lint/suspicious/noExplicitAny: Kysely QueryCreator type in CTE callback
			const builder = db.with(name, (qb: any) => fn(qb.selectFrom("events")));
			return createCteChain(builder, name);
		},
	};
}

// biome-ignore lint/performance/noBarrelFile: intentional re-export — consumers must not import kysely directly
export { sql } from "kysely";
export type { CteCallback, CteChain, Database, EventStore, EventsTable };
export { createEventStore };
