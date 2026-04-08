import { describe, expect, it } from "vitest";
import type { Event, EventQueue } from "./index.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: { data: "test" },
		correlationId: "corr_test",
		createdAt: new Date(),
		...overrides,
	};
}

function enqueueDequeueTests(factory: () => Promise<EventQueue>) {
	it("enqueues and dequeues an event", async () => {
		const queue = await factory();
		const event = makeEvent();
		await queue.enqueue(event);
		const dequeued = await queue.dequeue();
		expect(dequeued.id).toBe(event.id);
		expect(dequeued.type).toBe(event.type);
	});

	it("blocking dequeue resolves when an event is enqueued", async () => {
		const queue = await factory();
		const event = makeEvent();
		const dequeuePromise = queue.dequeue();
		let resolved = false;
		dequeuePromise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		await queue.enqueue(event);
		const dequeued = await dequeuePromise;
		expect(dequeued.id).toBe(event.id);
	});

	it("multiple waiters are served in order", async () => {
		const queue = await factory();
		const first = makeEvent({ id: "evt_first" });
		const second = makeEvent({ id: "evt_second" });
		const dequeue1 = queue.dequeue();
		const dequeue2 = queue.dequeue();
		await queue.enqueue(first);
		await queue.enqueue(second);
		expect((await dequeue1).id).toBe(first.id);
		expect((await dequeue2).id).toBe(second.id);
	});
}

function ackFailTests(factory: () => Promise<EventQueue>) {
	it("ack marks event as done", async () => {
		const queue = await factory();
		const event = makeEvent();
		await queue.enqueue(event);
		await queue.dequeue();
		await queue.ack(event.id);
		const second = makeEvent({ id: "evt_second" });
		await queue.enqueue(second);
		expect((await queue.dequeue()).id).toBe(second.id);
	});

	it("fail marks event as failed", async () => {
		const queue = await factory();
		const event = makeEvent();
		await queue.enqueue(event);
		await queue.dequeue();
		await queue.fail(event.id);
		const second = makeEvent({ id: "evt_second" });
		await queue.enqueue(second);
		expect((await queue.dequeue()).id).toBe(second.id);
	});
}

export function eventQueueContractTests(
	name: string,
	factory: () => Promise<EventQueue>,
) {
	describe(`${name} (contract)`, () => {
		enqueueDequeueTests(factory);
		ackFailTests(factory);
	});
}
