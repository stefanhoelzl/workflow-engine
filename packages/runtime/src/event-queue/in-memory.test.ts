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

	describe("AbortSignal", () => {
		it("rejects with AbortError when signal is aborted", async () => {
			const queue = new InMemoryEventQueue();
			const ac = new AbortController();

			const dequeuePromise = queue.dequeue(ac.signal);
			ac.abort();

			await expect(dequeuePromise).rejects.toThrow();
			await expect(dequeuePromise).rejects.toSatisfy(
				(e: Error) => e.name === "AbortError",
			);
		});

		it("removes waiter from queue on abort", async () => {
			const queue = new InMemoryEventQueue();
			const ac = new AbortController();

			const abortedDequeue = queue.dequeue(ac.signal);
			ac.abort();
			await abortedDequeue.catch(() => { /* expected */ });

			// Enqueue an event — it should not resolve the aborted waiter
			const event = makeEvent();
			await queue.enqueue(event);

			// A new dequeue should get the event
			const result = await queue.dequeue();
			expect(result).toBe(event);
		});

		it("resolves normally when event arrives before abort", async () => {
			const queue = new InMemoryEventQueue();
			const ac = new AbortController();
			const event = makeEvent();

			const dequeuePromise = queue.dequeue(ac.signal);
			await queue.enqueue(event);

			const result = await dequeuePromise;
			expect(result).toBe(event);

			// Aborting after resolve should not cause issues
			ac.abort();
		});
	});
});
