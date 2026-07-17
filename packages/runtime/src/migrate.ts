import { type Kysely, type MigrationProvider, Migrator } from "kysely";
import type { Logger } from "./logger.js";
import { staticMigrationProvider } from "./migrations/index.js";

// Boot-time schema migration runner. Applies every pending migration to latest
// against the libSQL database, in ascending migration-name order, before either
// store opens. Forward-only (migrations define `up`, no `down`). A migration
// failure is fail-closed: this rejects, and the caller (main.ts) aborts boot
// before any store is constructed or any HTTP listener binds.
//
// Kysely tracks applied migrations in `kysely_migration` and takes an advisory
// lock via `kysely_migration_lock`; both tables are created on first run. The
// db type parameter is irrelevant — migrations issue DDL via raw `sql` — so any
// `Kysely<T>` is accepted (the Migrator itself is typed `Kysely<any>`).
async function runMigrations<T>(
	db: Kysely<T>,
	logger: Logger,
	provider: MigrationProvider = staticMigrationProvider,
): Promise<void> {
	const migrator = new Migrator({ db, provider });
	const { error, results } = await migrator.migrateToLatest();

	for (const result of results ?? []) {
		if (result.status === "Success") {
			logger.info("migrate.applied", { migration: result.migrationName });
		} else if (result.status === "Error") {
			logger.error("migrate.failed", { migration: result.migrationName });
		}
	}

	if (error !== undefined) {
		const message = error instanceof Error ? error.message : String(error);
		const failed = results?.find((r) => r.status === "Error")?.migrationName;
		logger.error("migrate.aborted", {
			...(failed === undefined ? {} : { migration: failed }),
			error: message,
		});
		throw new Error(
			failed === undefined
				? `schema migration failed before execution: ${message}`
				: `schema migration "${failed}" failed: ${message}`,
		);
	}
}

export { runMigrations };
