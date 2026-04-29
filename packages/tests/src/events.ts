import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventFilter, InvocationEvent } from "./types.js";

// FS polling source-of-truth for invocation events emitted by the spawned
// child runtime. Mirrors the on-disk layout produced by
// `packages/runtime/src/event-bus/persistence.ts`:
//
//   <persistencePath>/pending/<id>/<seq>.json   — one per event, in-flight
//   <persistencePath>/archive/<id>.json         — JSON array of events, terminal
//
// We intentionally do not import the runtime helpers here: the framework
// observes the same on-disk contract as a third-party would, which keeps
// the e2e layer decoupled from runtime internals.

const PENDING_DIR = "pending";
const ARCHIVE_DIR = "archive";

async function readPendingEvents(
	persistencePath: string,
): Promise<InvocationEvent[]> {
	const root = join(persistencePath, PENDING_DIR);
	let invocationDirs: string[];
	try {
		invocationDirs = await readdir(root);
	} catch {
		return [];
	}
	const events: InvocationEvent[] = [];
	for (const id of invocationDirs) {
		const idDir = join(root, id);
		let seqFiles: string[];
		try {
			seqFiles = await readdir(idDir);
		} catch {
			continue;
		}
		for (const file of seqFiles) {
			if (!file.endsWith(".json")) {
				continue;
			}
			const path = join(idDir, file);
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch {
				continue;
			}
			try {
				events.push(JSON.parse(raw) as InvocationEvent);
			} catch {
				// Partial write or malformed; skip — the next poll picks up
				// the completed file.
			}
		}
	}
	return events;
}

async function readArchivedEvents(
	persistencePath: string,
): Promise<InvocationEvent[]> {
	const root = join(persistencePath, ARCHIVE_DIR);
	let archiveFiles: string[];
	try {
		archiveFiles = await readdir(root);
	} catch {
		return [];
	}
	const events: InvocationEvent[] = [];
	for (const file of archiveFiles) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const path = join(root, file);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) {
			continue;
		}
		for (const event of parsed) {
			events.push(event as InvocationEvent);
		}
	}
	return events;
}

interface ScanOptions {
	archived?: boolean;
}

async function scanEvents(
	persistencePath: string,
	opts: ScanOptions = {},
): Promise<InvocationEvent[]> {
	if (opts.archived === true) {
		return readArchivedEvents(persistencePath);
	}
	if (opts.archived === false) {
		return readPendingEvents(persistencePath);
	}
	const [pending, archived] = await Promise.all([
		readPendingEvents(persistencePath),
		readArchivedEvents(persistencePath),
	]);
	// Persistence's archive flow is `writePending → writeArchive →
	// removePrefix(pending)`. During the window between writeArchive and
	// removePrefix completing, the same `(id, seq)` event lives in both
	// directories. Dedup by `(id, seq)` so the test layer sees an event
	// exactly once. Archive wins because it's the post-terminal authoritative
	// view; pending is transient.
	const byKey = new Map<string, InvocationEvent>();
	for (const event of pending) {
		byKey.set(`${event.id}:${String(event.seq)}`, event);
	}
	for (const event of archived) {
		byKey.set(`${event.id}:${String(event.seq)}`, event);
	}
	return [...byKey.values()];
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
	// `filter.label` is part of the frozen surface for PR 6+; PR 3 has no
	// label-bearing chain steps yet, so treat any caller-supplied label as a
	// no-op. PR 6 adds the label index that this branch will read.
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
