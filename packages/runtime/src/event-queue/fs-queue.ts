import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "@workflow-engine/sdk";
import { InMemoryEventQueue } from "./in-memory.js";
import { EventSchema } from "./index.js";
import type { Event } from "./index.js";

const StoredEventSchema = EventSchema.extend({
	state: z.enum(["pending", "done", "failed"]),
});

function stripNulls(_key: string, value: unknown): unknown {
	return value === null ? undefined : value;
}

type StoredEventState = z.infer<typeof StoredEventSchema>["state"];

const FILE_PATTERN = /^(\d+)_evt_(.+)\.json$/;
const EVT_PREFIX_PATTERN = /^evt_/;
const COUNTER_PAD_LENGTH = 6;

function parseFilename(filename: string): { counter: number; eventId: string } | undefined {
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

function serializeEvent(event: Event, state: StoredEventState): string {
	return JSON.stringify({ ...event, state }, null, 2);
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

async function maxCounter(dir: string): Promise<number> {
	const files = await listEventFiles(dir);
	let max = -1;
	for (const file of files) {
		const parsed = parseFilename(file);
		if (parsed && parsed.counter > max) {
			max = parsed.counter;
		}
	}
	return max;
}

interface FileGroup {
	filename: string;
	counter: number;
}

async function recoverPendingDir(
	pendingDir: string,
	archiveDir: string,
): Promise<{ events: Event[]; maxCounter: number }> {
	const pendingFiles = await listEventFiles(pendingDir);

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

	const eventsToRequeue: { event: Event; counter: number }[] = [];

	for (const [, files] of byEvent) {
		files.sort((a, b) => a.counter - b.counter);
		const latest = files.at(-1);
		if (!latest) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: sequential reads needed for recovery grouping
		const content = await readFile(join(pendingDir, latest.filename), "utf-8");
		const stored = StoredEventSchema.parse(JSON.parse(content, stripNulls));

		if (stored.state === "done" || stored.state === "failed") {
			await archiveFiles(pendingDir, archiveDir, files);
		} else {
			eventsToRequeue.push({ event: stored, counter: latest.counter });
		}
	}

	eventsToRequeue.sort((a, b) => a.counter - b.counter);
	return {
		events: eventsToRequeue.map((e) => e.event),
		maxCounter: Math.max(...pendingFiles.map((f) => parseFilename(f)?.counter ?? -1), -1),
	};
}

async function archiveFiles(pendingDir: string, archiveDir: string, files: FileGroup[]): Promise<void> {
	// Sequential renames: lowest counter first for crash safety
	for (const f of files) {
		// biome-ignore lint/performance/noAwaitInLoops: must be sequential for crash safety
		await rename(join(pendingDir, f.filename), join(archiveDir, f.filename));
	}
}

class FileSystemEventQueue extends InMemoryEventQueue {
	readonly #pendingDir: string;
	readonly #archiveDir: string;
	#counter: number;

	private constructor(dir: string, counter: number, initialEvents: Event[]) {
		super(initialEvents);
		this.#pendingDir = join(dir, "pending");
		this.#archiveDir = join(dir, "archive");
		this.#counter = counter;
	}

	static async create(dir: string): Promise<FileSystemEventQueue> {
		const pendingDir = join(dir, "pending");
		const archiveDir = join(dir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const archiveMax = await maxCounter(archiveDir);
		const recovery = await recoverPendingDir(pendingDir, archiveDir);
		const counter = Math.max(recovery.maxCounter, archiveMax);

		return new FileSystemEventQueue(dir, counter, recovery.events);
	}

	async enqueue(event: Event): Promise<void> {
		this.#counter++;
		const filename = formatFilename(this.#counter, event.id);
		await atomicWrite(join(this.#pendingDir, filename), serializeEvent(event, "pending"));
		await super.enqueue(event);
	}

	async ack(eventId: string): Promise<Event> {
		// 1. Update in-memory state and get event data
		const event = await super.ack(eventId);

		// 2. Write terminal file
		this.#counter++;
		const filename = formatFilename(this.#counter, eventId);
		await atomicWrite(join(this.#pendingDir, filename), serializeEvent(event, "done"));

		// 3. Archive all files for this event (lowest counter first)
		await this.#archiveEvent(eventId);
		return event;
	}

	async fail(eventId: string): Promise<Event> {
		// 1. Update in-memory state and get event data
		const event = await super.fail(eventId);

		// 2. Write terminal file
		this.#counter++;
		const filename = formatFilename(this.#counter, eventId);
		await atomicWrite(join(this.#pendingDir, filename), serializeEvent(event, "failed"));

		// 3. Archive all files for this event (lowest counter first)
		await this.#archiveEvent(eventId);
		return event;
	}

	async #archiveEvent(eventId: string): Promise<void> {
		const allFiles = await listEventFiles(this.#pendingDir);
		const eventFiles: FileGroup[] = [];
		for (const f of allFiles) {
			const parsed = parseFilename(f);
			if (parsed?.eventId === eventId) {
				eventFiles.push({ filename: f, counter: parsed.counter });
			}
		}
		await archiveFiles(this.#pendingDir, this.#archiveDir, eventFiles);
	}
}

export { FileSystemEventQueue };
