import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import { Kysely, CompiledQuery, type SelectQueryBuilder } from "kysely";
import type { BusConsumer, RuntimeEvent } from "./index.js";

interface EventsTable {
	id: string;
	type: string;
	correlationId: string;
	parentEventId: string | null;
	targetAction: string | null;
	state: string;
	result: string | null;
	payload: unknown;
	error: unknown;
	createdAt: string;
	sourceType: string;
	sourceName: string;
	emittedAt: string;
	startedAt: string | null;
	doneAt: string | null;
}

interface Database {
	events: EventsTable;
}

interface EventStoreOptions {
	logger?: { error(msg: string, data: Record<string, unknown>): void };
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
	readonly query: SelectQueryBuilder<Database, "events", object>;
	with(name: string, fn: CteCallback): CteChain;
}

const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	correlationId TEXT NOT NULL,
	parentEventId TEXT,
	targetAction TEXT,
	state TEXT NOT NULL,
	result TEXT,
	payload JSON,
	error JSON,
	createdAt TIMESTAMPTZ NOT NULL,
	sourceType TEXT NOT NULL,
	sourceName TEXT NOT NULL,
	emittedAt TIMESTAMPTZ NOT NULL,
	startedAt TIMESTAMPTZ,
	doneAt TIMESTAMPTZ
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled event store logic
async function createEventStore(
	options?: EventStoreOptions,
): Promise<EventStore> {
	const instance = await DuckDBInstance.create();
	const db = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});
	await db.executeQuery(CompiledQuery.raw(CREATE_TABLE_DDL));

	const logger = options?.logger;

	function toRow(event: RuntimeEvent) {
		return {
			id: event.id,
			type: event.type,
			correlationId: event.correlationId,
			parentEventId: event.parentEventId ?? null,
			targetAction: event.targetAction ?? null,
			state: event.state,
			result: event.state === "done" ? event.result : null,
			payload:
				event.payload === undefined ? null : JSON.stringify(event.payload),
			error:
				event.state === "done" && event.result === "failed"
					? JSON.stringify(event.error)
					: null,
			createdAt: event.createdAt.toISOString(),
			sourceType: event.sourceType,
			sourceName: event.sourceName,
			emittedAt: event.emittedAt.toISOString(),
			startedAt: event.startedAt?.toISOString() ?? null,
			doneAt: event.doneAt?.toISOString() ?? null,
		};
	}

	return {
		query: db.selectFrom("events") as SelectQueryBuilder<
			Database,
			"events",
			object
		>,

		async handle(event: RuntimeEvent): Promise<void> {
			try {
				await db.insertInto("events").values(toRow(event)).execute();
			} catch (err) {
				logger?.error("event-store.index-failed", {
					eventId: event.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		async bootstrap(
			events: RuntimeEvent[],
			_options?: { pending?: boolean },
		): Promise<void> {
			if (events.length === 0) {
				return;
			}
			try {
				await db.insertInto("events").values(events.map(toRow)).execute();
			} catch (err) {
				logger?.error("event-store.bootstrap-failed", {
					count: events.length,
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

export { createEventStore };
// biome-ignore lint/performance/noBarrelFile: intentional re-export — consumers must not import kysely directly
export { sql } from "kysely";
export type { EventStore, CteChain, CteCallback, Database, EventsTable };
