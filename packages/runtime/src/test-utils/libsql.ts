import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";

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
	const { db, client } = openLibsqlDb<T>(dir);
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
export { createTempLibsqlDb, openLibsqlDb, openMemoryLibsqlDb };
