import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";
import { runMigrations } from "../migrate.js";
import { createTestLogger } from "./logger.js";

// Test helper: open a libSQL-backed Kysely on a `file:` database under `dir`.
// `createClient` is synchronous. The caller owns the returned `client`'s
// lifecycle (call `client.close()` when done; `db.destroy()` is a no-op on an
// injected client). Use the configured filename (`events.db`) so tests mirror
// the runtime layout, including reopen-across-restart cases.
function openLibsqlDb<T>(dir: string): { db: Kysely<T>; client: Client } {
	const client = createClient({ url: `file:${join(dir, "events.db")}` });
	const db = new Kysely<T>({ dialect: new LibsqlDialect({ client }) });
	return { db, client };
}

// In-memory libSQL (no file). For tests that don't need cross-reopen durability.
function openMemoryLibsqlDb<T>(): { db: Kysely<T>; client: Client } {
	const client = createClient({ url: ":memory:" });
	const db = new Kysely<T>({ dialect: new LibsqlDialect({ client }) });
	return { db, client };
}

// Migrated variants: open the db, then run the schema migrations to latest —
// mirroring the production boot order (migrate before the stores open). Since
// the store factories no longer create schema, tests that build a real store
// against a fresh db MUST migrate first. Idempotent, so reopening a
// previously-migrated `file:` db is a safe no-op.
async function openMigratedLibsqlDb<T>(
	dir: string,
): Promise<{ db: Kysely<T>; client: Client }> {
	const opened = openLibsqlDb<T>(dir);
	await runMigrations(opened.db, createTestLogger());
	return opened;
}

async function openMigratedMemoryLibsqlDb<T>(): Promise<{
	db: Kysely<T>;
	client: Client;
}> {
	const opened = openMemoryLibsqlDb<T>();
	await runMigrations(opened.db, createTestLogger());
	return opened;
}

interface TempLibsqlDb<T> {
	db: Kysely<T>;
	client: Client;
	dir: string;
	dispose: () => Promise<void>;
}

// Convenience for tests that use a Kysely directly (no store wrapper): creates a
// temp dir + client + db and a `dispose` that tears all three down.
async function createTempLibsqlDb<T>(): Promise<TempLibsqlDb<T>> {
	const dir = await mkdtemp(join(tmpdir(), "libsql-test-"));
	const { db, client } = await openMigratedLibsqlDb<T>(dir);
	return {
		db,
		client,
		dir,
		dispose: async () => {
			await db.destroy();
			client.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export type { TempLibsqlDb };
export {
	createTempLibsqlDb,
	openLibsqlDb,
	openMemoryLibsqlDb,
	openMigratedLibsqlDb,
	openMigratedMemoryLibsqlDb,
};
