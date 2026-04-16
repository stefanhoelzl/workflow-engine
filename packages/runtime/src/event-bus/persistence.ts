import type { HttpTriggerResult } from "@workflow-engine/core";
import type { StorageBackend } from "../storage/index.js";
import type {
	BusConsumer,
	InvocationLifecycleEvent,
	SerializedErrorPayload,
} from "./index.js";

// ---------------------------------------------------------------------------
// Invocation records (on-disk shape)
// ---------------------------------------------------------------------------
//
// Pending: written at `started` time, removed when the invocation terminates.
// Archive: written exactly once at `completed` or `failed` time.
//
// The record is the wire shape for scanArchive/scanPending consumers
// (recovery, event-store bootstrap). It's intentionally looser than the
// lifecycle event union — any future fields added here will surface to
// consumers without bus involvement.

interface PendingRecord {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly input: unknown;
	readonly startedAt: string;
	readonly status: "pending";
}

interface SucceededRecord {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly input: unknown;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly status: "succeeded";
	readonly result: HttpTriggerResult;
}

interface FailedRecord {
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly input: unknown;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly status: "failed";
	readonly error: SerializedErrorPayload;
}

type InvocationRecord = PendingRecord | SucceededRecord | FailedRecord;
type ArchiveRecord = SucceededRecord | FailedRecord;

const PENDING_PREFIX = "pending/";
const ARCHIVE_PREFIX = "archive/";

function pendingPath(id: string): string {
	return `${PENDING_PREFIX}${id}.json`;
}

function archivePath(id: string): string {
	return `${ARCHIVE_PREFIX}${id}.json`;
}

interface StartSnapshot {
	readonly input: unknown;
	readonly startedAt: string;
}

interface PersistenceOptions {
	readonly logger?: {
		error(msg: string, data: Record<string, unknown>): void;
	};
}

// Remember start-time data between `started` and terminal events so the
// archive record can include them without requiring the terminal event to
// carry the full history. If the process dies between `started` and
// terminal, the pending/ file still contains the start fields for recovery.
interface PersistenceDeps {
	readonly backend: StorageBackend;
	readonly starts: Map<string, StartSnapshot>;
	readonly logger?: PersistenceOptions["logger"];
}

interface PersistenceConsumer extends BusConsumer {
	// Marker type — nothing extra in v1; kept as a named alias so callers
	// (recovery, main bootstrap) can express "I want the consumer" clearly.
}

async function handleStarted(
	deps: PersistenceDeps,
	event: Extract<InvocationLifecycleEvent, { kind: "started" }>,
): Promise<void> {
	const record: PendingRecord = {
		id: event.id,
		workflow: event.workflow,
		trigger: event.trigger,
		input: event.input,
		startedAt: event.ts.toISOString(),
		status: "pending",
	};
	deps.starts.set(event.id, {
		input: event.input,
		startedAt: record.startedAt,
	});
	await deps.backend.write(
		pendingPath(event.id),
		JSON.stringify(record, null, 2),
	);
}

async function handleCompleted(
	deps: PersistenceDeps,
	event: Extract<InvocationLifecycleEvent, { kind: "completed" }>,
): Promise<void> {
	const snapshot =
		deps.starts.get(event.id) ?? (await readPendingSnapshot(deps, event));
	const record: SucceededRecord = {
		id: event.id,
		workflow: event.workflow,
		trigger: event.trigger,
		input: snapshot.input,
		startedAt: snapshot.startedAt,
		completedAt: event.ts.toISOString(),
		status: "succeeded",
		result: event.result,
	};
	await deps.backend.write(
		archivePath(event.id),
		JSON.stringify(record, null, 2),
	);
	await removePending(deps, event.id);
	deps.starts.delete(event.id);
}

