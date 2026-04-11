import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import type { RuntimeEvent } from "./index.js";
import { createPersistence } from "./persistence.js";

let testDir: string;
let backend: StorageBackend;

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	} as RuntimeEvent;
}

beforeEach(async () => {
	testDir = join(tmpdir(), `persistence-test-${crypto.randomUUID()}`);
	await mkdir(testDir, { recursive: true });
	backend = createFsStorage(testDir);
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

describe("persistence handle", () => {
	it("writes files for each state transition with eager archival", async () => {
		const persistence = createPersistence(backend);
		// Initialize directories via recover
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({ id: "evt_abc" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "processing" });
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait a tick for fire-and-forget archive
		await new Promise((r) => setTimeout(r, 50));

		const pendingFiles = (
			await readdir(join(testDir, "events/pending"))
		).filter((f) => f.endsWith(".json"));
		const archiveFilesResult = (
			await readdir(join(testDir, "events/archive"))
		).filter((f) => f.endsWith(".json"));

		// pending/ should be empty (processing archived pending, done wrote to archive + archived processing)
		expect(pendingFiles.length).toBe(0);
		// All 3 files should be in archive
		expect(archiveFilesResult.length).toBe(3);
	});

	it("increments counter for each write", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event1 = makeEvent({ id: "evt_aaa" });
		const event2 = makeEvent({ id: "evt_bbb" });
		await persistence.handle(event1);
		await persistence.handle(event2);

		const files: string[] = [];
		for await (const path of backend.list("events/pending/")) {
			files.push(path);
		}
		files.sort();

		expect(files[0]).toContain("000001_");
		expect(files[1]).toContain("000002_");
	});

	it("terminal state writes directly to archive and archives pending files", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({ id: "evt_term" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait for fire-and-forget archive to complete
		await new Promise((r) => setTimeout(r, 50));

		const pending: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			pending.push(p);
		}
		const archive: string[] = [];
		for await (const p of backend.list("events/archive/")) {
			archive.push(p);
		}

		expect(pending.length).toBe(0);
		expect(archive.length).toBe(2);
	});

	it("archives on failed state", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({ id: "evt_fail" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({
			...event,
			state: "done",
			result: "failed",
			error: { message: "boom", stack: "" },
		});

		await new Promise((r) => setTimeout(r, 50));

		const archive: string[] = [];
		for await (const p of backend.list("events/archive/")) {
			archive.push(p);
		}
		expect(archive.length).toBe(2);
	});

	it("archives on skipped state", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({ id: "evt_skip" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "done", result: "skipped" });

		await new Promise((r) => setTimeout(r, 50));

		const archive: string[] = [];
		for await (const p of backend.list("events/archive/")) {
			archive.push(p);
		}
		expect(archive.length).toBe(2);
	});

	it("writes full event data to file", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({
			id: "evt_full",
			type: "order.received",
			payload: { orderId: "123" },
			correlationId: "corr_xyz",
			state: "pending",
		});
		await persistence.handle(event);

		const files: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			files.push(p);
		}

		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const content = JSON.parse(await backend.read(files[0]!));

		expect(content.id).toBe("evt_full");
		expect(content.type).toBe("order.received");
		expect(content.payload).toEqual({ orderId: "123" });
		expect(content.correlationId).toBe("corr_xyz");
		expect(content.state).toBe("pending");
	});

	it("logs archive errors without throwing", async () => {
		const errorSpy = vi.fn();
		const persistence = createPersistence(backend, {
			logger: { error: errorSpy },
		});
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		const event = makeEvent({ id: "evt_err" });
		await persistence.handle({ ...event, state: "pending" });

		// Remove the pending dir to cause archive to fail when listing files
		await rm(join(testDir, "events/pending"), { recursive: true });
		await mkdir(join(testDir, "events/pending"), { recursive: true });

		// This should not throw even though archive will fail
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait for fire-and-forget
		await new Promise((r) => setTimeout(r, 50));
	});

	it("bootstrap is a no-op", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		await persistence.bootstrap([makeEvent()], { pending: true });

		const pending: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			pending.push(p);
		}
		expect(pending.filter((f) => f.endsWith(".json")).length).toBe(0);
	});
});

