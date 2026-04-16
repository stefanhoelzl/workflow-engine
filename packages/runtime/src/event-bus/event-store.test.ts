import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import { createEventStore, type EventStore, sql } from "./event-store.js";
import type { InvocationLifecycleEvent } from "./index.js";
import { archivePath } from "./persistence.js";

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
		input: {},
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

async function selectAll(store: EventStore, id: string) {
	return store.query.where("id", "=", id).selectAll().execute();
}

describe("EventStore handle()", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
		await store.initialized;
	});

	it("started inserts a pending row", async () => {
		await store.handle(
			startedEvent({ id: "evt_1", workflow: "wf", trigger: "tr" }),
		);

		const rows = await selectAll(store, "evt_1");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.id).toBe("evt_1");
		expect(row?.workflow).toBe("wf");
		expect(row?.trigger).toBe("tr");
		expect(row?.status).toBe("pending");
		expect(row?.completedAt).toBeNull();
		expect(row?.error).toBeNull();
	});

	it("completed updates row to succeeded", async () => {
		await store.handle(startedEvent({ id: "evt_2" }));
		await store.handle(completedEvent({ id: "evt_2" }));

		const rows = await selectAll(store, "evt_2");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("succeeded");
		expect(rows[0]?.completedAt).not.toBeNull();
		expect(rows[0]?.error).toBeNull();
	});

	it("failed updates row to failed with serialized error", async () => {
		await store.handle(startedEvent({ id: "evt_3" }));
		await store.handle(
			failedEvent({
				id: "evt_3",
				error: { message: "boom", stack: "at ...", kind: "user_code" },
			}),
		);

		const rows = await selectAll(store, "evt_3");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.completedAt).not.toBeNull();
		const errorValue = rows[0]?.error;
		const parsed =
			typeof errorValue === "string" ? JSON.parse(errorValue) : errorValue;
		expect(parsed.message).toBe("boom");
		expect(parsed.kind).toBe("user_code");
	});

	it("failed without prior started inserts a row (recovery path)", async () => {
		await store.handle(
			failedEvent({ id: "evt_crash", error: { kind: "engine_crashed" } }),
		);

		const rows = await selectAll(store, "evt_crash");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("failed");
		const errorValue = rows[0]?.error;
		const parsed =
			typeof errorValue === "string" ? JSON.parse(errorValue) : errorValue;
		expect(parsed.kind).toBe("engine_crashed");
	});
});

describe("EventStore bootstrap from archive", () => {
	let dir: string;
	let backend: StorageBackend;

	beforeEach(async () => {
		dir = join(tmpdir(), `store-test-${crypto.randomUUID()}`);
		await mkdir(dir, { recursive: true });
		backend = createFsStorage(dir);
		await backend.init();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("loads archived invocations at init", async () => {
		const records = [
			{
				id: "evt_a",
				workflow: "w",
				trigger: "t",
				input: { a: 1 },
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:01.000Z",
				status: "succeeded",
				result: { status: 200, body: "", headers: {} },
			},
			{
				id: "evt_b",
				workflow: "w",
				trigger: "t",
				input: { b: 2 },
				startedAt: "2026-01-01T00:01:00.000Z",
				completedAt: "2026-01-01T00:01:01.000Z",
				status: "failed",
				error: { message: "boom", stack: "" },
			},
		];
		for (const record of records) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential fixture writes — file ordering matters for the sort-by-startedAt assertion below
			await backend.write(archivePath(record.id), JSON.stringify(record));
		}

		const store = await createEventStore({ persistence: { backend } });
		await store.initialized;

		const rowsA = await selectAll(store, "evt_a");
		expect(rowsA).toHaveLength(1);
		expect(rowsA[0]?.status).toBe("succeeded");

		const rowsB = await selectAll(store, "evt_b");
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0]?.status).toBe("failed");
	});

	it("empty archive bootstraps to empty index", async () => {
		const store = await createEventStore({ persistence: { backend } });
		await store.initialized;

		const rows = await store.query.selectAll().execute();
		expect(rows).toHaveLength(0);
	});
});

describe("EventStore query API", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
		await store.initialized;
	});

	it("supports orderBy + limit for dashboard list view", async () => {
		for (const [i, id] of ["evt_1", "evt_2", "evt_3"].entries()) {
			// biome-ignore lint/performance/noAwaitInLoops: must be sequential so each row is written to DuckDB before the next; the test asserts stable sort order
			await store.handle(
				startedEvent({
					id,
					ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
				}),
			);
		}

		const rows = await store.query
			.selectAll()
			.orderBy("startedAt", "desc")
			.limit(2)
			.execute();

		expect(rows).toHaveLength(2);
		expect(rows[0]?.id).toBe("evt_3");
		expect(rows[1]?.id).toBe("evt_2");
	});

	it("supports CTE-style queries (with)", async () => {
		await store.handle(startedEvent({ id: "evt_1" }));
		await store.handle(completedEvent({ id: "evt_1" }));

		const rows = await store
			.with("q", (t) => t.selectAll())
			.where(sql`1`, "=", 1)
			.selectAll()
			.execute();

		expect(rows.length).toBeGreaterThan(0);
	});
});
