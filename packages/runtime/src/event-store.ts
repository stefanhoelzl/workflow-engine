import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import type { InvocationEvent } from "@workflow-engine/core";
import { CompiledQuery, Kysely, type SelectQueryBuilder } from "kysely";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// EventStore — plain DuckDB on disk + Kysely query surface
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
	meta: unknown;
}

interface Database {
	events: EventsTable;
}

interface EventStoreConfig {
	commitMaxRetries: number;
	commitBackoffMs: number;
	sigtermFlushTimeoutMs: number;
}

interface EventStoreOptions {
	persistenceRoot: string;
	logger: Logger;
	config: EventStoreConfig;
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely CTE builder types are deeply generic — constraining them further adds complexity without safety
type QueryBuilder = SelectQueryBuilder<any, any, any>;
type CteCallback = (prev: QueryBuilder) => QueryBuilder;

interface CteChain {
	with(name: string, fn: CteCallback): CteChain;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely where() has complex overloads
	where(...args: any[]): QueryBuilder;
}

interface Scope {
	readonly owner: string;
	readonly repo: string;
}

interface EventStore {
	record(event: InvocationEvent): Promise<void>;
	query(
		scopes: readonly Scope[],
	): SelectQueryBuilder<Database, "events", object>;
	hasUploadEvent(
		owner: string,
		repo: string,
		workflow: string,
		workflowSha: string,
	): Promise<boolean>;
	ping(): Promise<void>;
	with(name: string, fn: CteCallback): CteChain;
	drainAndClose(): Promise<void>;
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

const CREATE_OWNER_REPO_INDEX_DDL =
	"CREATE INDEX IF NOT EXISTS events_owner_repo_idx ON events (owner, repo)";

// Kinds that close out an invocation. trigger.response and trigger.error are
// the natural pair to a trigger.request; trigger.exception and trigger.rejection
// are single-leaf events emitted host-side (pre-dispatch failures and HTTP body
// validation rejections — see `invocations/spec.md` and `executor/exception.ts`)
// that own a fresh invocation id with no earlier events. system.upload is also
// single-leaf, emitted host-side by `executor/upload-event.ts`.
const TERMINAL_KINDS = new Set([
	"trigger.response",
	"trigger.error",
	"trigger.exception",
	"trigger.rejection",
	"system.upload",
]);

function isTerminal(kind: string): boolean {
	return TERMINAL_KINDS.has(kind);
}

// DuckDB surfaces PK violations as "Constraint Error: Duplicate key … violates primary key constraint".
const PK_VIOLATION_RE = /constraint|primary key|duplicate key/i;

function isPrimaryKeyViolation(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return PK_VIOLATION_RE.test(message);
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

interface PendingInvocation {
	events: InvocationEvent[];
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups DB setup, accumulator, commit/retry loops, and the public surface that all share the connection — splitting would leak the connection as module state
async function createEventStore(
	options: EventStoreOptions,
): Promise<EventStore> {
	const { persistenceRoot, logger, config } = options;
	const absoluteRoot = resolve(persistenceRoot);
	await mkdir(absoluteRoot, { recursive: true });
	const dbPath = join(absoluteRoot, "events.duckdb");

	const instance = await DuckDBInstance.create(dbPath);
	const conn = await instance.connect();

	async function exec(sql: string): Promise<void> {
		await conn.run(sql);
	}

	await exec(CREATE_TABLE_DDL);
	await exec(CREATE_OWNER_REPO_INDEX_DDL);

	const rawDb = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});
	const db = rawDb;

	const accumulator = new Map<string, PendingInvocation>();
	let stopped = false;

	function appendToAccumulator(event: InvocationEvent): void {
		let entry = accumulator.get(event.id);
		if (!entry) {
			entry = { events: [] };
			accumulator.set(event.id, entry);
		}
		entry.events.push(event);
	}

	async function commitOnce(events: InvocationEvent[]): Promise<string> {
		const rows = events.map(eventToRow);
		const start = Date.now();
		await db.insertInto("events").values(rows).execute();
		return `${Date.now() - start}ms`;
	}

	function backoffMs(attempt: number): number {
		return config.commitBackoffMs * 2 ** attempt;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retry-then-drop is the spec; loop body groups try/catch + structured-log + backoff + PK fast-fail
	async function commitWithRetry(
		id: string,
		owner: string,
		repo: string,
		events: InvocationEvent[],
	): Promise<boolean> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= config.commitMaxRetries; attempt += 1) {
			try {
				// biome-ignore lint/performance/noAwaitInLoops: serial retry is the point
				const duration = await commitOnce(events);
				logger.info("event-store.commit-ok", {
					id,
					owner,
					repo,
					rows: events.length,
					duration,
				});
				return true;
			} catch (err) {
				lastError = err;
				if (isPrimaryKeyViolation(err)) {
					logger.error("event-store.commit-dropped", {
						id,
						owner,
						repo,
						reason: "primary-key-violation",
						error: err instanceof Error ? err.message : String(err),
					});
					return false;
				}
				if (attempt < config.commitMaxRetries) {
					logger.warn("event-store.commit-retry", {
						id,
						owner,
						repo,
						attempt: attempt + 1,
						error: err instanceof Error ? err.message : String(err),
					});
					await new Promise((resolve) =>
						setTimeout(resolve, backoffMs(attempt)),
					);
				}
			}
		}
		logger.error("event-store.commit-dropped", {
			id,
			owner,
			repo,
			attempts: config.commitMaxRetries + 1,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		});
		return false;
	}

