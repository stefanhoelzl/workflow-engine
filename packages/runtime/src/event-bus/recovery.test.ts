import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MethodMap, Sandbox } from "@workflow-engine/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { createEventSource } from "../event-source.js";
import { createScheduler } from "../services/scheduler.js";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import { createEventStore, sql } from "./event-store.js";
import type { RuntimeEvent } from "./index.js";
import { createEventBus } from "./index.js";
import type { RecoveryBatch } from "./persistence.js";
import { createPersistence } from "./persistence.js";
import { createWorkQueue } from "./work-queue.js";

const passthroughSchema = { parse: (d: unknown) => d };
function createTestSource(bus: ReturnType<typeof createEventBus>) {
	return createEventSource(
		{
			events: {
				"order.received": passthroughSchema,
				"test.event": passthroughSchema,
			},
		},
		bus,
	);
}

let testDir: string;
let backend: StorageBackend;

beforeEach(async () => {
	testDir = join(tmpdir(), `recovery-test-${crypto.randomUUID()}`);
	await mkdir(testDir, { recursive: true });
	backend = createFsStorage(testDir);
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function makeStoredEvent(
	overrides: Record<string, unknown> = {},
): RuntimeEvent {
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

function stubContextFactory(
	event: RuntimeEvent,
	_actionName: string,
): ActionContext {
	return new ActionContext(event, {});
}

describe("recovery", () => {
	describe("recover yields RecoveryBatch with pending flag", () => {
		it("yields latest batch for single pending event", async () => {
			const pendingDir = join(testDir, "events/pending");
			await mkdir(pendingDir, { recursive: true });
			await mkdir(join(testDir, "events/archive"), { recursive: true });

			const event = makeStoredEvent({ id: "evt_single", state: "pending" });
			await writeFile(
				join(pendingDir, "000001_evt_single.json"),
				JSON.stringify(event),
			);

			const persistence = createPersistence(backend);
			const batches: RecoveryBatch[] = [];
			for await (const batch of persistence.recover()) {
				batches.push(batch);
			}

			expect(batches).toHaveLength(1);
			expect(batches[0]?.pending).toBe(true);
			expect(batches[0]?.events).toHaveLength(1);
			expect(batches[0]?.events[0]?.id).toBe("evt_single");
		});

		it("deduplicates pending files — takes latest state per event", async () => {
			const pendingDir = join(testDir, "events/pending");
			await mkdir(pendingDir, { recursive: true });
			await mkdir(join(testDir, "events/archive"), { recursive: true });

			const pending = makeStoredEvent({ id: "evt_multi", state: "pending" });
			const processing = makeStoredEvent({
				id: "evt_multi",
				state: "processing",
			});
			await writeFile(
				join(pendingDir, "000001_evt_multi.json"),
				JSON.stringify(pending),
			);
			await writeFile(
				join(pendingDir, "000002_evt_multi.json"),
				JSON.stringify(processing),
			);

			const persistence = createPersistence(backend);
			const batches: RecoveryBatch[] = [];
			for await (const batch of persistence.recover()) {
				batches.push(batch);
			}

			// Two batches: pending (latest) + archive (older moved during cleanup)
			expect(batches).toHaveLength(2);
			expect(batches[0]?.pending).toBe(true);
			expect(batches[0]?.events).toHaveLength(1);
			expect(batches[0]?.events[0]?.state).toBe("processing");

			expect(batches[1]?.pending).toBe(false);
			expect(batches[1]?.events).toHaveLength(1);
			expect(batches[1]?.events[0]?.state).toBe("pending");
		});

		it("yields pending then archive batches", async () => {
			const pendingDir = join(testDir, "events/pending");
			const archiveDir = join(testDir, "events/archive");
			await mkdir(pendingDir, { recursive: true });
			await mkdir(archiveDir, { recursive: true });

			// Active event in pending
			const active = makeStoredEvent({ id: "evt_active", state: "pending" });
			await writeFile(
				join(pendingDir, "000003_evt_active.json"),
				JSON.stringify(active),
			);

			// Completed event in archive (multiple state files)
			const done1 = makeStoredEvent({ id: "evt_done", state: "pending" });
			const done2 = {
				...makeStoredEvent({ id: "evt_done" }),
				state: "done",
				result: "succeeded",
			};
			await writeFile(
				join(archiveDir, "000001_evt_done.json"),
				JSON.stringify(done1),
			);
			await writeFile(
				join(archiveDir, "000002_evt_done.json"),
				JSON.stringify(done2),
			);

			const persistence = createPersistence(backend);
			const batches: RecoveryBatch[] = [];
			for await (const batch of persistence.recover()) {
				batches.push(batch);
			}

			// Two batches: pending (latest) first, then archive (not latest)
			expect(batches).toHaveLength(2);
			expect(batches[0]?.pending).toBe(true);
			expect(batches[0]?.events).toHaveLength(1);
			expect(batches[0]?.events[0]?.id).toBe("evt_active");

			expect(batches[1]?.pending).toBe(false);
			expect(batches[1]?.events).toHaveLength(2);
		});

		it("completes interrupted archive during recovery", async () => {
			const pendingDir = join(testDir, "events/pending");
			const archiveDir = join(testDir, "events/archive");
			await mkdir(pendingDir, { recursive: true });
			await mkdir(archiveDir, { recursive: true });

			const pending = makeStoredEvent({
				id: "evt_interrupted",
				state: "pending",
			});
			const done = {
				...makeStoredEvent({ id: "evt_interrupted" }),
				state: "done",
				result: "succeeded",
			};
			await writeFile(
				join(pendingDir, "000001_evt_interrupted.json"),
				JSON.stringify(pending),
			);
			await writeFile(
				join(pendingDir, "000005_evt_interrupted.json"),
				JSON.stringify(done),
			);

			const persistence = createPersistence(backend);
			const pendingEvents: RuntimeEvent[] = [];
			for await (const batch of persistence.recover()) {
				if (batch.pending) {
					pendingEvents.push(...batch.events);
				}
			}

			// Latest state (done) is in the pending batch
			expect(pendingEvents).toHaveLength(1);
			expect(pendingEvents[0]?.state).toBe("done");
		});

		it("recovers counter from max across both directories", async () => {
			const pendingDir = join(testDir, "events/pending");
			const archiveDir = join(testDir, "events/archive");
			await mkdir(pendingDir, { recursive: true });
			await mkdir(archiveDir, { recursive: true });

			const old = {
				...makeStoredEvent({ id: "evt_old" }),
				state: "done",
				result: "succeeded",
			};
			const active = makeStoredEvent({ id: "evt_new", state: "pending" });
			await writeFile(
				join(archiveDir, "000042_evt_old.json"),
				JSON.stringify(old),
			);
			await writeFile(
				join(pendingDir, "000043_evt_new.json"),
				JSON.stringify(active),
			);

			const persistence = createPersistence(backend);
			for await (const _batch of persistence.recover()) {
				// consume
			}

			// Next handle should use counter 44
			const event = makeStoredEvent({ id: "evt_next" });
			await persistence.handle(event);

			const { readdir } = await import("node:fs/promises");
			const files = await readdir(pendingDir);
			const newFile = files.find((f) => f.includes("evt_next"));
			expect(newFile).toContain("000044_");
		});

		it("yields nothing for empty directories", async () => {
			const persistence = createPersistence(backend);
			const batches: RecoveryBatch[] = [];
			for await (const batch of persistence.recover()) {
				batches.push(batch);
			}
			expect(batches).toHaveLength(0);
		});
	});
});

describe("full startup/recovery integration", () => {
	it("persists events to FS, recovers on restart, and WorkQueue has them", async () => {
		const pendingDir = join(testDir, "events/pending");
		const archiveDir = join(testDir, "events/archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event1 = makeStoredEvent({
			id: "evt_recover1",
			type: "test.event",
			state: "pending",
		});
		const event2 = makeStoredEvent({
			id: "evt_recover2",
			type: "test.event",
			state: "pending",
		});
		await writeFile(
			join(pendingDir, "000001_evt_recover1.json"),
			JSON.stringify(event1),
		);
		await writeFile(
			join(pendingDir, "000002_evt_recover2.json"),
			JSON.stringify(event2),
		);

		const persistence = createPersistence(backend);
		const workQueue = createWorkQueue();
		const bus = createEventBus([persistence, workQueue]);

		for await (const { events, pending } of persistence.recover()) {
			await bus.bootstrap(events, { pending });
		}

		const d1 = await workQueue.dequeue();
		const d2 = await workQueue.dequeue();
		expect(d1.id).toBe("evt_recover1");
		expect(d2.id).toBe("evt_recover2");
	});

	it("recovered events are processed by scheduler", async () => {
		const pendingDir = join(testDir, "events/pending");
		const archiveDir = join(testDir, "events/archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event = makeStoredEvent({
			id: "evt_sched",
			type: "order.received",
			targetAction: "processOrder",
			state: "pending",
		});
		await writeFile(
			join(pendingDir, "000001_evt_sched.json"),
			JSON.stringify(event),
		);

		const persistence = createPersistence(backend);
		const workQueue = createWorkQueue();
		const bus = createEventBus([persistence, workQueue]);

		for await (const { events, pending } of persistence.recover()) {
			await bus.bootstrap(events, { pending });
		}

		const runSpy = vi.fn(async () => ({
			ok: true as const,
			result: undefined,
			logs: [],
		}));
		const sandboxFactory = async (
			_src: string,
			_methods: MethodMap,
		): Promise<Sandbox> => ({
			run: runSpy,
			dispose: () => {
				/* no-op */
			},
		});
		const action: Action = {
			name: "processOrder",
			on: "order.received",
			env: {},
			source: "export default async (ctx) => {}",
			exportName: "default",
		};

		const source = createTestSource(bus);
		const scheduler = createScheduler(
			workQueue,
			source,
			{ actions: [action] },
			stubContextFactory,
			{ sandboxFactory },
		);

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 50));
		await scheduler.stop();
		await started;

		expect(runSpy).toHaveBeenCalledTimes(1);
		const receivedCtx = runSpy.mock.calls.at(0)?.at(1) as
			| {
					event: { name: string; payload: unknown };
					env: Record<string, string>;
			  }
			| undefined;
		expect(receivedCtx?.event.name).toBe("order.received");
	});

	it("recovery populates EventStore with all events from both directories", async () => {
		const pendingDir = join(testDir, "events/pending");
		const archiveDir = join(testDir, "events/archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		// Active event in pending (2 state files)
		const active = makeStoredEvent({
			id: "evt_active",
			correlationId: "corr_active",
			state: "pending",
		});
		const activeProc = makeStoredEvent({
			id: "evt_active",
			correlationId: "corr_active",
			state: "processing",
		});
		await writeFile(
			join(pendingDir, "000001_evt_active.json"),
			JSON.stringify(active),
		);
		await writeFile(
			join(pendingDir, "000002_evt_active.json"),
			JSON.stringify(activeProc),
		);

		// Completed event in archive (3 state files)
		const done1 = makeStoredEvent({
			id: "evt_done",
			correlationId: "corr_done",
			state: "pending",
		});
		const done2 = makeStoredEvent({
			id: "evt_done",
			correlationId: "corr_done",
			state: "processing",
		});
		const done3 = {
			...makeStoredEvent({ id: "evt_done", correlationId: "corr_done" }),
			state: "done",
			result: "succeeded",
		};
		await writeFile(
			join(archiveDir, "000003_evt_done.json"),
			JSON.stringify(done1),
		);
		await writeFile(
			join(archiveDir, "000004_evt_done.json"),
			JSON.stringify(done2),
		);
		await writeFile(
			join(archiveDir, "000005_evt_done.json"),
			JSON.stringify(done3),
		);

		const persistence = createPersistence(backend);
		const workQueue = createWorkQueue();
		const eventStore = await createEventStore();
		const bus = createEventBus([persistence, workQueue, eventStore]);

		for await (const { events, pending } of persistence.recover()) {
			await bus.bootstrap(events, { pending });
		}

		// EventStore: 1 from pending (processing) + 4 from archive (1 moved during cleanup + 3 original)
		const allRows = await eventStore
			.with("q", (e) => e.selectAll())
			.where(sql`1`, "=", 1)
			.selectAll()
			.execute();
		expect(allRows).toHaveLength(5);

		// Can query by correlation
		const activeRows = await eventStore
			.with("q", (e) => e.selectAll())
			.where("correlationId", "=", "corr_active")
			.selectAll()
			.execute();
		expect(activeRows).toHaveLength(2); // processing (pending batch) + pending (archived during cleanup)

		const doneRows = await eventStore
			.with("q", (e) => e.selectAll())
			.where("correlationId", "=", "corr_done")
			.selectAll()
			.execute();
		expect(doneRows).toHaveLength(3);

		// WorkQueue should only have the active event (latest state = processing)
		const dequeued = await workQueue.dequeue();
		expect(dequeued.id).toBe("evt_active");
	});
});

describe("non-atomic move crash recovery", () => {
	it("recovers when file exists in both pending and archive (simulated S3 crash)", async () => {
		const pendingDir = join(testDir, "events/pending");
		const archiveDir = join(testDir, "events/archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		// Simulate S3 crash mid-move: copy succeeded but delete didn't
		// File exists in BOTH pending/ and archive/
		const event = makeStoredEvent({
			id: "evt_crash",
			state: "done",
			result: "succeeded",
		});
		const content = JSON.stringify(event);
		await writeFile(join(pendingDir, "000001_evt_crash.json"), content);
		await writeFile(join(archiveDir, "000001_evt_crash.json"), content);

		const persistence = createPersistence(backend);
		const allEvents: RuntimeEvent[] = [];
		for await (const { events } of persistence.recover()) {
			allEvents.push(...events);
		}

		// Recovery should handle the duplicate — event appears in both batches
		// but the system should not crash
		expect(allEvents.length).toBeGreaterThanOrEqual(1);
		expect(allEvents.some((e) => e.id === "evt_crash")).toBe(true);
	});
});
