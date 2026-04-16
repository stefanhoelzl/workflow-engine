import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "../storage/fs.js";
import type { StorageBackend } from "../storage/index.js";
import { createEventStore, type EventStore } from "./event-store.js";

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		ts: Date.parse("2026-04-16T10:00:00Z"),
		workflow: "wf",
		workflowSha: "sha",
		name: "on-push",
		...overrides,
	} as InvocationEvent;
}

describe("event store", () => {
	let store: EventStore;

	beforeEach(async () => {
		store = await createEventStore();
	});

	it("inserts a row for each handled event", async () => {
		await store.handle(event({ kind: "trigger.request", input: { x: 1 } }));
		const rows = await store.query.selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "evt_a",
			seq: 0,
			kind: "trigger.request",
			ref: null,
			workflow: "wf",
			workflowSha: "sha",
			name: "on-push",
		});
	});

	it("appends rows — does not update on subsequent emits", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		await store.handle(
			event({ kind: "trigger.response", seq: 1, ref: 0, output: "ok" }),
		);
		const rows = await store.query.selectAll().orderBy("seq", "asc").execute();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.kind)).toEqual([
			"trigger.request",
			"trigger.response",
		]);
	});

	it("rejects duplicate (id, seq) but logs and continues", async () => {
		const logger = { error: vi.fn() };
		const s = await createEventStore({ logger });
		await s.handle(event({ kind: "trigger.request", seq: 0 }));
		await s.handle(event({ kind: "trigger.request", seq: 0 }));
		expect(logger.error).toHaveBeenCalledWith(
			"event-store.insert-failed",
			expect.objectContaining({ id: "evt_a", seq: 0 }),
		);
	});

	it("supports the dashboard summary query (join trigger.request with terminal)", async () => {
		await store.handle(event({ kind: "trigger.request", seq: 0 }));
		await store.handle(
			event({
				kind: "trigger.response",
				seq: 1,
				ref: 0,
				output: { status: 200 },
				ts: Date.parse("2026-04-16T10:00:01Z"),
			}),
		);
		await store.handle(
			event({
				id: "evt_b",
				kind: "trigger.request",
				seq: 0,
				name: "another",
			}),
		);

		const requests = await store.query
			.where("kind", "=", "trigger.request")
			.select(["id", "name"])
			.orderBy("ts", "asc")
			.execute();
		expect(requests).toHaveLength(2);
		expect(requests.map((r) => r.id)).toEqual(["evt_a", "evt_b"]);

		const responses = await store.query
			.where("kind", "in", ["trigger.response", "trigger.error"])
			.select(["id", "kind"])
			.execute();
		expect(responses).toHaveLength(1);
		expect(responses[0]?.id).toBe("evt_a");
	});

	it("bootstraps from archived events on init", async () => {
		const dir = await mkdtemp(join(tmpdir(), "event-store-test-"));
		try {
			const backend: StorageBackend = createFsStorage(dir);
			await backend.init();
			const evt: InvocationEvent = event({
				kind: "trigger.request",
				input: { hello: "world" },
			});
			await backend.write(
				`archive/${evt.id}/${evt.seq}.json`,
				JSON.stringify(evt),
			);

			const s = await createEventStore({ persistence: { backend } });
			await s.initialized;

			const rows = await s.query.selectAll().execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("trigger.request");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		// in-memory DuckDB instance is GC'd with the store
	});
});
