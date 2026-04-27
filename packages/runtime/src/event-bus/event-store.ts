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
	owner: string;
	repo: string;
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

interface Scope {
	readonly owner: string;
	readonly repo: string;
}

interface EventStore extends BusConsumer {
	// Scopes MUST be drawn from an audited allow-set (see SECURITY.md §1 I-T2).
	// Callers route through `resolveQueryScopes(user, ...)` — never construct
	// scopes directly from URL segments. Throws if `scopes` is empty; empty
	// scopes would otherwise compile to a tautological `WHERE 1=1` and leak
	// cross-owner data.
	query(
		scopes: readonly Scope[],
	): SelectQueryBuilder<Database, "events", object>;
	// Sha-based dedup gate for `system.upload` emission. Returns `true` iff a
	// `system.upload` event already exists for the exact (owner, repo,
	// workflow, workflowSha) tuple. The upload handler is the only caller —
	// `(owner, repo)` is already authorized by `requireOwnerMember()` so this
	// bypasses the scope-allow-list contract that `query()` enforces. Other
	// callers MUST NOT rely on this method to fetch event data.
	hasUploadEvent(
		owner: string,
		repo: string,
		workflow: string,
		workflowSha: string,
	): Promise<boolean>;
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
	owner TEXT NOT NULL,
	repo TEXT NOT NULL,
	workflow TEXT NOT NULL,
	workflowSha TEXT NOT NULL,
	name TEXT NOT NULL,
	input JSON,
	output JSON,
	error JSON,
	meta JSON,
	PRIMARY KEY (id, seq)
)`;

const CREATE_INDEX_DDL =
	"CREATE INDEX IF NOT EXISTS events_owner_repo ON events (owner, repo)";

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
		owner: event.owner,
		repo: event.repo,
		workflow: event.workflow,
		workflowSha: event.workflowSha,
		name: event.name,
		input: event.input === undefined ? null : JSON.stringify(event.input),
		output: event.output === undefined ? null : JSON.stringify(event.output),
		error: event.error === undefined ? null : JSON.stringify(event.error),
		meta: event.meta === undefined ? null : JSON.stringify(event.meta),
	};
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups DuckDB setup, scope-guard query compilation, and the BusConsumer interface methods that all share the Kysely handle — splitting would leak the handle as a module-level global
async function createEventStore(
	options?: EventStoreOptions,
): Promise<EventStore> {
	const instance = await DuckDBInstance.create();
	const db = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});
	await db.executeQuery(CompiledQuery.raw(CREATE_TABLE_DDL));
	await db.executeQuery(CompiledQuery.raw(CREATE_INDEX_DDL));

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
		name: "event-store",
		strict: false,
		initialized,

		query(
			scopes: readonly Scope[],
		): SelectQueryBuilder<Database, "events", object> {
			if (scopes.length === 0) {
				// Empty scope list would compile to `WHERE 1=0`, but caller code
				// universally expects a non-empty result shape — fail loudly so a
				// middleware bug (unauthenticated user, forgotten scope resolution)
				// never silently returns zero rows under a permissive WHERE.
				throw new Error(
					"EventStore.query: scopes must be a non-empty (owner, repo) allow-list",
				);
			}
			const tuples = scopes.map((s) => [s.owner, s.repo] as const);
			return db
				.selectFrom("events")
				.where((eb) =>
					eb.or(
						tuples.map(([owner, repo]) =>
							eb.and([eb("owner", "=", owner), eb("repo", "=", repo)]),
						),
					),
				) as SelectQueryBuilder<Database, "events", object>;
		},

		async hasUploadEvent(
			owner: string,
			repo: string,
			workflow: string,
			workflowSha: string,
		): Promise<boolean> {
			const row = await db
				.selectFrom("events")
				.select(db.fn.countAll<number>().as("c"))
				.where("kind", "=", "system.upload")
				.where("owner", "=", owner)
				.where("repo", "=", repo)
				.where("workflow", "=", workflow)
				.where("workflowSha", "=", workflowSha)
				.executeTakeFirst();
			return Number(row?.c ?? 0) > 0;
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
export type { CteCallback, CteChain, Database, EventStore, EventsTable, Scope };
export { createEventStore };
