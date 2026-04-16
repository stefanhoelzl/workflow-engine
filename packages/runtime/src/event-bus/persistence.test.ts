import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import type { InvocationLifecycleEvent } from "./index.js";
import {
	archivePath,
	createPersistence,
	type InvocationRecord,
	pendingPath,
	scanArchive,
	scanPending,
} from "./persistence.js";

let testDir: string;
let backend: StorageBackend;

beforeEach(async () => {
	testDir = join(tmpdir(), `persistence-test-${crypto.randomUUID()}`);
	await mkdir(testDir, { recursive: true });
	backend = createFsStorage(testDir);
	await backend.init();
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function startedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "started" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "started",
		id: "evt_abc",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:00.000Z"),
		input: { foo: "bar" },
		...overrides,
	};
}

function completedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "completed" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "completed",
		id: "evt_abc",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:01.000Z"),
		result: { status: 200, body: "", headers: {} },
		...overrides,
	};
}

function failedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "failed" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "failed",
		id: "evt_abc",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:01.000Z"),
		error: { message: "boom", stack: "at ..." },
		...overrides,
	};
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const entry of iter) {
		out.push(entry);
	}
	return out;
}

describe("persistence consumer", () => {
	it("started writes pending/<id>.json with the start record", async () => {
		const persistence = createPersistence(backend);
		await persistence.handle(startedEvent({ id: "evt_abc" }));

		const raw = await backend.read(pendingPath("evt_abc"));
		const record = JSON.parse(raw) as InvocationRecord;

		expect(record.id).toBe("evt_abc");
		expect(record.status).toBe("pending");
		expect(record.workflow).toBe("w1");
		expect(record.trigger).toBe("t1");
		expect(record.input).toEqual({ foo: "bar" });
		expect(record.startedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("completed writes archive/<id>.json and removes pending/<id>.json", async () => {
		const persistence = createPersistence(backend);
		await persistence.handle(startedEvent({ id: "evt_complete" }));
		await persistence.handle(completedEvent({ id: "evt_complete" }));

		const pendingList = await collect(backend.list("pending/"));
		expect(pendingList).toEqual([]);

		const archiveRaw = await backend.read(archivePath("evt_complete"));
		const record = JSON.parse(archiveRaw) as InvocationRecord;
		expect(record.status).toBe("succeeded");
		if (record.status !== "succeeded") {
			throw new Error("unexpected status");
		}
		expect(record.result).toEqual({ status: 200, body: "", headers: {} });
		expect(record.startedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(record.completedAt).toBe("2026-01-01T00:00:01.000Z");
		expect(record.input).toEqual({ foo: "bar" });
	});

	it("failed writes archive/<id>.json with status failed + error, clears pending", async () => {
		const persistence = createPersistence(backend);
		await persistence.handle(startedEvent({ id: "evt_fail" }));
		await persistence.handle(
			failedEvent({
				id: "evt_fail",
				error: { message: "boom", stack: "at ...", kind: "user_code" },
			}),
		);

		const pendingList = await collect(backend.list("pending/"));
		expect(pendingList).toEqual([]);

		const archiveRaw = await backend.read(archivePath("evt_fail"));
		const record = JSON.parse(archiveRaw) as InvocationRecord;
		expect(record.status).toBe("failed");
		if (record.status !== "failed") {
			throw new Error("unexpected status");
		}
		expect(record.error.message).toBe("boom");
		expect(record.error.kind).toBe("user_code");
		expect(record.input).toEqual({ foo: "bar" });
	});

	it("engine_crashed failure (without prior started in-process) reads snapshot from disk", async () => {
		// Simulate a prior-session pending file left on disk.
		const priorRecord = {
			id: "evt_crashed",
			workflow: "w1",
			trigger: "t1",
			input: { prior: true },
			startedAt: "2025-12-31T23:59:59.000Z",
			status: "pending",
		};
		await backend.write(
			pendingPath("evt_crashed"),
			JSON.stringify(priorRecord),
		);

		const persistence = createPersistence(backend);
		await persistence.handle(
			failedEvent({
				id: "evt_crashed",
				error: { kind: "engine_crashed" },
			}),
		);

		const pending = await collect(backend.list("pending/"));
		expect(pending).toEqual([]);

		const archiveRaw = await backend.read(archivePath("evt_crashed"));
		const record = JSON.parse(archiveRaw) as InvocationRecord;
		if (record.status !== "failed") {
			throw new Error("unexpected status");
		}
		expect(record.error.kind).toBe("engine_crashed");
		expect(record.input).toEqual({ prior: true });
		expect(record.startedAt).toBe("2025-12-31T23:59:59.000Z");
	});

	it("handles delegate to StorageBackend for I/O", async () => {
		const fakeBackend: StorageBackend = {
			init: vi.fn(async () => undefined),
			write: vi.fn(async () => undefined),
			read: vi.fn(async () => "{}"),
			list: vi.fn(async function* () {
				// empty
			}),
			remove: vi.fn(async () => undefined),
			move: vi.fn(async () => undefined),
		};
		const persistence = createPersistence(fakeBackend);
		await persistence.handle(startedEvent({ id: "evt_io" }));
		await persistence.handle(completedEvent({ id: "evt_io" }));

		expect(fakeBackend.write).toHaveBeenCalledWith(
			pendingPath("evt_io"),
			expect.any(String),
		);
		expect(fakeBackend.write).toHaveBeenCalledWith(
			archivePath("evt_io"),
			expect.any(String),
		);
		expect(fakeBackend.remove).toHaveBeenCalledWith(pendingPath("evt_io"));
	});
});

describe("scanPending / scanArchive", () => {
	it("scanPending yields each pending record", async () => {
		const persistence = createPersistence(backend);
		await persistence.handle(startedEvent({ id: "evt_one" }));
		await persistence.handle(startedEvent({ id: "evt_two" }));

		const records = await collect(scanPending(backend));
		const ids = records.map((r) => r.id).sort();
		expect(ids).toEqual(["evt_one", "evt_two"]);
		for (const record of records) {
			expect(record.status).toBe("pending");
		}
	});

	it("scanArchive yields each archived record", async () => {
		const persistence = createPersistence(backend);
		for (const id of ["a", "b", "c"]) {
			// biome-ignore lint/performance/noAwaitInLoops: each invocation must started-then-completed in order; parallelization would race the in-memory `starts` map
			await persistence.handle(startedEvent({ id: `evt_${id}` }));
			await persistence.handle(completedEvent({ id: `evt_${id}` }));
		}

		const records = await collect(scanArchive(backend));
		const ids = records.map((r) => r.id).sort();
		expect(ids).toEqual(["evt_a", "evt_b", "evt_c"]);
		for (const record of records) {
			expect(record.status).toBe("succeeded");
		}
	});

	it("scanPending is empty when pending/ is empty", async () => {
		const records = await collect(scanPending(backend));
		expect(records).toEqual([]);
	});

	it("scanArchive is empty when archive/ is empty", async () => {
		const records = await collect(scanArchive(backend));
		expect(records).toEqual([]);
	});
});
