import { type Migration, sql } from "kysely";

// Baseline migration. Reproduces the schema the store factories created before
// the migration framework landed, using `CREATE … IF NOT EXISTS` so it is a
// recorded no-op against the live, already-populated databases and builds the
// baseline on a fresh one. The DDL text is copied verbatim from the former
// `event-store.ts` / `queue-store.ts` constants — keep it byte-for-byte, since
// a fresh database's schema is defined solely by this migration.

const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	ref INTEGER,
	"at" TEXT NOT NULL,
	ts INTEGER NOT NULL,
	owner TEXT NOT NULL,
	repo TEXT NOT NULL,
	workflow TEXT NOT NULL,
	workflowSha TEXT NOT NULL,
	name TEXT NOT NULL,
	input TEXT,
	output TEXT,
	error TEXT,
	meta TEXT,
	PRIMARY KEY (id, seq)
)`;

const CREATE_EVENTS_DASH_INDEX =
	'CREATE INDEX IF NOT EXISTS events_dash_idx ON events (owner, repo, kind, "at")';

const CREATE_QUEUE_ITEMS_TABLE = `
CREATE TABLE IF NOT EXISTS queue_items (
	seq            INTEGER PRIMARY KEY AUTOINCREMENT,
	owner          TEXT NOT NULL,
	repo           TEXT NOT NULL,
	workflow       TEXT NOT NULL,
	queue          TEXT NOT NULL,
	enqueuedAt     TEXT NOT NULL,
	invocationId   TEXT NOT NULL,
	triggerKind    TEXT NOT NULL,
	triggerName    TEXT NOT NULL,
	item           TEXT NOT NULL
)`;

const CREATE_QUEUE_ITEMS_INDEX = `
CREATE INDEX IF NOT EXISTS queue_items_tuple_seq_idx
	ON queue_items (owner, repo, workflow, queue, seq)
`;

const migration0001Initial: Migration = {
	async up(db) {
		await sql.raw(CREATE_EVENTS_TABLE).execute(db);
		await sql.raw(CREATE_EVENTS_DASH_INDEX).execute(db);
		await sql.raw(CREATE_QUEUE_ITEMS_TABLE).execute(db);
		await sql.raw(CREATE_QUEUE_ITEMS_INDEX).execute(db);
	},
};

export { migration0001Initial };
