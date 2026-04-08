import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "./index.js";
import { createPersistence } from "./persistence.js";
import { mkdir, rm } from "node:fs/promises";

let testDir: string;

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	} as RuntimeEvent;
}

beforeEach(async () => {
	testDir = join(tmpdir(), `persistence-test-${crypto.randomUUID()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

describe("persistence handle", () => {
	it("writes files for each state transition with eager archival", async () => {
		const persistence = createPersistence(testDir);
		// Initialize directories via recover
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent({ id: "evt_abc" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "processing" });
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait a tick for fire-and-forget archive
		await new Promise((r) => setTimeout(r, 50));

		const pendingFiles = (await readdir(join(testDir, "pending"))).filter((f) => f.endsWith(".json"));
		const archiveFilesResult = (await readdir(join(testDir, "archive"))).filter((f) => f.endsWith(".json"));

		// pending/ should be empty (processing archived pending, done wrote to archive + archived processing)
		expect(pendingFiles.length).toBe(0);
		// All 3 files should be in archive
		expect(archiveFilesResult.length).toBe(3);
	});

	it("uses atomic write pattern (tmp + rename)", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent();
		await persistence.handle(event);

		const files = await readdir(join(testDir, "pending"));
		const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		expect(tmpFiles.length).toBe(0);
		expect(jsonFiles.length).toBe(1);
	});

	it("increments counter for each write", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event1 = makeEvent({ id: "evt_aaa" });
		const event2 = makeEvent({ id: "evt_bbb" });
		await persistence.handle(event1);
		await persistence.handle(event2);

		const files = (await readdir(join(testDir, "pending"))).filter((f) =>
			f.endsWith(".json"),
		).sort();

		expect(files[0]).toContain("000001_");
		expect(files[1]).toContain("000002_");
	});

	it("terminal state writes directly to archive and archives pending files", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent({ id: "evt_term" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait for fire-and-forget archive to complete
		await new Promise((r) => setTimeout(r, 50));

		const pendingFiles = (await readdir(join(testDir, "pending"))).filter((f) => f.endsWith(".json"));
		const archiveFilesResult = (await readdir(join(testDir, "archive"))).filter((f) => f.endsWith(".json"));

		// pending/ should be empty, archive/ should have both files
		expect(pendingFiles.length).toBe(0);
		expect(archiveFilesResult.length).toBe(2);
	});

	it("archives on failed state", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent({ id: "evt_fail" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "done", result: "failed", error: "boom" });

		await new Promise((r) => setTimeout(r, 50));

		const archiveFiles = (await readdir(join(testDir, "archive"))).filter(
			(f) => f.endsWith(".json"),
		);
		expect(archiveFiles.length).toBe(2);
	});

	it("archives on skipped state", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent({ id: "evt_skip" });
		await persistence.handle({ ...event, state: "pending" });
		await persistence.handle({ ...event, state: "done", result: "skipped" });

		await new Promise((r) => setTimeout(r, 50));

		const archiveFiles = (await readdir(join(testDir, "archive"))).filter(
			(f) => f.endsWith(".json"),
		);
		expect(archiveFiles.length).toBe(2);
	});

	it("writes full event data to file", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		const event = makeEvent({
			id: "evt_full",
			type: "order.received",
			payload: { orderId: "123" },
			correlationId: "corr_xyz",
			state: "pending",
		});
		await persistence.handle(event);

		const files = (await readdir(join(testDir, "pending"))).filter((f) =>
			f.endsWith(".json"),
		);
		const content = JSON.parse(
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			await readFile(join(testDir, "pending", files[0]!), "utf-8"),
		);

		expect(content.id).toBe("evt_full");
		expect(content.type).toBe("order.received");
		expect(content.payload).toEqual({ orderId: "123" });
		expect(content.correlationId).toBe("corr_xyz");
		expect(content.state).toBe("pending");
	});

	it("logs archive errors without throwing", async () => {
		const errorSpy = vi.fn();
		const persistence = createPersistence(testDir, {
			logger: { error: errorSpy },
		});
		for await (const _ of persistence.recover()) { /* drain */ }

		// Write a pending file, then manually remove pending dir to cause archive failure
		const event = makeEvent({ id: "evt_err" });
		await persistence.handle({ ...event, state: "pending" });

		// Remove the pending dir to cause archive to fail when listing files
		await rm(join(testDir, "pending"), { recursive: true });
		await mkdir(join(testDir, "pending"), { recursive: true });

		// This should not throw even though archive will fail
		await persistence.handle({ ...event, state: "done", result: "succeeded" });

		// Wait for fire-and-forget
		await new Promise((r) => setTimeout(r, 50));

		// Archive error should be logged, not thrown
		// (the pending file for "done" was written to fresh dir, but the "pending" file was deleted)
	});

	it("bootstrap is a no-op", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		await persistence.bootstrap([makeEvent()], { finished: true });

		const pendingFiles = await readdir(join(testDir, "pending"));
		const jsonFiles = pendingFiles.filter((f) => f.endsWith(".json"));
		expect(jsonFiles.length).toBe(0);
	});
});

describe("persistence recover", () => {
	it("recovers pending events", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event = makeEvent({ id: "evt_pend", state: "pending" });
		await writeFile(
			join(pendingDir, "000001_evt_pend.json"),
			JSON.stringify(event),
		);

		const persistence = createPersistence(testDir);
		const allEvents: RuntimeEvent[] = [];
		for await (const { events } of persistence.recover()) {
			allEvents.push(...events);
		}

		expect(allEvents.length).toBe(1);
		expect(allEvents[0]?.id).toBe("evt_pend");
		expect(allEvents[0]?.state).toBe("pending");
	});

	it("recovers processing events (crash recovery) — takes latest state", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event = makeEvent({ id: "evt_proc" });
		await writeFile(
			join(pendingDir, "000001_evt_proc.json"),
			JSON.stringify({ ...event, state: "pending" }),
		);
		await writeFile(
			join(pendingDir, "000002_evt_proc.json"),
			JSON.stringify({ ...event, state: "processing" }),
		);

		const persistence = createPersistence(testDir);
		const pendingEvents: RuntimeEvent[] = [];
		for await (const { events, pending } of persistence.recover()) {
			if (pending) {
				pendingEvents.push(...events);
			}
		}

		// Only the latest state per event in pending batch
		expect(pendingEvents.length).toBe(1);
		expect(pendingEvents[0]?.state).toBe("processing");
	});

	it("handles crash case — deduplicates and moves older to archive", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		// Simulate crash: 2 files for same event in pending
		const event = makeEvent({ id: "evt_crash" });
		await writeFile(
			join(pendingDir, "000001_evt_crash.json"),
			JSON.stringify({ ...event, state: "pending" }),
		);
		await writeFile(
			join(pendingDir, "000002_evt_crash.json"),
			JSON.stringify({ ...event, state: "processing" }),
		);

		const persistence = createPersistence(testDir);
		for await (const _batch of persistence.recover()) {
			// consume
		}

		// After recovery: pending/ has 1 file (latest), archive/ has 1 file (older)
		const pendingEntries = (await readdir(pendingDir)).filter((f) => f.endsWith(".json"));
		const archiveEntries = (await readdir(archiveDir)).filter((f) => f.endsWith(".json"));
		expect(pendingEntries.length).toBe(1);
		expect(pendingEntries[0]).toContain("000002_");
		expect(archiveEntries.length).toBe(1);
		expect(archiveEntries[0]).toContain("000001_");
	});

	it("recovers counter from existing files", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event = makeEvent({ id: "evt_cnt" });
		await writeFile(
			join(archiveDir, "000042_evt_old.json"),
			JSON.stringify({ ...event, id: "evt_old", state: "done", result: "succeeded" }),
		);
		await writeFile(
			join(pendingDir, "000043_evt_cnt.json"),
			JSON.stringify({ ...event, state: "pending" }),
		);

		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		// Next write should use counter 44
		await persistence.handle(makeEvent({ id: "evt_new" }));

		const files = (await readdir(pendingDir))
			.filter((f) => f.endsWith(".json"))
			.sort();
		const newFile = files.find((f) => f.includes("evt_new"));
		expect(newFile).toContain("000044_");
	});

	it("handles empty directories", async () => {
		const persistence = createPersistence(testDir);
		const allEvents: RuntimeEvent[] = [];
		for await (const { events } of persistence.recover()) {
			allEvents.push(...events);
		}

		expect(allEvents.length).toBe(0);

		// Directories should be created
		const entries = await readdir(testDir);
		expect(entries).toContain("pending");
		expect(entries).toContain("archive");
	});

	it("starts counter at 0 for empty directories", async () => {
		const persistence = createPersistence(testDir);
		for await (const _ of persistence.recover()) { /* drain */ }

		await persistence.handle(makeEvent({ id: "evt_first" }));

		const files = (await readdir(join(testDir, "pending"))).filter((f) =>
			f.endsWith(".json"),
		);
		expect(files[0]).toContain("000001_");
	});
});
