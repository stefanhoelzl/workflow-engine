import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { EventFilter, InvocationEvent } from "./types.js";

// Source-of-truth for events emitted by the spawned child runtime.
//
// The runtime persists invocation events through plain DuckDB at
// `<persistencePath>/events.duckdb` (see `packages/runtime/src/event-store.ts`).
// DuckDB takes an exclusive file lock on the database while the runtime is
// alive, so the framework cannot open the live file (read-only mode is also
// blocked once a writer holds the lock).
//
// To observe committed events without contending for the lock, each poll
// snapshots the DB file and its WAL to a fresh tmpdir, then opens the copy
// with default mode (no other process holds a lock on the copy). DuckDB's
// open replays the WAL into the copy automatically, so the snapshot reflects
// every committed terminal up to the moment of cp. In-flight events live
// only in the runtime's in-memory accumulator and are NOT visible here;
// `archived: false` therefore returns no rows.

async function snapshotEventsDb(
	persistencePath: string,
): Promise<{ dbPath: string; cleanup: () => Promise<void> } | null> {
	const livePath = join(persistencePath, "events.duckdb");
	try {
		await stat(livePath);
	} catch {
		return null;
	}
	const dir = await mkdtemp(join(tmpdir(), "wfe-events-snap-"));
	const dbPath = join(dir, "events.duckdb");
	const walPath = join(dir, "events.duckdb.wal");
	await copyFile(livePath, dbPath);
	try {
		await copyFile(`${livePath}.wal`, walPath);
	} catch {
		// WAL absent is fine — main file is the full state.
	}
	return {
		dbPath,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function readArchivedEvents(
	persistencePath: string,
): Promise<InvocationEvent[]> {
	const snap = await snapshotEventsDb(persistencePath);
	if (!snap) {
		return [];
	}
	try {
		const instance = await DuckDBInstance.create(snap.dbPath);
		const conn = await instance.connect();
		try {
			const reader = await conn.runAndReadAll(
				"SELECT * FROM events ORDER BY id, seq",
			);
			return reader.getRowObjects() as unknown as InvocationEvent[];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Schema may not exist yet on a freshly-spawned runtime that has
			// not initialised EventStore. Treat as no events.
			if (msg.includes("does not exist") || msg.includes("Catalog Error")) {
				return [];
			}
			throw err;
		} finally {
			conn.disconnectSync();
			instance.closeSync();
		}
	} finally {
		await snap.cleanup();
	}
}

interface ScanOptions {
	archived?: boolean;
}

function scanEvents(
	persistencePath: string,
	opts: ScanOptions = {},
): Promise<InvocationEvent[]> {
	if (opts.archived === false) {
		// Pre-DuckLake the framework polled `pending/{id}/{seq}.json` files for
		// in-flight events. Under the new architecture those events live only in
		// the runtime's in-memory accumulator and are not externally observable.
		// Tests that previously synced on `archived: false` must use an
		// alternative signal (logs, HTTP response, manualTrigger return value).
		return Promise.resolve([]);
	}
	return readArchivedEvents(persistencePath);
}

const TRIGGER_KINDS = new Set<string>([
	"trigger.request",
	"trigger.response",
	"trigger.error",
]);

interface InternalFilter extends EventFilter {
	id?: string;
}

function matchesFilter(
	event: InvocationEvent,
	filter: InternalFilter,
): boolean {
	if (filter.kind !== undefined && event.kind !== filter.kind) {
		return false;
	}
	if (filter.owner !== undefined && event.owner !== filter.owner) {
		return false;
	}
	if (filter.repo !== undefined && event.repo !== filter.repo) {
		return false;
	}
	if (filter.id !== undefined && event.id !== filter.id) {
		return false;
	}
	if (filter.trigger !== undefined) {
		// Trigger events stamp the trigger's name into `event.name`. Restrict
		// the filter to trigger.* kinds so an action with the same name
		// doesn't accidentally match.
		if (!TRIGGER_KINDS.has(event.kind)) {
			return false;
		}
		if (event.name !== filter.trigger) {
			return false;
		}
	}
	// `filter.label` is part of the frozen surface; the label index lives in
	// the scenario state, not the event.
	return true;
}

const POLL_INTERVAL_MS = 25;
const DEFAULT_HARDCAP_MS = 5000;

interface WaitOptions {
	hardCap?: number;
}

async function waitForEvent(
	persistencePath: string,
	filter: InternalFilter,
	opts: WaitOptions = {},
): Promise<InvocationEvent> {
	const hardCap = opts.hardCap ?? DEFAULT_HARDCAP_MS;
	const deadline = Date.now() + hardCap;
	let latestEvents: InvocationEvent[] = [];
	while (true) {
		latestEvents = await scanEvents(persistencePath, archivedScope(filter));
		const found = latestEvents.find((e) => matchesFilter(e, filter));
		if (found) {
			return found;
		}
		if (Date.now() >= deadline) {
			break;
		}
		await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
	}
	const summary = latestEvents
		.slice(0, 20)
		.map((e) => `  - ${e.kind} name=${e.name} id=${e.id}`)
		.join("\n");
	throw new Error(
		`waitForEvent timed out after ${String(hardCap)}ms\nfilter: ${JSON.stringify(
			filter,
		)}\nobserved events (${String(latestEvents.length)}):\n${summary}`,
	);
}

function archivedScope(filter: InternalFilter): ScanOptions {
	if (filter.archived === undefined) {
		return {};
	}
	return { archived: filter.archived };
}

export type { InternalFilter, ScanOptions };
export { matchesFilter, scanEvents, waitForEvent };
