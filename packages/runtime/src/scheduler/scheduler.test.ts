import { describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { Scheduler } from "./index.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "order.received",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		...overrides,
	};
}

function stubContextFactory(event: Event): ActionContext {
	return new ActionContext(event, vi.fn(), vi.fn() as unknown as typeof globalThis.fetch);
}

describe("Scheduler", () => {
	it("executes matching action and acks event", async () => {
		const queue = new InMemoryEventQueue();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory);

		const event = makeEvent({ targetAction: "parseOrder" });
		await queue.enqueue(event);

		scheduler.start();

		// Give the loop a tick to process
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		// Enqueue a dummy event to unblock dequeue so the loop exits
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls.at(0)?.at(0)).toBeInstanceOf(ActionContext);
		expect(handler.mock.calls.at(0)?.at(0).event).toBe(event);
	});

	it("fails event when action throws", async () => {
		const queue = new InMemoryEventQueue();
		const action: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			// biome-ignore lint/suspicious/useAwait: handler interface requires async
			handler: async () => {
				throw new Error("boom");
			},
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory);

		const event = makeEvent({ targetAction: "parseOrder" });
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		// Event should not be available for dequeue (it's failed, not pending)
		const marker = makeEvent({ id: "evt_marker" });
		await queue.enqueue(marker);
		const next = await queue.dequeue();
		expect(next.id).toBe("evt_marker");
	});

	it("acks event when no action matches", async () => {
		const queue = new InMemoryEventQueue();
		const action: Action = {
			name: "parseOrder",
			match: () => false,
			handler: vi.fn(),
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory);

		const event = makeEvent();
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(action.handler).not.toHaveBeenCalled();
	});

	it("fails event when multiple actions match", async () => {
		const queue = new InMemoryEventQueue();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		const action1: Action = {
			name: "action1",
			match: () => true,
			handler: handler1,
		};
		const action2: Action = {
			name: "action2",
			match: () => true,
			handler: handler2,
		};
		const scheduler = new Scheduler(
			queue,
			[action1, action2],
			stubContextFactory,
		);

		const event = makeEvent();
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();
	});

	it("start and stop control the loop", async () => {
		const queue = new InMemoryEventQueue();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) => e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory);

		scheduler.start();
		scheduler.stop();
		// Enqueue a dummy to unblock dequeue
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		// Enqueue after stop — should not be processed
		await queue.enqueue(makeEvent({ targetAction: "parseOrder" }));
		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});
});
