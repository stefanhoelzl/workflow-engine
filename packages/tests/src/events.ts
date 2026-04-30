import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { EventFilter, InvocationEvent } from "./types.js";

// Source-of-truth for events emitted by the spawned child runtime.
//
// The runtime persists invocation events through DuckLake (see
// `packages/runtime/src/event-store.ts`):
//
//   <persistencePath>/events.duckdb           — DuckLake catalog (DuckDB file)
//   <persistencePath>/events/main/events/...  — Parquet data files
//
// DuckDB takes an exclusive file lock on the catalog while the runtime is
// alive, so the framework cannot ATTACH the live catalog. Instead the
// framework reads the immutable Parquet data files via `read_parquet(...)`
// — no attach, no lock — and relies on the runtime spawning with
// `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS=1` so every commit flushes its
// inlined rows to disk-resident Parquet immediately.
//
// In-flight events live only in the runtime's in-memory accumulator and
// are NOT visible to this reader; only terminal-committed invocations
// appear here. The `archived: false` filter therefore returns no rows.

const EVENTS_GLOB_SUFFIX = "events/main/events/**/*.parquet";

interface ParquetReader {
	close(): void;
	readEvents(): Promise<InvocationEvent[]>;
}

async function openParquetReader(
	persistencePath: string,
): Promise<ParquetReader | null> {
	// At least one Parquet file must exist before read_parquet can resolve
	// the glob. Stat the events root and bail early if it has not been
	// created yet (early in the runtime's life, or the test has not fired
	// any invocation yet).
	const eventsRoot = join(persistencePath, "events");
	try {
		await stat(eventsRoot);
	} catch {
		return null;
	}
	const instance = await DuckDBInstance.create();
	const conn = await instance.connect();
	const glob = join(persistencePath, EVENTS_GLOB_SUFFIX);
	return {
		close() {
			conn.disconnectSync();
		},
		async readEvents(): Promise<InvocationEvent[]> {
			// DuckLake CHECKPOINTs append new Parquet files without removing
			// the previously-written ones (snapshot retention). The same
			// logical (id, seq) row can therefore appear in multiple files;
			// DISTINCT ON dedupes to the latest copy per primary-key tuple.
			//
			// The glob can occasionally hit a Parquet file that is still
			// being written by the runtime (the write is not atomic from
			// an external observer's POV). Retry a few times on
			// "too small to be a Parquet file"; the next poll iteration
			// gets a complete file.
			const sql = `SELECT DISTINCT ON (id, seq) * FROM read_parquet('${glob}', union_by_name = true) ORDER BY id, seq`;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const reader = await conn.runAndReadAll(sql);
					return reader.getRowObjects() as unknown as InvocationEvent[];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.includes("No files found that match the pattern")) {
						return [];
					}
					if (attempt < 2 && msg.includes("too small to be a Parquet file")) {
						await new Promise((r) => setTimeout(r, 50));
						continue;
					}
					throw err;
				}
			}
			return [];
		},
	};
}

async function readArchivedEvents(
	persistencePath: string,
): Promise<InvocationEvent[]> {
	const reader = await openParquetReader(persistencePath);
	if (!reader) {
		return [];
	}
	try {
		return await reader.readEvents();
	} finally {
		reader.close();
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