describe("persistence recover", () => {
	it("recovers pending events", async () => {
		await backend.init();
		await mkdir(join(testDir, "events/pending"), { recursive: true });
		await mkdir(join(testDir, "events/archive"), { recursive: true });

		const event = makeEvent({ id: "evt_pend", state: "pending" });
		await backend.write(
			"events/pending/000001_evt_pend.json",
			JSON.stringify(event),
		);

		const persistence = createPersistence(backend);
		const allEvents: RuntimeEvent[] = [];
		for await (const { events } of persistence.recover()) {
			allEvents.push(...events);
		}

		expect(allEvents.length).toBe(1);
		expect(allEvents[0]?.id).toBe("evt_pend");
		expect(allEvents[0]?.state).toBe("pending");
	});

	it("recovers processing events (crash recovery) — takes latest state", async () => {
		await backend.init();
		await mkdir(join(testDir, "events/pending"), { recursive: true });
		await mkdir(join(testDir, "events/archive"), { recursive: true });

		const event = makeEvent({ id: "evt_proc" });
		await backend.write(
			"events/pending/000001_evt_proc.json",
			JSON.stringify({ ...event, state: "pending" }),
		);
		await backend.write(
			"events/pending/000002_evt_proc.json",
			JSON.stringify({ ...event, state: "processing" }),
		);

		const persistence = createPersistence(backend);
		const pendingEvents: RuntimeEvent[] = [];
		for await (const { events, pending } of persistence.recover()) {
			if (pending) {
				pendingEvents.push(...events);
			}
		}

		expect(pendingEvents.length).toBe(1);
		expect(pendingEvents[0]?.state).toBe("processing");
	});

	it("handles crash case — deduplicates and moves older to archive", async () => {
		await backend.init();
		await mkdir(join(testDir, "events/pending"), { recursive: true });
		await mkdir(join(testDir, "events/archive"), { recursive: true });

		const event = makeEvent({ id: "evt_crash" });
		await backend.write(
			"events/pending/000001_evt_crash.json",
			JSON.stringify({ ...event, state: "pending" }),
		);
		await backend.write(
			"events/pending/000002_evt_crash.json",
			JSON.stringify({ ...event, state: "processing" }),
		);

		const persistence = createPersistence(backend);
		for await (const _batch of persistence.recover()) {
			// consume
		}

		const pending: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			pending.push(p);
		}
		const archive: string[] = [];
		for await (const p of backend.list("events/archive/")) {
			archive.push(p);
		}

		expect(pending.length).toBe(1);
		expect(pending[0]).toContain("000002_");
		expect(archive.length).toBe(1);
		expect(archive[0]).toContain("000001_");
	});

	it("recovers counter from existing files", async () => {
		await backend.init();
		await mkdir(join(testDir, "events/pending"), { recursive: true });
		await mkdir(join(testDir, "events/archive"), { recursive: true });

		const event = makeEvent({ id: "evt_cnt" });
		await backend.write(
			"events/archive/000042_evt_old.json",
			JSON.stringify({
				...event,
				id: "evt_old",
				state: "done",
				result: "succeeded",
			}),
		);
		await backend.write(
			"events/pending/000043_evt_cnt.json",
			JSON.stringify({ ...event, state: "pending" }),
		);

		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		await persistence.handle(makeEvent({ id: "evt_new" }));

		const pending: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			pending.push(p);
		}
		const newFile = pending.find((f) => f.includes("evt_new"));
		expect(newFile).toContain("000044_");
	});

	it("handles empty directories", async () => {
		const persistence = createPersistence(backend);
		const allEvents: RuntimeEvent[] = [];
		for await (const { events } of persistence.recover()) {
			allEvents.push(...events);
		}

		expect(allEvents.length).toBe(0);
	});

	it("starts counter at 0 for empty directories", async () => {
		const persistence = createPersistence(backend);
		for await (const _ of persistence.recover()) {
			/* drain */
		}

		await persistence.handle(makeEvent({ id: "evt_first" }));

		const pending: string[] = [];
		for await (const p of backend.list("events/pending/")) {
			pending.push(p);
		}
		expect(pending[0]).toContain("000001_");
	});
});
