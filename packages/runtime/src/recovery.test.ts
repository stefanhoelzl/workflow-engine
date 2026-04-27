import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore } from "./event-bus/event-store.js";
import {
	type BusConsumer,
	createEventBus,
	type EventBus,
} from "./event-bus/index.js";
import { createPersistence } from "./event-bus/persistence.js";
import type { Logger } from "./logger.js";
import { recover } from "./recovery.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";

const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger;
}

function makeConsumer(handle: BusConsumer["handle"]): BusConsumer {
	return { name: "test", strict: false, handle };
}

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return makeEvent({
		id: "evt_a",
		ts: 100,
		workflow: "wf",
		name: "on-push",
		...overrides,
	});
}

describe("recovery", () => {
	let dir: string;
	let backend: StorageBackend;
	let eventStore: EventStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "recovery-test-"));
		backend = createFsStorage(dir);
		await backend.init();
		eventStore = await createEventStore();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is a no-op when pending/ is empty", async () => {
		const handle = vi.fn();
		const consumer = makeConsumer(handle);
		const logger = makeLogger();
		const bus = createEventBus([consumer], { logger });
		await recover({ backend, eventStore, logger }, bus);
		expect(handle).not.toHaveBeenCalled();
	});

	it("replays pending events in seq order and synthesizes a trigger.error", async () => {
		// Seed pending/ as if the process died after seq 2.
		await backend.write(
			"pending/evt_a/000000.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_a/000001.json",
			JSON.stringify(event({ kind: "system.request", seq: 1, ref: 0 })),
		);
		await backend.write(
			"pending/evt_a/000002.json",
			JSON.stringify(event({ kind: "system.response", seq: 2, ref: 1 })),
		);

		const seen: InvocationEvent[] = [];
		const consumer = makeConsumer(async (e: InvocationEvent) => {
			seen.push(e);
		});
		const logger = makeLogger();
		const bus = createEventBus([consumer], { logger });

		await recover({ backend, eventStore, logger }, bus);

		expect(seen.map((e) => e.kind)).toEqual([
			"trigger.request",
			"system.request",
			"system.response",
			"trigger.error",
		]);
		const synthetic = seen[3];
		expect(synthetic?.seq).toBe(3);
		expect(synthetic?.ref).toBeNull();
		expect(synthetic?.workflow).toBe("wf");
		expect(synthetic?.workflowSha).toBe("sha");
		expect(synthetic?.error).toEqual({
			message: "engine crashed before invocation completed",
			kind: "engine_crashed",
		});
	});

	it("synthetic terminal reuses the last replayed event's ts", async () => {
		await backend.write(
			"pending/evt_a/000000.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0, ts: 0 })),
		);
		await backend.write(
			"pending/evt_a/000001.json",
			JSON.stringify(
				event({ kind: "system.request", seq: 1, ref: 0, ts: 4200 }),
			),
		);

		const seen: InvocationEvent[] = [];
		const consumer = makeConsumer(async (e: InvocationEvent) => {
			seen.push(e);
		});
		const logger = makeLogger();
		const bus = createEventBus([consumer], { logger });

		await recover({ backend, eventStore, logger }, bus);

		const synthetic = seen.at(-1);
		expect(synthetic?.kind).toBe("trigger.error");
		expect(synthetic?.ts).toBe(4200);
		expect(synthetic?.at).toMatch(ISO_DATE_PREFIX_RE);
	});

	it("groups by invocation id and recovers each independently", async () => {
		await backend.write(
			"pending/evt_a/000000.json",
			JSON.stringify(event({ id: "evt_a", kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_b/000000.json",
			JSON.stringify(event({ id: "evt_b", kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_b/000001.json",
			JSON.stringify(
				event({ id: "evt_b", kind: "system.request", seq: 1, ref: 0 }),
			),
		);

		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e: InvocationEvent) => {
				seen.push(e);
			},
		};
		const logger = makeLogger();

		await recover({ backend, eventStore, logger }, bus);

		const aEvents = seen.filter((e) => e.id === "evt_a");
		const bEvents = seen.filter((e) => e.id === "evt_b");
		expect(aEvents.map((e) => e.kind)).toEqual([
			"trigger.request",
			"trigger.error",
		]);
		expect(bEvents.map((e) => e.kind)).toEqual([
			"trigger.request",
			"system.request",
			"trigger.error",
		]);
	});

	it("skips replay and clears stale pending when archive is already in the event store", async () => {
		// Seed archive with a complete invocation (simulates successful archive
		// write from prior process).
		const archived: InvocationEvent[] = [
			event({ kind: "trigger.request", seq: 0 }),
			event({ kind: "system.request", seq: 1, ref: 0 }),
			event({ kind: "trigger.response", seq: 2, ref: 0, output: "ok" }),
		];
		await backend.write("archive/evt_a.json", JSON.stringify(archived));

		// Bootstrap event store from archive (mirrors main.ts startup order).
		const store = await createEventStore({ persistence: { backend } });
		await store.initialized;

		// Partial pending leftover (simulates crash during removePrefix).
		await backend.write(
			"pending/evt_a/000001.json",
			JSON.stringify(archived[1]),
		);
		await backend.write(
			"pending/evt_a/000002.json",
			JSON.stringify(archived[2]),
		);

		const logger = makeLogger();
		const busEmits: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e: InvocationEvent) => {
				busEmits.push(e);
			},
		};

		await recover({ backend, eventStore: store, logger }, bus);

		// No replay, no synthetic.
		expect(busEmits).toEqual([]);

		// Archive cleanup was logged.
		expect(logger.info).toHaveBeenCalledWith(
			"runtime.recovery.archive-cleanup",
			expect.objectContaining({ id: "evt_a", count: 2 }),
		);

		// Pending is cleared.
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		// Archive file is untouched.
		const archive = JSON.parse(await backend.read("archive/evt_a.json"));
		expect(archive).toHaveLength(3);
		expect(archive[2].kind).toBe("trigger.response");
	});

	it("end-to-end: recovery + persistence consumer archives the recovered events", async () => {
		await backend.write(
			"pending/evt_a/000000.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0 })),
		);

		const persistence = createPersistence(backend);
		const logger = makeLogger();
		const bus = createEventBus([persistence], { logger });

		await recover({ backend, eventStore, logger }, bus);

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive).toEqual(["archive/evt_a.json"]);

		const content = JSON.parse(await backend.read("archive/evt_a.json"));
		expect(content.map((e: InvocationEvent) => e.kind)).toEqual([
			"trigger.request",
			"trigger.error",
		]);
	});

	it("recover() never resolves when bus.emit never resolves (strict failure surface)", async () => {
		// Smoke test for the recovery side of the bus's strict-consumer
		// fatal-exit contract. systemShutdown side effects are covered in
		// event-bus/index.test.ts; here we only assert recovery's observable
		// behaviour: a non-resolving bus.emit causes recover() to also never
		// resolve.
		await backend.write(
			"pending/evt_a/000000.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0 })),
		);

		const logger = makeLogger();
		const bus: EventBus = {
			// Stub bus.emit to never resolve, mirroring what the real bus does
			// when a strict consumer throws.
			emit: vi.fn().mockReturnValue(new Promise(() => {})),
		};

		const settled = await Promise.race([
			recover({ backend, eventStore, logger }, bus).then(
				() => "resolved" as const,
				() => "rejected" as const,
			),
			new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 50)),
		]);
		expect(settled).toBe("timer");
		expect(bus.emit).toHaveBeenCalled();
	});
});
