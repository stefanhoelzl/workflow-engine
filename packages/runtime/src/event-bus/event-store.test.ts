import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "./index.js";
import { type EventStore, createEventStore } from "./event-store.js";

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date("2025-01-01T12:00:00Z"),
		state: "pending",
		...overrides,
	};
}

let store: EventStore;

beforeEach(async () => {
	store = await createEventStore();
});

describe("EventStore", () => {
	describe("handle", () => {
		it("inserts event into the store", async () => {
			const event = makeEvent({ id: "evt_abc" });
			await store.handle(event);

			const rows = await store.query.where("id", "=", "evt_abc").selectAll().execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe("evt_abc");
			expect(rows[0]?.state).toBe("pending");
		});

		it("is append-only — same event ID with different states creates multiple rows", async () => {
			const event = makeEvent({ id: "evt_multi" });
			await store.handle({ ...event, state: "pending" });
			await store.handle({ ...event, state: "processing" });
			await store.handle({ ...event, state: "done" });

			const rows = await store.query.where("id", "=", "evt_multi").selectAll().execute();
			expect(rows).toHaveLength(3);
			expect(rows.map((r) => r.state)).toEqual(["pending", "processing", "done"]);
		});

		it("stores all RuntimeEvent fields", async () => {
			const event = makeEvent({
				id: "evt_full",
				type: "order.received",
				payload: { orderId: "123" },
				correlationId: "corr_xyz",
				parentEventId: "evt_parent",
				targetAction: "processOrder",
				state: "failed",
				error: "timeout",
			});
			await store.handle(event);

			const rows = await store.query.where("id", "=", "evt_full").selectAll().execute();
			expect(rows).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const row = rows[0]!
			expect(row.type).toBe("order.received");
			expect(row.correlationId).toBe("corr_xyz");
			expect(row.parentEventId).toBe("evt_parent");
			expect(row.targetAction).toBe("processOrder");
			expect(row.state).toBe("failed");
			expect(row.payload).toEqual({ orderId: "123" });
			expect(row.error).toBe("timeout");
		});

		it("does not throw on error (non-fatal)", async () => {
			const errorSpy = vi.fn();
			const errorStore = await createEventStore({ logger: { error: errorSpy } });

			// Insert a valid event first
			await errorStore.handle(makeEvent());

			// This should not throw — errors are logged
			expect(errorSpy).not.toHaveBeenCalled();
		});
	});

	describe("bootstrap", () => {
		it("bulk inserts all events", async () => {
			const events = [
				makeEvent({ id: "evt_1", correlationId: "corr_A" }),
				makeEvent({ id: "evt_2", correlationId: "corr_A" }),
				makeEvent({ id: "evt_3", correlationId: "corr_B" }),
			];
			await store.bootstrap(events);

			const rows = await store.query.selectAll().execute();
			expect(rows).toHaveLength(3);
		});

		it("inserts all events regardless of pending flag", async () => {
			const events = [
				makeEvent({ id: "evt_1", state: "pending" }),
				makeEvent({ id: "evt_1", state: "processing" }),
				makeEvent({ id: "evt_1", state: "done" }),
			];
			await store.bootstrap(events, { pending: false });

			const rows = await store.query.selectAll().execute();
			expect(rows).toHaveLength(3);
		});

		it("inserts all events with pending: true", async () => {
			const events = [
				makeEvent({ id: "evt_a", state: "done" }),
				makeEvent({ id: "evt_b", state: "pending" }),
			];
			await store.bootstrap(events, { pending: true });

			const rows = await store.query.selectAll().execute();
			expect(rows).toHaveLength(2);
		});

		it("handles empty array", async () => {
			await store.bootstrap([], { pending: true });
			const rows = await store.query.selectAll().execute();
			expect(rows).toHaveLength(0);
		});
	});

	describe("query", () => {
		it("filters by correlationId", async () => {
			await store.handle(makeEvent({ id: "evt_1", correlationId: "corr_A" }));
			await store.handle(makeEvent({ id: "evt_2", correlationId: "corr_A" }));
			await store.handle(makeEvent({ id: "evt_3", correlationId: "corr_B" }));

			const rows = await store.query.where("correlationId", "=", "corr_A").selectAll().execute();
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.correlationId === "corr_A")).toBe(true);
		});

		it("supports GROUP BY with aggregation via expression builder", async () => {
			await store.handle(makeEvent({ id: "evt_1", correlationId: "corr_A" }));
			await store.handle(makeEvent({ id: "evt_2", correlationId: "corr_A" }));
			await store.handle(makeEvent({ id: "evt_3", correlationId: "corr_A" }));
			await store.handle(makeEvent({ id: "evt_4", correlationId: "corr_B" }));
			await store.handle(makeEvent({ id: "evt_5", correlationId: "corr_B" }));

			const rows = await store.query
				.groupBy("correlationId")
				.select((eb) => [
					"correlationId",
					eb.fn.count("id").as("eventCount"),
				])
				.execute();

			expect(rows).toHaveLength(2);
			const corrA = rows.find((r) => r.correlationId === "corr_A");
			const corrB = rows.find((r) => r.correlationId === "corr_B");
			expect(Number(corrA?.eventCount)).toBe(3);
			expect(Number(corrB?.eventCount)).toBe(2);
		});

		it("supports min/max aggregation", async () => {
			await store.handle(makeEvent({ id: "evt_1", correlationId: "corr_A", createdAt: new Date("2025-01-01T10:00:00Z") }));
			await store.handle(makeEvent({ id: "evt_2", correlationId: "corr_A", createdAt: new Date("2025-01-01T12:00:00Z") }));

			const rows = await store.query
				.groupBy("correlationId")
				.select((eb) => [
					"correlationId",
					eb.fn.min("createdAt").as("firstTimestamp"),
					eb.fn.max("createdAt").as("lastTimestamp"),
				])
				.execute();

			expect(rows).toHaveLength(1);
			expect(rows[0]?.firstTimestamp).toBeTruthy();
			expect(rows[0]?.lastTimestamp).toBeTruthy();
		});
	});
});
