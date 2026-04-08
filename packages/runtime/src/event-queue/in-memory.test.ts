import { describe, expect, it } from "vitest";
import { eventQueueContractTests } from "./event-queue.contract.js";
import { InMemoryEventQueue } from "./in-memory.js";
import type { Event } from "./index.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		...overrides,
	};
}

eventQueueContractTests(
	"InMemoryEventQueue",
	async () => new InMemoryEventQueue(),
);

describe("InMemoryEventQueue", () => {
	it("dequeues the exact same object reference", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		await queue.enqueue(event);
		const dequeued = await queue.dequeue();

		expect(dequeued).toBe(event);
	});

	it("constructor with initial events makes them dequeueable", async () => {
		const first = makeEvent({ id: "evt_first" });
		const second = makeEvent({ id: "evt_second" });
		const queue = new InMemoryEventQueue([first, second]);

		expect(await queue.dequeue()).toBe(first);
		expect(await queue.dequeue()).toBe(second);
	});

	it("constructor without events creates an empty queue", async () => {
		const queue = new InMemoryEventQueue();
		const event = makeEvent();

		const dequeuePromise = queue.dequeue();

		let resolved = false;
		dequeuePromise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		await queue.enqueue(event);
		expect(await dequeuePromise).toBe(event);
	});
});
