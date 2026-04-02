import { describe, expect, it, vi } from "vitest";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { createDispatchAction } from "./dispatch.js";
import type { Action } from "./index.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: "evt_original",
		type: "order.received",
		payload: { orderId: "123" },
		createdAt: new Date(),
		...overrides,
	};
}

describe("dispatch action", () => {
	it("fans out to multiple subscribers", async () => {
		const queue = new InMemoryEventQueue();
		const parseOrder: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler: vi.fn(),
		};
		const sendEmail: Action = {
			name: "sendEmail",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "sendEmail",
			handler: vi.fn(),
		};
		const actions = [parseOrder, sendEmail];
		const dispatch = createDispatchAction(actions, queue);
		actions.push(dispatch);

		const event = makeEvent();
		dispatch.handler(event);

		const first = await queue.dequeue();
		const second = await queue.dequeue();

		expect(first.type).toBe("order.received");
		expect(first.targetAction).toBe("parseOrder");
		expect(first.payload).toEqual({ orderId: "123" });
		expect(first.id).not.toBe("evt_original");

		expect(second.type).toBe("order.received");
		expect(second.targetAction).toBe("sendEmail");
		expect(second.payload).toEqual({ orderId: "123" });
		expect(second.id).not.toBe("evt_original");
	});

	it("enqueues nothing when there are zero subscribers", async () => {
		const queue = new InMemoryEventQueue();
		const unrelated: Action = {
			name: "updateInventory",
			match: (e) =>
				e.type === "order.shipped" && e.targetAction === "updateInventory",
			handler: vi.fn(),
		};
		const actions = [unrelated];
		const dispatch = createDispatchAction(actions, queue);
		actions.push(dispatch);

		const event = makeEvent({ type: "audit.log" });
		dispatch.handler(event);

		// Enqueue a marker event to verify nothing else is in the queue
		const marker = makeEvent({ id: "evt_marker" });
		await queue.enqueue(marker);
		expect((await queue.dequeue()).id).toBe("evt_marker");
	});

	it("does not dispatch to itself", async () => {
		const queue = new InMemoryEventQueue();
		const actions: Action[] = [];
		const dispatch = createDispatchAction(actions, queue);
		actions.push(dispatch);

		const event = makeEvent();
		dispatch.handler(event);

		// Enqueue a marker to verify queue is empty
		const marker = makeEvent({ id: "evt_marker" });
		await queue.enqueue(marker);
		expect((await queue.dequeue()).id).toBe("evt_marker");
	});

	it("matches only events with targetAction undefined", () => {
		const queue = new InMemoryEventQueue();
		const dispatch = createDispatchAction([], queue);

		expect(dispatch.match(makeEvent())).toBe(true);
		expect(dispatch.match(makeEvent({ targetAction: "parseOrder" }))).toBe(
			false,
		);
	});
});
