import type { InvocationEvent } from "@workflow-engine/core";
import type { StorageBackend } from "../storage/index.js";
import type { BusConsumer } from "./index.js";

// ---------------------------------------------------------------------------
// Persistence — one file per event
// ---------------------------------------------------------------------------
//
// During an invocation, every event is written to `pending/{id}_{seq}.json`.
// On terminal events (`trigger.response` / `trigger.error`), all files for
// that invocation id are moved to `archive/{id}/{seq}.json`.

const PENDING_PREFIX = "pending/";
const ARCHIVE_PREFIX = "archive/";

function pendingPath(id: string, seq: number): string {
	return `${PENDING_PREFIX}${id}_${seq}.json`;
}

function archivePath(id: string, seq: number): string {
	return `${ARCHIVE_PREFIX}${id}/${seq}.json`;
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
	// Tracks which seqs we've written for each in-flight invocation id, so the
	// terminal handler knows which files to move to archive.
	readonly pendingSeqs: Map<string, number[]>;
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
	let seqs = deps.pendingSeqs.get(event.id);
	if (!seqs) {
		seqs = [];
		deps.pendingSeqs.set(event.id, seqs);
	}
	seqs.push(event.seq);
}

async function archiveInvocation(
	deps: PersistenceDeps,
	id: string,
): Promise<void> {
	const seqs =
		deps.pendingSeqs.get(id) ?? (await discoverPendingSeqs(deps, id));
	for (const seq of seqs) {
		const fromPath = pendingPath(id, seq);
		const toPath = archivePath(id, seq);
		try {
			// biome-ignore lint/performance/noAwaitInLoops: per-file copy must complete before remove to keep files reachable on backend types without rename
			const content = await deps.backend.read(fromPath);
			await deps.backend.write(toPath, content);
			await deps.backend.remove(fromPath);
		} catch (err) {
			deps.logger?.error("persistence.archive-failed", {
				id,
				seq,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	deps.pendingSeqs.delete(id);
}

async function discoverPendingSeqs(
	deps: PersistenceDeps,
	id: string,
): Promise<number[]> {
	const seqs: number[] = [];
	for await (const path of deps.backend.list(PENDING_PREFIX)) {
		const parsed = parsePendingPath(path);
		if (parsed && parsed.id === id) {
			seqs.push(parsed.seq);
		}
	}
	seqs.sort((a, b) => a - b);
	return seqs;
}

const PENDING_PATH_RE = /(?:^|\/)([^/]+)_(\d+)\.json$/;

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

const ARCHIVE_PATH_RE = /(?:^|\/)archive\/([^/]+)\/(\d+)\.json$/;

function parseArchivePath(
	path: string,
): { id: string; seq: number } | undefined {
	const match = ARCHIVE_PATH_RE.exec(path);
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

function createPersistence(
	backend: StorageBackend,
	options?: PersistenceOptions,
): PersistenceConsumer {
	const deps: PersistenceDeps = {
		backend,
		pendingSeqs: new Map(),
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

async function* scanPath(
	backend: StorageBackend,
	prefix: string,
	parser: (path: string) => { id: string; seq: number } | undefined,
): AsyncGenerator<InvocationEvent> {
	for await (const path of backend.list(prefix)) {
		if (!parser(path)) {
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

function scanPending(backend: StorageBackend): AsyncGenerator<InvocationEvent> {
	return scanPath(backend, PENDING_PREFIX, parsePendingPath);
}

function scanArchive(backend: StorageBackend): AsyncGenerator<InvocationEvent> {
	return scanPath(backend, ARCHIVE_PREFIX, parseArchivePath);
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
	scanArchive,
	scanPending,
};
