import pLimit from "p-limit";
import type { BusConsumer, RuntimeEvent } from "./index.js";
import { RuntimeEventSchema } from "./index.js";
import type { StorageBackend } from "../storage/index.js";

const FILE_PATTERN = /^(\d+)_evt_(.+)\.json$/;
const EVT_PREFIX_PATTERN = /^evt_/;
const COUNTER_PAD_LENGTH = 6;

function stripNulls(_key: string, value: unknown): unknown {
	return value === null ? undefined : value;
}

function parseFilename(
	filename: string,
): { counter: number; eventId: string } | undefined {
	const match = FILE_PATTERN.exec(filename);
	if (!match) {
		return;
	}
	return { counter: Number(match[1]), eventId: `evt_${match[2]}` };
}

function formatFilename(counter: number, eventId: string): string {
	const id = eventId.replace(EVT_PREFIX_PATTERN, "");
	return `${String(counter).padStart(COUNTER_PAD_LENGTH, "0")}_evt_${id}.json`;
}

function extractFilename(path: string): string {
	const slashIndex = path.lastIndexOf("/");
	return slashIndex === -1 ? path : path.slice(slashIndex + 1);
}

async function collectList(backend: StorageBackend, prefix: string): Promise<string[]> {
	const results: string[] = [];
	for await (const path of backend.list(prefix)) {
		results.push(path);
	}
	return results;
}

async function listEventFiles(backend: StorageBackend, prefix: string): Promise<string[]> {
	const entries = await collectList(backend, prefix);
	return entries.filter((f) => FILE_PATTERN.test(extractFilename(f))).sort();
}

interface FileGroup {
	path: string;
	filename: string;
	counter: number;
}

async function archiveFiles(
	backend: StorageBackend,
	files: FileGroup[],
): Promise<void> {
	files.sort((a, b) => a.counter - b.counter);
	for (const f of files) {
		// biome-ignore lint/performance/noAwaitInLoops: sequential moves for crash safety
		await backend.move(f.path, `archive/${f.filename}`);
	}
}

interface RecoveryBatch {
	events: RuntimeEvent[];
	pending: boolean;
	finished: boolean;
}

interface PersistenceConsumer extends BusConsumer {
	recover(): AsyncIterable<RecoveryBatch>;
}

interface PersistenceOptions {
	concurrency?: number;
	logger?: { error(msg: string, data: Record<string, unknown>): void };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled persistence logic
function createPersistence(
	backend: StorageBackend,
	options?: PersistenceOptions,
): PersistenceConsumer {
	const logger = options?.logger;
	const concurrency = options?.concurrency ?? 10;
	// NOTE: This counter is single-threaded. If parallel scheduling is introduced,
	// this must be replaced with an atomic counter or file-based lock.
	let counter = 0;

	return {
		async handle(event: RuntimeEvent): Promise<void> {
			counter++;
			const filename = formatFilename(counter, event.id);
			const isTerminal = event.state === "done";

			// Terminal states go directly to archive/; others go to pending/
			const prefix = isTerminal ? "archive/" : "pending/";
			await backend.write(
				`${prefix}${filename}`,
				JSON.stringify(event, null, 2),
			);

			// Archive older files for this event from pending/ (fire-and-forget)
			archiveOlderFiles(event.id, filename).catch((err) => {
				logger?.error("archive-failed", {
					eventId: event.id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		},

		async bootstrap(
			_events: RuntimeEvent[],
			_options?: { finished?: boolean },
		): Promise<void> {
			// No-op: persistence is the bootstrap source, not a consumer of bootstrap data
		},

		async *recover(): AsyncIterable<RecoveryBatch> {
			await backend.init();

			// Step 1: Internal cleanup — ensure at most 1 file per eventId in pending/
			await cleanupPending();

			// Step 2: Recover counter from max across both directories
			const pendingFiles = await listEventFiles(backend, "pending/");
			const archivedFiles = await listEventFiles(backend, "archive/");
			let maxCounter = 0;
			for (const f of [...pendingFiles, ...archivedFiles]) {
				const parsed = parseFilename(extractFilename(f));
				if (parsed && parsed.counter > maxCounter) {
					maxCounter = parsed.counter;
				}
			}
			counter = maxCounter;

			// Step 3: Yield pending events
			const limit = pLimit(concurrency);
			if (pendingFiles.length > 0) {
				const events = await readEvents(pendingFiles, limit);
				yield { events, pending: true, finished: archivedFiles.length === 0 };
			}

			// Step 4: Yield archive events
			if (archivedFiles.length > 0) {
				const events = await readEvents(archivedFiles, limit);
				yield { events, pending: false, finished: true };
			}

			// If nothing was yielded, signal finished with empty batch
			if (pendingFiles.length === 0 && archivedFiles.length === 0) {
				yield { events: [], pending: true, finished: true };
			}
		},
	};

	async function cleanupPending(): Promise<void> {
		const files = await listEventFiles(backend, "pending/");
		const byEvent = new Map<string, FileGroup[]>();
		for (const path of files) {
			const filename = extractFilename(path);
			const parsed = parseFilename(filename);
			if (!parsed) {
				continue;
			}
			const group = byEvent.get(parsed.eventId) ?? [];
			group.push({ path, filename, counter: parsed.counter });
			byEvent.set(parsed.eventId, group);
		}
		for (const group of byEvent.values()) {
			if (group.length <= 1) {
				continue;
			}
			group.sort((a, b) => a.counter - b.counter);
			const older = group.slice(0, -1);
			// biome-ignore lint/performance/noAwaitInLoops: sequential archive for crash safety
			await archiveFiles(backend, older);
		}
	}

	async function readEvents(
		files: string[],
		limit: ReturnType<typeof pLimit>,
	): Promise<RuntimeEvent[]> {
		const events: RuntimeEvent[] = [];
		await Promise.all(
			files.map((path) =>
				limit(async () => {
					const content = await backend.read(path);
					events.push(RuntimeEventSchema.parse(JSON.parse(content, stripNulls)));
				}),
			),
		);
		return events;
	}

	async function archiveOlderFiles(eventId: string, currentFilename: string): Promise<void> {
		const allFiles = await listEventFiles(backend, "pending/");
		const olderFiles: FileGroup[] = [];
		for (const path of allFiles) {
			const filename = extractFilename(path);
			if (filename === currentFilename) {
				continue;
			}
			const parsed = parseFilename(filename);
			if (parsed?.eventId === eventId) {
				olderFiles.push({ path, filename, counter: parsed.counter });
			}
		}
		if (olderFiles.length > 0) {
			await archiveFiles(backend, olderFiles);
		}
	}
}

export { createPersistence };
export type { PersistenceConsumer, RecoveryBatch };
