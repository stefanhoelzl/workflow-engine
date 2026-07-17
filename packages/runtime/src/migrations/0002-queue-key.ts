import { type Migration, sql } from "kysely";

// Keyed queues: add a `key` partition selector to queue_items. Lossless —
// existing rows are stamped with the unkeyed partition ('') by the column
// default. The ALTER is unconditional and safe because 0001-initial never
// creates a `key` column (migrations are immutable; the column is added here
// and only here), so this runs exactly once per database.
//
// The composite index (…, queue, key, seq) supports per-partition FIFO get
// (WHERE tuple AND key, MIN(seq)); the prior (…, queue, seq) index is dropped
// so fresh databases (0001 → 0002) and migrated databases end with an
// identical index set.

const ADD_KEY_COLUMN = `ALTER TABLE queue_items ADD COLUMN key TEXT NOT NULL DEFAULT ''`;

const CREATE_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS queue_items_tuple_key_seq_idx
	ON queue_items (owner, repo, workflow, queue, key, seq)
`;

const DROP_OLD_INDEX = "DROP INDEX IF EXISTS queue_items_tuple_seq_idx";

const migration0002QueueKey: Migration = {
	async up(db) {
		await sql.raw(ADD_KEY_COLUMN).execute(db);
		await sql.raw(CREATE_KEY_INDEX).execute(db);
		await sql.raw(DROP_OLD_INDEX).execute(db);
	},
};

export { migration0002QueueKey };
