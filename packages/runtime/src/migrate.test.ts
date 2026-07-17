import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely, type LogEvent, type MigrationProvider } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type Database as EventDatabase,
	sql,
} from "./event-store.js";
import { runMigrations } from "./migrate.js";
import { migration0001Initial } from "./migrations/0001-initial.js";
import {
	createQueueStore,
	type Database as QueueDatabase,
} from "./queue-store.js";
import {
	openLibsqlDb,
	openMemoryLibsqlDb,
	openMigratedMemoryLibsqlDb,
} from "./test-utils/libsql.js";
import { createTestLogger } from "./test-utils/logger.js";

// Resources to tear down after each test.
const clients: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		client.close();
	}
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function memoryDb(): { db: Kysely<unknown>; client: Client } {
	const opened = openMemoryLibsqlDb<unknown>();
	clients.push(opened.client);
	return opened;
}

async function seedEventRow(db: Kysely<unknown>): Promise<void> {
	await sql`
		INSERT INTO events (id, seq, kind, "at", ts, owner, repo, workflow, workflowSha, name)
		VALUES ('inv1', 1, 'trigger.request', '2026-01-01T00:00:00Z', 1, 'acme', 'foo', 'build', 'sha1', 't')
	`.execute(db);
}

async function seedQueueRow(db: Kysely<unknown>): Promise<void> {
	await sql`
		INSERT INTO queue_items (owner, repo, workflow, queue, enqueuedAt, invocationId, triggerKind, triggerName, item)
		VALUES ('acme', 'foo', 'build', 'jobs', '2026-01-01T00:00:00Z', 'inv1', 'cron', 't', '{}')
	`.execute(db);
}

async function count(db: Kysely<unknown>, table: string): Promise<number> {
	const result = await sql<{ n: number }>`
		SELECT count(*) AS n FROM ${sql.ref(table)}
	`.execute(db);
	return Number(result.rows[0]?.n ?? 0);
}

async function appliedNames(db: Kysely<unknown>): Promise<string[]> {
	const result = await sql<{ name: string }>`
		SELECT name FROM kysely_migration ORDER BY name
	`.execute(db);
	return result.rows.map((r) => r.name);
}

