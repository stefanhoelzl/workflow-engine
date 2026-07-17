import type { Migration, MigrationProvider } from "kysely";
import { migration0001Initial } from "./0001-initial.js";
import { migration0002QueueKey } from "./0002-queue-key.js";

// Static, in-code migration provider. The runtime ships as a single-file SSR
// bundle (dist/main.js) with no source-tree migrations directory at run time,
// so Kysely's FileMigrationProvider (which reads a folder via fs.readdir) is
// unusable. The migrations are compiled-in and returned as an object literal;
// Kysely applies them in ascending order of the (lexicographic) keys.
//
// Migrations are forward-only: each defines `up` and no `down`.
const migrations: Record<string, Migration> = {
	"0001-initial": migration0001Initial,
	"0002-queue-key": migration0002QueueKey,
};

const staticMigrationProvider: MigrationProvider = {
	getMigrations() {
		return Promise.resolve(migrations);
	},
};

export { migrations, staticMigrationProvider };
