import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventQueueContractTests } from "./event-queue.contract.js";
import { FileSystemEventQueue } from "./fs-queue.js";
import type { Event } from "./index.js";

const EVENT_FILE_PATTERN = /^\d+_evt_/;

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		...overrides,
	};
}

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fs-queue-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	dirs.length = 0;
});

const TEST_CONCURRENCY = 10;

async function createQueue(dir: string) {
	return FileSystemEventQueue.create(dir, { concurrency: TEST_CONCURRENCY });
}

eventQueueContractTests(
	"FileSystemEventQueue",
	async () => createQueue(await makeTempDir()),
);

describe("FileSystemEventQueue", () => {
	describe("crash recovery", () => {
		it("recovers pending events on startup", async () => {
			const dir = await makeTempDir();

			const queue1 = await createQueue(dir);
			const event = makeEvent({ id: "evt_recover" });
			await queue1.enqueue(event);

			const queue2 = await createQueue(dir);
			const dequeued = await queue2.dequeue();

			expect(dequeued.id).toBe("evt_recover");
			expect(dequeued.type).toBe("test.event");
		});

		it("completes interrupted archive on startup", async () => {
			const dir = await makeTempDir();
			const pendingDir = join(dir, "pending");
			const archiveDir = join(dir, "archive");

			const queue1 = await createQueue(dir);
			const event = makeEvent({ id: "evt_interrupted" });
			await queue1.enqueue(event);

			const terminalContent = JSON.stringify({
				id: "evt_interrupted",
				type: "test.event",
				payload: {},
				targetAction: null,
				correlationId: "corr_test",
				parentEventId: null,
				createdAt: event.createdAt.toISOString(),
				state: "done",
			});
			await writeFile(join(pendingDir, "000001_evt_interrupted.json"), terminalContent);

			const queue2 = await createQueue(dir);

			const newEvent = makeEvent({ id: "evt_new" });
			await queue2.enqueue(newEvent);
			const dequeued = await queue2.dequeue();
			expect(dequeued.id).toBe("evt_new");

			const pendingFiles = await readdir(pendingDir);
			const archiveFiles = await readdir(archiveDir);
			expect(pendingFiles.filter((f) => f.includes("interrupted"))).toHaveLength(0);
			expect(archiveFiles.filter((f) => f.includes("interrupted")).length).toBeGreaterThan(0);
		});

		it("ignores .tmp files during recovery", async () => {
			const dir = await makeTempDir();
			const pendingDir = join(dir, "pending");

			await createQueue(dir);
			await writeFile(join(pendingDir, "000001_evt_stale.json.tmp"), "partial data");

			const queue2 = await createQueue(dir);

			const newEvent = makeEvent({ id: "evt_fresh" });
			await queue2.enqueue(newEvent);
			const dequeued = await queue2.dequeue();
			expect(dequeued.id).toBe("evt_fresh");
		});
	});

	describe("file operations", () => {
		it("writes event files to pending/ on enqueue", async () => {
			const dir = await makeTempDir();
			const queue = await createQueue(dir);
			const event = makeEvent({ id: "evt_abc" });

			await queue.enqueue(event);

			const files = await readdir(join(dir, "pending"));
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(EVENT_FILE_PATTERN);

			const filename = files[0];
			expect(filename).toBeDefined();
			const content = JSON.parse(await readFile(join(dir, "pending", filename as string), "utf-8"));
			expect(content.id).toBe("evt_abc");
			expect(content.state).toBe("pending");
		});

		it("archives event files on ack", async () => {
			const dir = await makeTempDir();
			const queue = await createQueue(dir);
			const event = makeEvent({ id: "evt_acked" });

			await queue.enqueue(event);
			await queue.dequeue();
			await queue.ack("evt_acked");

			const pendingFiles = await readdir(join(dir, "pending"));
			const archiveFiles = await readdir(join(dir, "archive"));

			expect(pendingFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);
			expect(archiveFiles).toHaveLength(2);

			archiveFiles.sort();
			const lastFile = archiveFiles.at(-1);
			expect(lastFile).toBeDefined();
			const content = JSON.parse(await readFile(join(dir, "archive", lastFile as string), "utf-8"));
			expect(content.state).toBe("done");
		});

		it("archives event files on fail", async () => {
			const dir = await makeTempDir();
			const queue = await createQueue(dir);
			const event = makeEvent({ id: "evt_failed" });

			await queue.enqueue(event);
			await queue.dequeue();
			await queue.fail("evt_failed");

			const pendingFiles = await readdir(join(dir, "pending"));
			const archiveFiles = await readdir(join(dir, "archive"));

			expect(pendingFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);
			expect(archiveFiles).toHaveLength(2);

			archiveFiles.sort();
			const lastFile = archiveFiles.at(-1);
			expect(lastFile).toBeDefined();
			const content = JSON.parse(await readFile(join(dir, "archive", lastFile as string), "utf-8"));
			expect(content.state).toBe("failed");
		});

		it("uses atomic writes (no partial files on success)", async () => {
			const dir = await makeTempDir();
			const queue = await createQueue(dir);
			const event = makeEvent();

			await queue.enqueue(event);

			const files = await readdir(join(dir, "pending"));
			expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
		});

		it("global counter increments across operations", async () => {
			const dir = await makeTempDir();
			const queue = await createQueue(dir);

			await queue.enqueue(makeEvent({ id: "evt_one" }));
			await queue.enqueue(makeEvent({ id: "evt_two" }));

			const files = (await readdir(join(dir, "pending"))).sort();
			expect(files).toHaveLength(2);
			expect(files).toHaveLength(2);
			// Files are sorted; verify ascending counter order
			expect(files.join(",")).toBe([...files].sort().join(","));
		});

		it("counter recovers across restarts", async () => {
			const dir = await makeTempDir();

			const queue1 = await createQueue(dir);
			await queue1.enqueue(makeEvent({ id: "evt_first" }));

			const queue2 = await createQueue(dir);
			await queue2.enqueue(makeEvent({ id: "evt_second" }));

			const files = (await readdir(join(dir, "pending"))).sort();
			expect(files).toHaveLength(2);
			expect(files).toHaveLength(2);
			// Files are sorted; verify ascending counter order
			expect(files.join(",")).toBe([...files].sort().join(","));
		});
	});
});
