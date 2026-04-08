import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { createLogger } from "../logger.js";
import { createScheduler } from "../services/scheduler.js";
import type { RuntimeEvent } from "./index.js";
import { createEventBus } from "./index.js";
import { createPersistence } from "./persistence.js";
import { createWorkQueue } from "./work-queue.js";

const silentLogger = createLogger("test", { level: "silent" });

let testDir: string;

beforeEach(async () => {
	testDir = join(tmpdir(), `recovery-test-${crypto.randomUUID()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function makeStoredEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	};
}

function stubContextFactory(event: RuntimeEvent): ActionContext {
	return new ActionContext(event, vi.fn(), vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
}

describe("full startup/recovery integration", () => {
	it("persists events to FS, recovers on restart, and WorkQueue has them", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event1 = makeStoredEvent({ id: "evt_recover1", type: "test.event", state: "pending" });
		const event2 = makeStoredEvent({ id: "evt_recover2", type: "test.event", state: "pending" });
		await writeFile(join(pendingDir, "000001_evt_recover1.json"), JSON.stringify(event1));
		await writeFile(join(pendingDir, "000002_evt_recover2.json"), JSON.stringify(event2));

		const persistence = createPersistence(testDir);
		const workQueue = createWorkQueue();
		const bus = createEventBus([persistence, workQueue]);

		for await (const batch of persistence.recover()) {
			await bus.bootstrap(batch);
		}
		await bus.bootstrap([], { finished: true });

		const d1 = await workQueue.dequeue();
		const d2 = await workQueue.dequeue();
		expect(d1.id).toBe("evt_recover1");
		expect(d2.id).toBe("evt_recover2");
	});

	it("recovered events are processed by scheduler", async () => {
		const pendingDir = join(testDir, "pending");
		const archiveDir = join(testDir, "archive");
		await mkdir(pendingDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const event = makeStoredEvent({
			id: "evt_sched",
			type: "order.received",
			targetAction: "processOrder",
			state: "pending",
		});
		await writeFile(join(pendingDir, "000001_evt_sched.json"), JSON.stringify(event));

		const persistence = createPersistence(testDir);
		const workQueue = createWorkQueue();
		const bus = createEventBus([persistence, workQueue]);

		for await (const batch of persistence.recover()) {
			await bus.bootstrap(batch);
		}
		await bus.bootstrap([], { finished: true });

		const handler = vi.fn();
		const action: Action = {
			name: "processOrder",
			match: (e) => e.type === "order.received" && e.targetAction === "processOrder",
			handler,
		};

		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 50));
		await scheduler.stop();
		await started;

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls.at(0)?.at(0)).toBeInstanceOf(ActionContext);
	});
});
