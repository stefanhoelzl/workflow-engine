import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BusConsumer,
	createEventBus,
	type EventBus,
} from "./event-bus/index.js";
import { createPersistence } from "./event-bus/persistence.js";
import { recover } from "./recovery.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		ts: 100,
		workflow: "wf",
		workflowSha: "sha",
		name: "on-push",
		...overrides,
	} as InvocationEvent;
}

describe("recovery", () => {
	let dir: string;
	let backend: StorageBackend;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "recovery-test-"));
		backend = createFsStorage(dir);
		await backend.init();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is a no-op when pending/ is empty", async () => {
		const consumer: BusConsumer = { handle: vi.fn() };
		const bus = createEventBus([consumer]);
		await recover({ backend }, bus);
		expect(consumer.handle).not.toHaveBeenCalled();
	});

	it("replays pending events in seq order and synthesizes a trigger.error", async () => {
		// Seed pending/ as if the process died after seq 2.
		await backend.write(
			"pending/evt_a_0.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_a_1.json",
			JSON.stringify(event({ kind: "system.request", seq: 1, ref: 0 })),
		);
		await backend.write(
			"pending/evt_a_2.json",
			JSON.stringify(event({ kind: "system.response", seq: 2, ref: 1 })),
		);

		const seen: InvocationEvent[] = [];
		const consumer: BusConsumer = {
			handle: async (e: InvocationEvent) => {
				seen.push(e);
			},
		};
		const bus = createEventBus([consumer]);

		await recover({ backend }, bus);

		expect(seen.map((e) => e.kind)).toEqual([
			"trigger.request",
			"system.request",
			"system.response",
			"trigger.error",
		]);
		const synthetic = seen[3];
		expect(synthetic?.seq).toBe(3);
		expect(synthetic?.ref).toBe(0);
		expect(synthetic?.workflow).toBe("wf");
		expect(synthetic?.workflowSha).toBe("sha");
		expect(synthetic?.error).toBeDefined();
	});

	it("groups by invocation id and recovers each independently", async () => {
		await backend.write(
			"pending/evt_a_0.json",
			JSON.stringify(event({ id: "evt_a", kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_b_0.json",
			JSON.stringify(event({ id: "evt_b", kind: "trigger.request", seq: 0 })),
		);
		await backend.write(
			"pending/evt_b_1.json",
			JSON.stringify(
				event({ id: "evt_b", kind: "system.request", seq: 1, ref: 0 }),
			),
		);

		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			handle: async () => {
				/* unused */
			},
			emit: async (e: InvocationEvent) => {
				seen.push(e);
			},
		} as unknown as EventBus;

		await recover({ backend }, bus);

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

	it("end-to-end: recovery + persistence consumer archives the recovered events", async () => {
		await backend.write(
			"pending/evt_a_0.json",
			JSON.stringify(event({ kind: "trigger.request", seq: 0 })),
		);

		const persistence = createPersistence(backend);
		const bus = createEventBus([persistence]);

		await recover({ backend }, bus);

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive.sort()).toEqual([
			"archive/evt_a/0.json",
			"archive/evt_a/1.json",
		]);
	});
});
