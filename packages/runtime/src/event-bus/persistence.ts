import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";
import type { BusConsumer, RuntimeEvent } from "./index.js";
import { RuntimeEventSchema } from "./index.js";

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

async function atomicWrite(filepath: string, content: string): Promise<void> {
	const tmp = `${filepath}.tmp`;
	await writeFile(tmp, content, "utf-8");
	await rename(tmp, filepath);
}

async function listEventFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter((f) => FILE_PATTERN.test(f)).sort();
}

interface FileGroup {
	filename: string;
	counter: number;
}

async function archiveFiles(
	pendingDir: string,
	archiveDir: string,
	files: FileGroup[],
): Promise<void> {
	files.sort((a, b) => a.counter - b.counter);
	for (const f of files) {
		// biome-ignore lint/performance/noAwaitInLoops: sequential renames for crash safety
		await rename(
			join(pendingDir, f.filename),
			join(archiveDir, f.filename),
		);
	}
}

interface PersistenceConsumer extends BusConsumer {
	recover(): AsyncIterable<RuntimeEvent[]>;
}

interface PersistenceOptions {
	concurrency?: number;
	logger?: { error(msg: string, data: Record<string, unknown>): void };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled persistence logic
function createPersistence(
	dir: string,
	options?: PersistenceOptions,
): PersistenceConsumer {
	const pendingDir = join(dir, "pending");
	const archiveDir = join(dir, "archive");
	const logger = options?.logger;
	const concurrency = options?.concurrency ?? 10;
	// NOTE: This counter is single-threaded. If parallel scheduling is introduced,
	// this must be replaced with an atomic counter or file-based lock.
	let counter = 0;

	return {
		async handle(event: RuntimeEvent): Promise<void> {
			counter++;
			const filename = formatFilename(counter, event.id);
			await atomicWrite(
				join(pendingDir, filename),
				JSON.stringify(event, null, 2),
			);

			if (
				event.state === "done" ||
				event.state === "failed" ||
				event.state === "skipped"
			) {
				archiveEvent(event.id).catch((err) => {
					logger?.error("archive-failed", {
						eventId: event.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		},

		async bootstrap(
			_events: RuntimeEvent[],
			_options?: { finished?: boolean },
		): Promise<void> {
			// No-op: persistence is the bootstrap source, not a consumer of bootstrap data
		},

		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: recovery logic is sequential and reads best as one block
		async *recover(): AsyncIterable<RuntimeEvent[]> {
			await mkdir(pendingDir, { recursive: true });
			await mkdir(archiveDir, { recursive: true });

			const archiveFiles = await listEventFiles(archiveDir);
			const pendingFiles = await listEventFiles(pendingDir);

			// Recover counter from max across both directories
			let maxCounter = 0;
			for (const f of [...archiveFiles, ...pendingFiles]) {
				const parsed = parseFilename(f);
				if (parsed && parsed.counter > maxCounter) {
					maxCounter = parsed.counter;
				}
			}
			counter = maxCounter;

			// Group pending files by eventId
			const byEvent = new Map<string, FileGroup[]>();
			for (const filename of pendingFiles) {
				const parsed = parseFilename(filename);
				if (!parsed) {
					continue;
				}
				const group = byEvent.get(parsed.eventId) ?? [];
				group.push({ filename, counter: parsed.counter });
				byEvent.set(parsed.eventId, group);
			}

			const limit = pLimit(concurrency);
			const results = await Promise.all(
				[...byEvent.values()].map((files) =>
					limit(async () => {
						files.sort((a, b) => a.counter - b.counter);
						const latest = files.at(-1);
						if (!latest) {
							return;
						}
						const content = await readFile(
							join(pendingDir, latest.filename),
							"utf-8",
						);
						const stored = RuntimeEventSchema.parse(
							JSON.parse(content, stripNulls),
						);

						if (
							stored.state === "done" ||
							stored.state === "failed" ||
							stored.state === "skipped"
						) {
							await archiveFilesHelper(files);
							return;
						}
						return {
							event: stored,
							counter: latest.counter,
						};
					}),
				),
			);

			const eventsToRequeue = results.filter((r) => r != null);
			eventsToRequeue.sort((a, b) => a.counter - b.counter);

			if (eventsToRequeue.length > 0) {
				yield eventsToRequeue.map((e) => e.event);
			}
		},
	};

	async function archiveEvent(eventId: string): Promise<void> {
		const allFiles = await listEventFiles(pendingDir);
		const eventFiles: FileGroup[] = [];
		for (const f of allFiles) {
			const parsed = parseFilename(f);
			if (parsed?.eventId === eventId) {
				eventFiles.push({ filename: f, counter: parsed.counter });
			}
		}
		await archiveFilesHelper(eventFiles);
	}

	async function archiveFilesHelper(files: FileGroup[]): Promise<void> {
		await archiveFiles(pendingDir, archiveDir, files);
	}
}

export { createPersistence };
export type { PersistenceConsumer };
