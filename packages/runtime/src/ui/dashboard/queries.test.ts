import { beforeEach, describe, expect, it } from "vitest";
import {
	createEventStore,
	type EventStore,
} from "../../event-bus/event-store.js";
import type { RuntimeEvent } from "../../event-bus/index.js";
import {
	getDistinctEventTypes,
	getHeaderStats,
	getTimeline,
	listCorrelations,
} from "./queries.js";

let seq = 0;
function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	seq++;
	const ts = new Date(`2025-01-01T10:00:${String(seq).padStart(2, "0")}Z`);
	return {
		id: `evt_${seq}`,
		type: "test.event",
		payload: {},
		correlationId: "corr_1",
		createdAt: ts,
		emittedAt: overrides.createdAt ?? ts,
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	} as RuntimeEvent;
}

let store: EventStore;

beforeEach(async () => {
	seq = 0;
	store = await createEventStore();
});

async function seedEvents() {
	// corr_A: order.created chain — all done
	await store.handle(
		makeEvent({
			id: "e1",
			correlationId: "corr_A",
			type: "order.created",
			state: "pending",
			createdAt: new Date("2025-01-01T10:00:00Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e1",
			correlationId: "corr_A",
			type: "order.created",
			state: "done",
			result: "succeeded",
			createdAt: new Date("2025-01-01T10:00:01Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e2",
			correlationId: "corr_A",
			type: "order.validated",
			state: "pending",
			parentEventId: "e1",
			targetAction: "validate",
			createdAt: new Date("2025-01-01T10:00:02Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e2",
			correlationId: "corr_A",
			type: "order.validated",
			state: "done",
			result: "succeeded",
			parentEventId: "e1",
			targetAction: "validate",
			createdAt: new Date("2025-01-01T10:00:03Z"),
		}),
	);

	// corr_B: user.signup chain — has a pending event
	await store.handle(
		makeEvent({
			id: "e3",
			correlationId: "corr_B",
			type: "user.signup",
			state: "pending",
			createdAt: new Date("2025-01-01T10:01:00Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e3",
			correlationId: "corr_B",
			type: "user.signup",
			state: "done",
			result: "succeeded",
			createdAt: new Date("2025-01-01T10:01:01Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e4",
			correlationId: "corr_B",
			type: "welcome.email",
			state: "pending",
			parentEventId: "e3",
			targetAction: "send-email",
			createdAt: new Date("2025-01-01T10:01:02Z"),
		}),
	);

	// corr_C: cronitor.check chain — has a failed event
	await store.handle(
		makeEvent({
			id: "e5",
			correlationId: "corr_C",
			type: "cronitor.check",
			state: "pending",
			createdAt: new Date("2025-01-01T10:02:00Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e5",
			correlationId: "corr_C",
			type: "cronitor.check",
			state: "done",
			result: "succeeded",
			createdAt: new Date("2025-01-01T10:02:01Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e6",
			correlationId: "corr_C",
			type: "notification.send",
			state: "pending",
			parentEventId: "e5",
			targetAction: "send-slack",
			createdAt: new Date("2025-01-01T10:02:02Z"),
		}),
	);
	await store.handle(
		makeEvent({
			id: "e6",
			correlationId: "corr_C",
			type: "notification.send",
			state: "done",
			result: "failed",
			parentEventId: "e5",
			targetAction: "send-slack",
			error: { message: "rate limited", stack: "" },
			createdAt: new Date("2025-01-01T10:02:03Z"),
		}),
	);
}

describe("listCorrelations", () => {
	it("returns correlation summaries with aggregate state", async () => {
		await seedEvents();
		const result = await listCorrelations(store);

		expect(result.items).toHaveLength(3);

		const corrA = result.items.find((i) => i.correlationId === "corr_A");
		expect(corrA?.aggregateState).toBe("done");
		expect(corrA?.initialEventType).toBe("order.created");
		expect(corrA?.eventCount).toBe(2);

		const corrB = result.items.find((i) => i.correlationId === "corr_B");
		expect(corrB?.aggregateState).toBe("pending");
		expect(corrB?.initialEventType).toBe("user.signup");
		expect(corrB?.eventCount).toBe(2);

		const corrC = result.items.find((i) => i.correlationId === "corr_C");
		expect(corrC?.aggregateState).toBe("failed");
		expect(corrC?.initialEventType).toBe("cronitor.check");
		expect(corrC?.eventCount).toBe(2);
	});

	it("sorts pending first, then by time descending", async () => {
		await seedEvents();
		const result = await listCorrelations(store);

		expect(result.items[0]?.correlationId).toBe("corr_B"); // pending first
	});

	it("filters by state", async () => {
		await seedEvents();

		const pending = await listCorrelations(store, { state: "pending" });
		expect(pending.items).toHaveLength(1);
		expect(pending.items[0]?.correlationId).toBe("corr_B");

		const failed = await listCorrelations(store, { state: "failed" });
		expect(failed.items).toHaveLength(1);
		expect(failed.items[0]?.correlationId).toBe("corr_C");

		const done = await listCorrelations(store, { state: "done" });
		expect(done.items).toHaveLength(1);
		expect(done.items[0]?.correlationId).toBe("corr_A");
	});

	it("filters by event type", async () => {
		await seedEvents();
		const result = await listCorrelations(store, { type: "order.created" });

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.correlationId).toBe("corr_A");
	});

	it("supports pagination", async () => {
		await seedEvents();

		const page1 = await listCorrelations(store, { limit: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page1.nextCursor).toBe("2");

		const page2 = await listCorrelations(store, {
			limit: 2,
			cursor: page1.nextCursor ?? undefined,
		});
		expect(page2.items).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
	});

	it("returns empty list when no events", async () => {
		const result = await listCorrelations(store);
		expect(result.items).toHaveLength(0);
		expect(result.nextCursor).toBeNull();
	});
});

describe("getTimeline", () => {
	it("returns all events for a correlationId with latest state", async () => {
		await seedEvents();
		const events = await getTimeline(store, "corr_A");

		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("order.created");
		expect(events[0]?.state).toBe("done");
		expect(events[1]?.type).toBe("order.validated");
		expect(events[1]?.state).toBe("done");
		expect(events[1]?.parentEventId).toBe("e1");
		expect(events[1]?.targetAction).toBe("validate");
	});

	it("includes error field for failed events", async () => {
		await seedEvents();
		const events = await getTimeline(store, "corr_C");

		const failed = events.find((e) => e.result === "failed");
		expect(failed?.error).toEqual({ message: "rate limited", stack: "" });
	});

	it("returns empty array for unknown correlationId", async () => {
		await seedEvents();
		const events = await getTimeline(store, "corr_nonexistent");
		expect(events).toHaveLength(0);
	});

	it("orders by emittedAt ascending", async () => {
		await seedEvents();
		const events = await getTimeline(store, "corr_A");

		const times = events.map((e) => e.emittedAt);
		expect((times[0] ?? "") < (times[1] ?? "")).toBe(true);
	});
});

describe("getDistinctEventTypes", () => {
	it("returns distinct root event types", async () => {
		await seedEvents();
		const types = await getDistinctEventTypes(store);

		expect(types).toEqual(["cronitor.check", "order.created", "user.signup"]);
	});

	it("excludes non-root events", async () => {
		await seedEvents();
		const types = await getDistinctEventTypes(store);

		expect(types).not.toContain("order.validated");
		expect(types).not.toContain("welcome.email");
		expect(types).not.toContain("notification.send");
	});

	it("returns empty array when no events", async () => {
		const types = await getDistinctEventTypes(store);
		expect(types).toHaveLength(0);
	});
});

describe("getHeaderStats", () => {
	it("returns counts per aggregate state", async () => {
		await seedEvents();
		const stats = await getHeaderStats(store);

		expect(stats.pending).toBe(1);
		expect(stats.failed).toBe(1);
		expect(stats.done).toBe(1);
	});

	it("returns zeros when no events", async () => {
		const stats = await getHeaderStats(store);
		expect(stats).toEqual({ pending: 0, failed: 0, done: 0 });
	});
});