async function handleFailed(
	deps: PersistenceDeps,
	event: Extract<InvocationLifecycleEvent, { kind: "failed" }>,
): Promise<void> {
	const snapshot =
		deps.starts.get(event.id) ?? (await readPendingSnapshot(deps, event));
	const record: FailedRecord = {
		id: event.id,
		workflow: event.workflow,
		trigger: event.trigger,
		input: snapshot.input,
		startedAt: snapshot.startedAt,
		completedAt: event.ts.toISOString(),
		status: "failed",
		error: event.error,
	};
	await deps.backend.write(
		archivePath(event.id),
		JSON.stringify(record, null, 2),
	);
	await removePending(deps, event.id);
	deps.starts.delete(event.id);
}

async function readPendingSnapshot(
	deps: PersistenceDeps,
	event: InvocationLifecycleEvent,
): Promise<StartSnapshot> {
	// Terminal event arrived without a prior `started` in this process —
	// typically the recovery path, where the pending file already exists
	// from a prior session. Read from disk; fall back to a conservative
	// default if the file is gone.
	try {
		const raw = await deps.backend.read(pendingPath(event.id));
		const parsed = JSON.parse(raw) as PendingRecord;
		return {
			input: parsed.input,
			startedAt: parsed.startedAt,
		};
	} catch (err) {
		deps.logger?.error("persistence.read-pending-failed", {
			id: event.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return { input: null, startedAt: event.ts.toISOString() };
	}
}

async function removePending(deps: PersistenceDeps, id: string): Promise<void> {
	try {
		await deps.backend.remove(pendingPath(id));
	} catch (err) {
		// A missing pending file is expected on recovery (the file may have
		// been the source we just promoted to archive, or may already have
		// been swept). Log everything else at error-level.
		deps.logger?.error("persistence.remove-pending-failed", {
			id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function createPersistence(
	backend: StorageBackend,
	options?: PersistenceOptions,
): PersistenceConsumer {
	const deps: PersistenceDeps = {
		backend,
		starts: new Map(),
		...(options?.logger ? { logger: options.logger } : {}),
	};
	return {
		async handle(event: InvocationLifecycleEvent): Promise<void> {
			if (event.kind === "started") {
				await handleStarted(deps, event);
				return;
			}
			if (event.kind === "completed") {
				await handleCompleted(deps, event);
				return;
			}
			await handleFailed(deps, event);
		},
	};
}

const ID_FROM_PATH = /(?:^|\/)([^/]+)\.json$/;

function idFromPath(path: string): string | undefined {
	const match = ID_FROM_PATH.exec(path);
	return match?.[1];
}

async function* scanPrefix(
	backend: StorageBackend,
	prefix: string,
): AsyncGenerator<InvocationRecord> {
	for await (const path of backend.list(prefix)) {
		const id = idFromPath(path);
		if (!id) {
			continue;
		}
		let raw: string;
		try {
			raw = await backend.read(path);
		} catch {
			continue;
		}
		try {
			yield JSON.parse(raw) as InvocationRecord;
		} catch {
			// Skip malformed records; callers receive a partial view rather
			// than crashing on corruption. Recovery writes a failed archive
			// entry for any pending id it sees, so a corrupt file still gets
			// archived via its filename-derived id.
		}
	}
}

function scanPending(
	backend: StorageBackend,
): AsyncGenerator<InvocationRecord> {
	return scanPrefix(backend, PENDING_PREFIX);
}

function scanArchive(
	backend: StorageBackend,
): AsyncGenerator<InvocationRecord> {
	return scanPrefix(backend, ARCHIVE_PREFIX);
}

export type {
	ArchiveRecord,
	FailedRecord,
	InvocationRecord,
	PendingRecord,
	PersistenceConsumer,
	PersistenceOptions,
	SucceededRecord,
};
export {
	ARCHIVE_PREFIX,
	archivePath,
	createPersistence,
	idFromPath,
	PENDING_PREFIX,
	pendingPath,
	scanArchive,
	scanPending,
};
