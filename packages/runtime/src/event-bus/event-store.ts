import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import { Kysely, CompiledQuery } from "kysely";
import type { SelectQueryBuilder } from "kysely";
import type { BusConsumer, RuntimeEvent } from "./index.js";

interface EventsTable {
	id: string;
	type: string;
	correlationId: string;
	parentEventId: string | null;
	targetAction: string | null;
	state: string;
	payload: unknown;
	error: unknown;
	createdAt: string;
}

interface Database {
	events: EventsTable;
}

interface EventStoreOptions {
	logger?: { error(msg: string, data: Record<string, unknown>): void };
}

interface EventStore extends BusConsumer {
	query: SelectQueryBuilder<Database, "events", object>;
}

const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	correlationId TEXT NOT NULL,
	parentEventId TEXT,
	targetAction TEXT,
	state TEXT NOT NULL,
	payload JSON,
	error JSON,
	createdAt TIMESTAMPTZ NOT NULL
)`;

async function createEventStore(options?: EventStoreOptions): Promise<EventStore> {
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
			payload: event.payload === undefined ? null : JSON.stringify(event.payload),
			error: event.error === undefined ? null : JSON.stringify(event.error),
			createdAt: event.createdAt.toISOString(),
		};
	}

	return {
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
			_options?: { finished?: boolean; pending?: boolean },
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

		get query() {
			return db.selectFrom("events");
		},
	};
}

export { createEventStore };
// biome-ignore lint/performance/noBarrelFile: intentional re-export — consumers must not import kysely directly
export { sql } from "kysely";
export type { EventStore, Database, EventsTable };
