import type { InvocationEvent } from "@workflow-engine/core";
import type { StorageBackend } from "../storage/index.js";
import type { BusConsumer } from "./index.js";

// ---------------------------------------------------------------------------
// Persistence — per-event pending, single-file archive
// ---------------------------------------------------------------------------
//
// During an invocation, every event is written to `pending/{id}/{seq}.json`
// (seq zero-padded to 6 digits) and accumulated in memory keyed by id.
// On terminal events (`trigger.response` / `trigger.error`), the full
// accumulated event list is written as a JSON array to `archive/{id}.json`;
// the in-memory entry is cleared; then the pending prefix is removed.

const PENDING_PREFIX = "pending/";
const ARCHIVE_PREFIX = "archive/";
const SEQ_PAD = 6;

function pendingPath(id: string, seq: number): string {
	return `${PENDING_PREFIX}${id}/${seq.toString().padStart(SEQ_PAD, "0")}.json`;
}

function pendingPrefix(id: string): string {
	return `${PENDING_PREFIX}${id}/`;
}

function archivePath(id: string): string {
	return `${ARCHIVE_PREFIX}${id}.json`;
}

interface PersistenceOptions {
	readonly logger?: {
		error(msg: string, data: Record<string, unknown>): void;
	};
}

interface PersistenceConsumer extends BusConsumer {
	// Marker type — nothing extra in v1; kept as a named alias so callers
	// (recovery, main bootstrap) can express "I want the consumer" clearly.
}

interface PersistenceDeps {
	readonly backend: StorageBackend;
	// Holds events already persisted to `pending/` for each in-flight invocation
	// id, in arrival (= seq) order. On terminal we serialize this list as the
	// archive file, so we don't re-read N pending files.
	readonly pendingEvents: Map<string, InvocationEvent[]>;
	readonly logger?: PersistenceOptions["logger"];
}

function isTerminal(kind: string): boolean {
	return kind === "trigger.response" || kind === "trigger.error";
}

async function writePending(
	deps: PersistenceDeps,
	event: InvocationEvent,
): Promise<void> {
	const path = pendingPath(event.id, event.seq);
	await deps.backend.write(path, JSON.stringify(event, null, 2));
	let events = deps.pendingEvents.get(event.id);
	if (!events) {
		events = [];
		deps.pendingEvents.set(event.id, events);
	}
	events.push(event);
}

async function archiveInvocation(
	deps: PersistenceDeps,
	id: string,
): Promise<void> {
	const events = deps.pendingEvents.get(id) ?? [];
	try {
		await deps.backend.write(archivePath(id), JSON.stringify(events, null, 2));
	} catch (err) {
		deps.logger?.error("persistence.archive-failed", {
			id,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	deps.pendingEvents.delete(id);
	try {
		await deps.backend.removePrefix(pendingPrefix(id));
	} catch (err) {
		deps.logger?.error("persistence.remove-prefix-failed", {
			id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const PENDING_PATH_RE = /(?:^|\/)pending\/([^/]+)\/(\d+)\.json$/;

function parsePendingPath(
	path: string,
): { id: string; seq: number } | undefined {
	const match = PENDING_PATH_RE.exec(path);
	if (!match) {
		return;
	}
	const id = match[1];
	const seqRaw = match[2];
	if (id === undefined || seqRaw === undefined) {
		return;
	}
	const seq = Number(seqRaw);
	if (!Number.isFinite(seq)) {
		return;
	}
	return { id, seq };
}

const ARCHIVE_PATH_RE = /(?:^|\/)archive\/([^/]+)\.json$/;

function parseArchivePath(path: string): { id: string } | undefined {
	const match = ARCHIVE_PATH_RE.exec(path);
	if (!match) {
		return;
	}
	const id = match[1];
	if (id === undefined) {
		return;
	}
	return { id };
}

function createPersistence(
	backend: StorageBackend,
	options?: PersistenceOptions,
): PersistenceConsumer {
	const deps: PersistenceDeps = {
		backend,
		pendingEvents: new Map(),
		...(options?.logger ? { logger: options.logger } : {}),
	};
	return {
		async handle(event: InvocationEvent): Promise<void> {
			await writePending(deps, event);
			if (isTerminal(event.kind)) {
				await archiveInvocation(deps, event.id);
			}
		},
	};
}

async function* scanPending(
	backend: StorageBackend,
): AsyncGenerator<InvocationEvent> {
	for await (const path of backend.list(PENDING_PREFIX)) {
		if (!parsePendingPath(path)) {
			continue;
		}
		let raw: string;
		try {
			raw = await backend.read(path);
		} catch {
			continue;
		}
		try {
			yield JSON.parse(raw) as InvocationEvent;
		} catch {
			// Skip malformed records; callers receive a partial view rather
			// than crashing on corruption.
		}
	}
}

async function* scanArchive(
	backend: StorageBackend,
): AsyncGenerator<InvocationEvent> {
	for await (const path of backend.list(ARCHIVE_PREFIX)) {
		if (!parseArchivePath(path)) {
			continue;
		}
		let raw: string;
		try {
			raw = await backend.read(path);
		} catch {
			continue;
		}
		let events: unknown;
		try {
			events = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!Array.isArray(events)) {
			continue;
		}
		for (const event of events) {
			yield event as InvocationEvent;
		}
	}
}

export type { PersistenceConsumer, PersistenceOptions };
export {
	ARCHIVE_PREFIX,
	archivePath,
	createPersistence,
	PENDING_PREFIX,
	parseArchivePath,
	parsePendingPath,
	pendingPath,
	pendingPrefix,
	scanArchive,
	scanPending,
};
