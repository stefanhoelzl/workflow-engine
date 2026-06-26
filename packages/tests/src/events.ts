import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import type { EventFilter, InvocationEvent } from "./types.js";

// Source-of-truth for events emitted by the spawned child runtime.
//
// The runtime persists invocation events through libSQL at
// `<persistencePath>/events.db` (see `packages/runtime/src/event-store.ts`).
// The runtime opens the database in WAL mode, so this framework can open a
// SECOND read connection on the same file concurrently with the live writer —
// no file copy or snapshot is needed. In-flight events live only in the
// runtime's in-memory accumulator and are NOT visible here; `archived: false`
// therefore returns no rows.

function parseJsonCol(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

// libSQL returns TEXT/INTEGER columns as strings/numbers. Re-hydrate the JSON
// columns and coerce numerics so the row matches the InvocationEvent shape the
// runtime's own read path produces.
function rowToEvent(row: Record<string, unknown>): InvocationEvent {
	return {
		...row,
		seq: Number(row.seq),
		ref: row.ref === null || row.ref === undefined ? null : Number(row.ref),
		ts: row.ts === null || row.ts === undefined ? row.ts : Number(row.ts),
		input: parseJsonCol(row.input),
		output: parseJsonCol(row.output),
		error: parseJsonCol(row.error),
		meta: parseJsonCol(row.meta),
	} as unknown as InvocationEvent;
}

async function readArchivedEvents(
	persistencePath: string,
): Promise<InvocationEvent[]> {
	const livePath = join(persistencePath, "events.db");
	try {
		await stat(livePath);
	} catch {
		return [];
	}
	const client = createClient({ url: `file:${livePath}` });
	try {
		const result = await client.execute(
			"SELECT * FROM events ORDER BY id, seq",
		);
		return (result.rows as unknown as Record<string, unknown>[]).map(
			rowToEvent,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Schema may not exist yet on a freshly-spawned runtime that has not
		// initialised EventStore. Treat as no events.
		if (msg.includes("no such table") || msg.includes("does not exist")) {
			return [];
		}
		throw err;
	} finally {
		client.close();
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
		// In-flight events live only in the runtime's in-memory accumulator and
		// are not externally observable (committed-on-terminal). Tests that
		// previously synced on `archived: false` must use an alternative signal
		// (logs, HTTP response, manualTrigger return value).
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