describe("runMigrations", () => {
	it("applies every migration on a fresh database and records it", async () => {
		const { db } = memoryDb();
		const logger = createTestLogger();

		await runMigrations(db, logger);

		expect(await appliedNames(db)).toContain("0001-initial");
		// Baseline schema exists.
		expect(await count(db, "events")).toBe(0);
		expect(await count(db, "queue_items")).toBe(0);
		expect(
			logger.info.mock.calls.some(
				(c) => c[0] === "migrate.applied" && c[1]?.migration === "0001-initial",
			),
		).toBe(true);
	});

	it("re-runs nothing against an already-migrated database", async () => {
		const { db } = memoryDb();
		await runMigrations(db, createTestLogger());

		const logger = createTestLogger();
		await runMigrations(db, logger);

		const applied = logger.info.mock.calls.filter(
			(c) => c[0] === "migrate.applied",
		);
		expect(applied).toHaveLength(0);
	});

	it("logs the failing migration and throws (fail-closed)", async () => {
		const { db } = memoryDb();
		const logger = createTestLogger();
		const failing: MigrationProvider = {
			getMigrations() {
				return Promise.resolve({
					"0001-boom": {
						up() {
							return Promise.reject(new Error("boom"));
						},
					},
				});
			},
		};

		await expect(runMigrations(db, logger, failing)).rejects.toThrow(
			/0001-boom/,
		);
		expect(
			logger.error.mock.calls.some(
				(c) => c[0] === "migrate.failed" && c[1]?.migration === "0001-boom",
			),
		).toBe(true);
	});

	it("baselines an existing unversioned database without data loss", async () => {
		const { db } = memoryDb();
		// Simulate the live-DB shape: schema present (as the store factories
		// created it), rows populated, and NO kysely_migration tracking table.
		await migration0001Initial.up(db);
		await seedEventRow(db);
		await seedQueueRow(db);

		await runMigrations(db, createTestLogger());

		// 0001 is recorded as applied…
		expect(await appliedNames(db)).toContain("0001-initial");
		// …and the pre-existing rows are retained (no DROP / destructive step).
		expect(await count(db, "events")).toBe(1);
		expect(await count(db, "queue_items")).toBe(1);
	});

	it("produces the expected columns and indexes on a fresh database", async () => {
		const opened = await openMigratedMemoryLibsqlDb<unknown>();
		clients.push(opened.client);
		const db = opened.db;

		const eventCols = await sql<{ name: string }>`
			PRAGMA table_info(events)
		`.execute(db);
		expect(eventCols.rows.map((r) => r.name)).toEqual(
			expect.arrayContaining([
				"id",
				"seq",
				"kind",
				"at",
				"ts",
				"owner",
				"repo",
				"workflow",
				"workflowSha",
				"name",
			]),
		);
		const eventIdx = await sql<{ name: string }>`
			PRAGMA index_list(events)
		`.execute(db);
		expect(eventIdx.rows.some((r) => r.name === "events_dash_idx")).toBe(true);

		const queueCols = await sql<{ name: string }>`
			PRAGMA table_info(queue_items)
		`.execute(db);
		expect(queueCols.rows.map((r) => r.name)).toEqual(
			expect.arrayContaining([
				"seq",
				"owner",
				"repo",
				"workflow",
				"queue",
				"enqueuedAt",
				"invocationId",
				"triggerKind",
				"triggerName",
				"item",
			]),
		);
		const queueIdx = await sql<{ name: string }>`
			PRAGMA index_list(queue_items)
		`.execute(db);
		expect(
			queueIdx.rows.some((r) => r.name === "queue_items_tuple_seq_idx"),
		).toBe(true);
	});

	it("store factories issue no schema DDL against a migrated database", async () => {
		const client = createClient({ url: ":memory:" });
		clients.push(client);
		const captured: string[] = [];
		const log = (event: LogEvent): void => {
			if (event.level === "query") {
				captured.push(event.query.sql);
			}
		};
		const eventDb = new Kysely<EventDatabase>({
			dialect: new LibsqlDialect({ client }),
			log,
		});
		const queueDb = new Kysely<QueueDatabase>({
			dialect: new LibsqlDialect({ client }),
			log,
		});

		await runMigrations(eventDb, createTestLogger());
		// Only observe SQL issued during store construction.
		captured.length = 0;

		const eventStore = await createEventStore({
			db: eventDb,
			logger: createTestLogger(),
			config: {
				commitMaxRetries: 0,
				commitBackoffMs: 0,
				sigtermFlushTimeoutMs: 5000,
				retentionDays: 0,
			},
		});
		const queueStore = await createQueueStore({
			db: queueDb,
			logger: createTestLogger(),
		});

		expect(
			captured.some((s) =>
				/create\s+table|create\s+index|alter\s+table/i.test(s),
			),
		).toBe(false);

		await eventStore.drainAndClose();
		await queueStore.close();
	});

	it("is idempotent across a restart (crash recovery)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
		dirs.push(dir);

		const first = openLibsqlDb<unknown>(dir);
		await runMigrations(first.db, createTestLogger());
		await seedQueueRow(first.db);
		await first.db.destroy();
		first.client.close();

		// Reopen the same file (simulating a process restart) and migrate again.
		const second = openLibsqlDb<unknown>(dir);
		clients.push(second.client);
		const logger = createTestLogger();
		await runMigrations(second.db, logger);

		expect(logger.info.mock.calls.some((c) => c[0] === "migrate.applied")).toBe(
			false,
		);
		expect(await count(second.db, "queue_items")).toBe(1);
	});
});
