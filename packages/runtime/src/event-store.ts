import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbDialect } from "@oorabona/kysely-duckdb";
import type { InvocationEvent } from "@workflow-engine/core";
import { CompiledQuery, Kysely, type SelectQueryBuilder } from "kysely";
import type { Logger } from "./logger.js";
import type { StorageBackend, StorageLocator } from "./storage/index.js";

// ---------------------------------------------------------------------------
// EventStore — DuckLake-backed durable archive + Kysely query surface
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
	checkpointIntervalMs: number;
	checkpointMaxInlinedRows: number;
	checkpointMaxCatalogBytes: number;
	commitMaxRetries: number;
	commitBackoffMs: number;
	sigtermFlushTimeoutMs: number;
}

interface EventStoreOptions {
	backend: StorageBackend;
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
CREATE TABLE IF NOT EXISTS event_store.events (
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
	meta JSON
)`;

const SET_PARTITIONED_DDL =
	"ALTER TABLE event_store.events SET PARTITIONED BY (owner, repo)";

const URL_SCHEME_RE = /^https?:\/\//;

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

function quoteSqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function composeAttachSql(locator: StorageLocator): {
	prelude: string[];
	attach: string;
	catalogPath: string;
} {
	if (locator.kind === "fs") {
		const catalog = join(locator.root, "events.duckdb");
		const dataPath = join(locator.root, "events");
		return {
			prelude: [],
			attach: `ATTACH ${quoteSqlString(`ducklake:${catalog}`)} AS event_store (DATA_PATH ${quoteSqlString(dataPath)})`,
			catalogPath: catalog,
		};
	}
	const scheme = locator.useSsl ? "https" : "http";
	const endpointHostPort = locator.endpoint.replace(URL_SCHEME_RE, "");
	const catalogUri = `s3://${locator.bucket}/events.duckdb`;
	const dataPath = `s3://${locator.bucket}/events/`;
	const prelude = [
		"CREATE OR REPLACE SECRET event_store_s3 (",
		"  TYPE S3,",
		`  KEY_ID ${quoteSqlString(locator.accessKeyId.reveal())},`,
		`  SECRET ${quoteSqlString(locator.secretAccessKey.reveal())},`,
		`  REGION ${quoteSqlString(locator.region)},`,
		`  ENDPOINT ${quoteSqlString(endpointHostPort)},`,
		`  URL_STYLE ${quoteSqlString(locator.urlStyle)},`,
		`  USE_SSL ${locator.useSsl ? "true" : "false"},`,
		`  SCOPE ${quoteSqlString(`s3://${locator.bucket}`)}`,
		")",
	];
	return {
		prelude: [`-- using ${scheme} endpoint`, prelude.join("\n")],
		attach: `ATTACH ${quoteSqlString(`ducklake:${catalogUri}`)} AS event_store (DATA_PATH ${quoteSqlString(dataPath)})`,
		catalogPath: catalogUri,
	};
}

