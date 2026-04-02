import { describe, expect, it } from "vitest";
import { InMemoryEventQueue } from "./in-memory.js";
import type { Event } from "./index.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: {},
		createdAt: new Date(),
		...overrides,
	};
}

describe("InMemoryEventQueue", () => {
	it("enqueues and dequeues an event", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		await queue.enqueue(event);
		const dequeued = await queue.dequeue();

		expect(dequeued).toBe(event);
	});

	it("dequeues events in FIFO order", async () => {
		const queue = new InMemoryEventQueue();
		const first = makeEvent({ id: "evt_first" });
		const second = makeEvent({ id: "evt_second" });

		await queue.enqueue(first);
		await queue.enqueue(second);

		expect(await queue.dequeue()).toBe(first);
		expect(await queue.dequeue()).toBe(second);
	});

	it("ack marks event as done", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		await queue.enqueue(event);
		await queue.dequeue();
		await queue.ack(event.id);

		// The event should not be dequeued again — enqueue another to verify
		const second = makeEvent({ id: "evt_second" });
		await queue.enqueue(second);
		expect(await queue.dequeue()).toBe(second);
	});

	it("fail marks event as failed", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		await queue.enqueue(event);
		await queue.dequeue();
		await queue.fail(event.id);

		// The event should not be dequeued again
		const second = makeEvent({ id: "evt_second" });
		await queue.enqueue(second);
		expect(await queue.dequeue()).toBe(second);
	});

	it("blocking dequeue resolves when an event is enqueued", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		const dequeuePromise = queue.dequeue();

		// Should not have resolved yet
		let resolved = false;
		dequeuePromise.then(() => {
			resolved = true;
		});
		await Promise.resolve(); // flush microtasks
		expect(resolved).toBe(false);

		await queue.enqueue(event);

		const dequeued = await dequeuePromise;
		expect(dequeued).toBe(event);
	});

	it("multiple waiters are served in order", async () => {
		const queue = new InMemoryEventQueue();
		const first = makeEvent({ id: "evt_first" });
		const second = makeEvent({ id: "evt_second" });

		const dequeue1 = queue.dequeue();
		const dequeue2 = queue.dequeue();

		await queue.enqueue(first);
		await queue.enqueue(second);

		expect(await dequeue1).toBe(first);
		expect(await dequeue2).toBe(second);
	});
});
