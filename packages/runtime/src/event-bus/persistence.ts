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

interface FileGroup {
	path: string;
	filename: string;
	counter: number;
}

interface RecoveryBatch {
	events: RuntimeEvent[];
	pending: boolean;
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
	const pendingIndex = new Map<string, FileGroup>();

	return {
		async handle(event: RuntimeEvent): Promise<void> {
			counter++;
			const filename = formatFilename(counter, event.id);
			const isTerminal = event.state === "done";

			// Terminal states go directly to archive/; others go to pending/
			const prefix = isTerminal ? "events/archive/" : "events/pending/";
			await backend.write(
				`${prefix}${filename}`,
				JSON.stringify(event, null, 2),
			);

			// Archive older pending file for this event (fire-and-forget)
			const oldFile = pendingIndex.get(event.id);
			if (oldFile) {
				backend
					.move(oldFile.path, `events/archive/${oldFile.filename}`)
					.catch((err) => {
						logger?.error("archive-failed", {
							eventId: event.id,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}

			// Update index
			if (isTerminal) {
				pendingIndex.delete(event.id);
			} else {
				pendingIndex.set(event.id, {
					path: `${prefix}${filename}`,
					filename,
					counter,
				});
			}
		},

		async bootstrap(
			_events: RuntimeEvent[],
			_options?: { pending?: boolean },
		): Promise<void> {
			// No-op: persistence is the bootstrap source, not a consumer of bootstrap data
		},

		async *recover(): AsyncIterable<RecoveryBatch> {
			await backend.init();
			await cleanupPending();

			yield* batch(readAll(pendingIndex.values()), true);
			yield* batch(readAll(parseEventPaths("events/archive/")), false);
		},
	};

	async function cleanupPending(): Promise<void> {
		for await (const path of backend.list("events/pending/")) {
			const filename = extractFilename(path);
			const parsed = parseFilename(filename);
			if (!parsed) {
				continue;
			}

			const existing = pendingIndex.get(parsed.eventId);
			if (existing) {
				// Files are sorted by counter (ascending), so existing has lower counter — archive it
				await backend.move(
					existing.path,
					`events/archive/${existing.filename}`,
				);
			}
			pendingIndex.set(parsed.eventId, {
				path,
				filename,
				counter: parsed.counter,
			});
		}
	}

	async function* parseEventPaths(
		prefix: string,
	): AsyncGenerator<{ path: string; counter: number }> {
		for await (const path of backend.list(prefix)) {
			const parsed = parseFilename(extractFilename(path));
			if (parsed) {
				yield { path, counter: parsed.counter };
			}
		}
	}

	async function readAndParse(path: string): Promise<RuntimeEvent> {
		const content = await backend.read(path);
		return RuntimeEventSchema.parse(JSON.parse(content, stripNulls));
	}

	async function* readAll(
		source:
			| AsyncIterable<{ path: string; counter: number }>
			| Iterable<{ path: string; counter: number }>,
	): AsyncGenerator<RuntimeEvent> {
		const iter = toAsyncIterator(source);
		const queue: Promise<RuntimeEvent>[] = [];
		let done = false;

		async function pull(): Promise<void> {
			const result = await iter.next();
			if (result.done) {
				done = true;
				return;
			}
			if (result.value.counter > counter) {
				counter = result.value.counter;
			}
			queue.push(readAndParse(result.value.path));
		}

		// Fill initial buffer — starts `concurrency` reads immediately
		while (!done && queue.length < concurrency) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential fill of initial read buffer
			await pull();
		}

		// Drain: yield one, refill one — keeps reads in flight
		while (queue.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
			// biome-ignore lint/performance/noAwaitInLoops: sequential drain of prefetched read queue
			yield await queue.shift()!;
			if (!done) {
				await pull();
			}
		}
	}

	async function* batch(
		source: AsyncIterable<RuntimeEvent>,
		pending: boolean,
	): AsyncGenerator<RecoveryBatch> {
		let events: RuntimeEvent[] = [];
		for await (const event of source) {
			events.push(event);
			if (events.length >= concurrency) {
				yield { events, pending };
				events = [];
			}
		}
		if (events.length > 0) {
			yield { events, pending };
		}
	}
}

function toAsyncIterator<T>(
	source: AsyncIterable<T> | Iterable<T>,
): AsyncIterator<T> {
	if (Symbol.asyncIterator in (source as object)) {
		return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
	}
	const iter = (source as Iterable<T>)[Symbol.iterator]();
	return { next: async () => iter.next() };
}

export { createPersistence };
export type { PersistenceConsumer, RecoveryBatch };
