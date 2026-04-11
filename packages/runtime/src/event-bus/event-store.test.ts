import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore, sql } from "./event-store.js";
import type { RuntimeEvent } from "./index.js";

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date("2025-01-01T12:00:00Z"),
		emittedAt: new Date("2025-01-01T12:00:00Z"),
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	} as RuntimeEvent;
}

// Helper: simple query via a pass-through CTE — where(1, "=", 1) is a no-op filter
function queryAll(store: EventStore) {
	return store.with("q", (e) => e.selectAll()).where(sql`1`, "=", 1);
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

			const rows = await store
				.with("q", (e) => e.selectAll())
				.where("id", "=", "evt_abc")
				.selectAll()
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe("evt_abc");
			expect(rows[0]?.state).toBe("pending");
		});

		it("is append-only — same event ID with different states creates multiple rows", async () => {
			const event = makeEvent({ id: "evt_multi" });
			await store.handle({ ...event, state: "pending" });
			await store.handle({ ...event, state: "processing" });
			await store.handle({ ...event, state: "done", result: "succeeded" });

			const rows = await store
				.with("q", (e) => e.selectAll())
				.where("id", "=", "evt_multi")
				.selectAll()
				.execute();
			expect(rows).toHaveLength(3);
			expect(
				// biome-ignore lint/suspicious/noExplicitAny: untyped CTE query result
				rows.map((r: any) => r.state),
			).toEqual(["pending", "processing", "done"]);
		});

		it("stores all RuntimeEvent fields", async () => {
			const event: RuntimeEvent = {
				id: "evt_full",
				type: "order.received",
				payload: { orderId: "123" },
				correlationId: "corr_xyz",
				parentEventId: "evt_parent",
				targetAction: "processOrder",
				createdAt: new Date("2025-01-01T12:00:00Z"),
				emittedAt: new Date("2025-01-01T12:00:01Z"),
				startedAt: new Date("2025-01-01T12:00:00.500Z"),
				doneAt: new Date("2025-01-01T12:00:01Z"),
				state: "done",
				result: "failed",
				error: { message: "timeout", stack: "" },
				sourceType: "trigger",
				sourceName: "orders",
			};
			await store.handle(event);

			const rows = await store
				.with("q", (e) => e.selectAll())
				.where("id", "=", "evt_full")
				.selectAll()
				.execute();
			expect(rows).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			// biome-ignore lint/suspicious/noExplicitAny: untyped CTE query result
			const row = rows[0]! as any;
			expect(row.type).toBe("order.received");
			expect(row.correlationId).toBe("corr_xyz");
			expect(row.parentEventId).toBe("evt_parent");
			expect(row.targetAction).toBe("processOrder");
			expect(row.state).toBe("done");
			expect(row.result).toBe("failed");
			expect(row.payload).toEqual({ orderId: "123" });
			expect(row.error).toEqual({ message: "timeout", stack: "" });
		});

		it("does not throw on error (non-fatal)", async () => {
			const errorSpy = vi.fn();
			const errorStore = await createEventStore({
				logger: { error: errorSpy },
			});

			await errorStore.handle(makeEvent());
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

			const rows = await queryAll(store).selectAll().execute();
			expect(rows).toHaveLength(3);
		});

		it("inserts all events regardless of pending flag", async () => {
			const events: RuntimeEvent[] = [
				makeEvent({ id: "evt_1", state: "pending" }),
				makeEvent({ id: "evt_1", state: "processing" }),
				{ ...makeEvent({ id: "evt_1" }), state: "done", result: "succeeded" },
			];
			await store.bootstrap(events, { pending: false });

			const rows = await queryAll(store).selectAll().execute();
			expect(rows).toHaveLength(3);
		});

		it("inserts all events with pending: true", async () => {
			const events: RuntimeEvent[] = [
				{ ...makeEvent({ id: "evt_a" }), state: "done", result: "succeeded" },
				makeEvent({ id: "evt_b", state: "pending" }),
			];
			await store.bootstrap(events, { pending: true });

			const rows = await queryAll(store).selectAll().execute();
			expect(rows).toHaveLength(2);
		});

		it("handles empty array", async () => {
			await store.bootstrap([], { pending: true });
			const rows = await queryAll(store).selectAll().execute();
			expect(rows).toHaveLength(0);
		});
	});

	describe("with (CTE queries)", () => {
		it("supports CTE with ROW_NUMBER for latest state", async () => {
			await store.handle(
				makeEvent({
					id: "evt_1",
					state: "pending",
					createdAt: new Date("2025-01-01T10:00:00Z"),
				}),
			);
			await store.handle(
				makeEvent({
					id: "evt_1",
					state: "processing",
					createdAt: new Date("2025-01-01T10:01:00Z"),
				}),
			);
			await store.handle(
				makeEvent({
					id: "evt_1",
					state: "done",
					createdAt: new Date("2025-01-01T10:02:00Z"),
				}),
			);

			const rows = await store
				.with("latest", (events) =>
					events
						.selectAll()
						.select(
							sql`ROW_NUMBER() OVER (PARTITION BY id ORDER BY "createdAt" DESC)`.as(
								"rn",
							),
						),
				)
				.where("rn", "=", 1)
				.selectAll()
				.execute();

			expect(rows).toHaveLength(1);
			// biome-ignore lint/suspicious/noExplicitAny: untyped CTE query result
			expect((rows[0] as any)?.state).toBe("done");
		});

		it("supports chained CTEs", async () => {
			await store.handle(
				makeEvent({
					id: "evt_1",
					correlationId: "corr_A",
					state: "pending",
					createdAt: new Date("2025-01-01T10:00:00Z"),
				}),
			);
			await store.handle(
				makeEvent({
					id: "evt_1",
					correlationId: "corr_A",
					state: "done",
					createdAt: new Date("2025-01-01T10:01:00Z"),
				}),
			);
			await store.handle({
				...makeEvent({
					id: "evt_2",
					correlationId: "corr_B",
					createdAt: new Date("2025-01-01T10:02:00Z"),
				}),
				state: "done",
				result: "failed",
				error: { message: "boom", stack: "" },
			} as RuntimeEvent);

			const rows = await store
				.with("latest", (events) =>
					events
						.selectAll()
						.select(
							sql`ROW_NUMBER() OVER (PARTITION BY id ORDER BY "createdAt" DESC)`.as(
								"rn",
							),
						),
				)
				.with("current_events", (latest) =>
					latest.selectAll().where("rn", "=", 1),
				)
				.where(sql`1`, "=", 1)
				.select(["correlationId", "state"])
				.execute();

			expect(rows).toHaveLength(2);
		});
	});
});