	async function commitInvocation(id: string): Promise<void> {
		const entry = accumulator.get(id);
		if (!entry || entry.events.length === 0) {
			return;
		}
		const first = entry.events[0];
		if (!first) {
			accumulator.delete(id);
			return;
		}
		// Evict before commit to avoid double-commit if record() is called while
		// the retry loop is mid-flight. The events list is captured locally.
		accumulator.delete(id);
		await commitWithRetry(id, first.owner, first.repo, entry.events);
	}

	return {
		async record(event: InvocationEvent): Promise<void> {
			if (stopped) {
				logger.warn("event-store.record-after-stop", {
					id: event.id,
					seq: event.seq,
					kind: event.kind,
				});
				return;
			}
			appendToAccumulator(event);
			if (isTerminal(event.kind)) {
				await commitInvocation(event.id);
			}
		},

		query(
			scopes: readonly Scope[],
		): SelectQueryBuilder<Database, "events", object> {
			if (scopes.length === 0) {
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

		with(name: string, fn: CteCallback): CteChain {
			// biome-ignore lint/suspicious/noExplicitAny: Kysely QueryCreator type in CTE callback
			const builder = db.with(name, (qb: any) => fn(qb.selectFrom("events")));
			return createCteChain(builder, name);
		},

		async drainAndClose(): Promise<void> {
			stopped = true;
			const deadline = Date.now() + config.sigtermFlushTimeoutMs;
			for (const [id, entry] of accumulator) {
				if (Date.now() >= deadline) {
					logger.warn("event-store.sigterm-drain-timeout", {
						remaining: accumulator.size,
					});
					break;
				}
				const last = entry.events.at(-1);
				const lastSeq = last?.seq ?? -1;
				const first = entry.events[0];
				if (!first) {
					accumulator.delete(id);
					continue;
				}
				const synthetic: InvocationEvent = {
					kind: "trigger.error",
					id,
					seq: lastSeq + 1,
					ref: null,
					at: new Date().toISOString(),
					ts: last?.ts ?? 0,
					owner: first.owner,
					repo: first.repo,
					workflow: first.workflow,
					workflowSha: first.workflowSha,
					name: first.name,
					error: {
						message: "runtime shutting down",
						kind: "shutdown",
					},
				};
				entry.events.push(synthetic);
				// biome-ignore lint/performance/noAwaitInLoops: drain serially so the write set stays bounded
				await commitInvocation(id);
			}
			await db.destroy();
		},
	};
}

// biome-ignore lint/performance/noBarrelFile: intentional re-export — consumers must not import kysely directly
export { sql } from "kysely";
export type {
	CteCallback,
	CteChain,
	Database,
	EventStore,
	EventStoreConfig,
	EventsTable,
	Scope,
};
export { createEventStore };