async function getCatalogBytes(catalogPath: string): Promise<number> {
	if (!catalogPath.startsWith("/")) {
		// S3 URI — we don't have a cheap stat for the remote catalog. Return -1
		// to disable the size threshold for S3 (timer-driven CHECKPOINT still works).
		return -1;
	}
	try {
		const s = await stat(catalogPath);
		return s.size;
	} catch {
		return 0;
	}
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups DuckLake setup, accumulator, commit/retry/checkpoint loops, and the public surface that all share the connection — splitting would leak the connection as module state
async function createEventStore(
	options: EventStoreOptions,
): Promise<EventStore> {
	const { backend, logger, config } = options;
	const locator = backend.locator();

	const instance = await DuckDBInstance.create();
	const conn = await instance.connect();

	async function exec(sql: string): Promise<void> {
		await conn.run(sql);
	}

	await exec("INSTALL ducklake;");
	await exec("LOAD ducklake;");
	if (locator.kind === "s3") {
		await exec("INSTALL httpfs;");
		await exec("LOAD httpfs;");
	}

	const { prelude, attach, catalogPath } = composeAttachSql(locator);
	for (const stmt of prelude) {
		if (stmt.startsWith("--")) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: prelude statements must execute in order
		await exec(stmt);
	}
	await exec(attach);
	await exec("USE event_store;");
	await exec(CREATE_TABLE_DDL);
	try {
		await exec(SET_PARTITIONED_DDL);
	} catch (err) {
		// Idempotent: ALTER ... SET PARTITIONED BY may fail if already partitioned
		// the same way on subsequent boots. Log and continue.
		logger.debug("event-store.partition-already-set", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// `event_store` is the DuckLake-attached database name. Kysely connections
	// opened by the dialect default to the unattached `memory` database where
	// the events table does not exist. `withSchema("event_store")` scopes every
	// generated query — `selectFrom("events")`, `insertInto("events")`, `with()`
	// — to `"event_store"."events"`, which DuckDB resolves to the DuckLake
	// table regardless of the current connection's USE state.
	const rawDb = new Kysely<Database>({
		dialect: new DuckDbDialect({ database: instance }),
	});
	const db = rawDb.withSchema("event_store");

	const accumulator = new Map<string, PendingInvocation>();
	let nextCheckpointAt = Date.now() + config.checkpointIntervalMs;
	let inlinedRowsApprox = 0;
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

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retry-then-drop is the spec; loop body groups try/catch + structured-log + backoff
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
				inlinedRowsApprox += events.length;
				return true;
			} catch (err) {
				lastError = err;
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

	function describeTrigger(
		sizeTrip: boolean,
		inlineTrip: boolean,
	): "size" | "inlined-rows" | "interval" {
		if (sizeTrip) {
			return "size";
		}
		if (inlineTrip) {
			return "inlined-rows";
		}
		return "interval";
	}

	async function maybeCheckpoint(): Promise<void> {
		const now = Date.now();
		const catalogBytes = await getCatalogBytes(catalogPath);
		const sizeTrip =
			catalogBytes >= 0 && catalogBytes > config.checkpointMaxCatalogBytes;
		const inlineTrip = inlinedRowsApprox > config.checkpointMaxInlinedRows;
		const timeTrip = now >= nextCheckpointAt;
		if (!(sizeTrip || inlineTrip || timeTrip)) {
			return;
		}
		if (inlinedRowsApprox === 0 && !sizeTrip) {
			logger.debug("event-store.checkpoint-skip", { reason: "no-work" });
			nextCheckpointAt = now + config.checkpointIntervalMs;
			return;
		}
		const start = Date.now();
		try {
			await exec("CHECKPOINT;");
			const after = await getCatalogBytes(catalogPath);
			logger.info("event-store.checkpoint-run", {
				durationMs: Date.now() - start,
				catalogBytesBefore: catalogBytes,
				catalogBytesAfter: after,
				inlinedRowsFlushedApprox: inlinedRowsApprox,
				trigger: describeTrigger(sizeTrip, inlineTrip),
			});
			inlinedRowsApprox = 0;
			nextCheckpointAt = now + config.checkpointIntervalMs;
		} catch (err) {
			logger.error("event-store.checkpoint-failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const checkpointTimer = setInterval(
		() => {
			maybeCheckpoint().catch((err) => {
				logger.error("event-store.checkpoint-tick-failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		},
		// biome-ignore lint/style/noMagicNumbers: timer cadence — at most 1/4 of the configured interval, with a 1s floor so the timer is responsive enough for short-interval test configs without busy-looping
		Math.max(1000, Math.floor(config.checkpointIntervalMs / 4)),
	);
	checkpointTimer.unref();

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
				await maybeCheckpoint();
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
			clearInterval(checkpointTimer);
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
				// biome-ignore lint/performance/noAwaitInLoops: drain serially so the catalog write set stays bounded
				await commitInvocation(id);
			}
			try {
				await exec("CHECKPOINT;");
			} catch (err) {
				logger.warn("event-store.checkpoint-on-shutdown-failed", {
					error: err instanceof Error ? err.message : String(err),
				});
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
