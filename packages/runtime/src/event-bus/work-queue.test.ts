import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./index.js";
import { createWorkQueue } from "./work-queue.js";

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	};
}

describe("WorkQueue", () => {
	describe("handle", () => {
		it("buffers pending events", async () => {
			const queue = createWorkQueue();
			const event = makeEvent({ state: "pending" });
			await queue.handle(event);

			const dequeued = await queue.dequeue();
			expect(dequeued.id).toBe(event.id);
		});

		it("ignores non-pending events", async () => {
			const queue = createWorkQueue();
			await queue.handle(makeEvent({ state: "processing" }));
			await queue.handle({ ...makeEvent(), state: "done", result: "succeeded" });
			await queue.handle({ ...makeEvent(), state: "done", result: "failed", error: "boom" });
			await queue.handle({ ...makeEvent(), state: "done", result: "skipped" });

			// Buffer should be empty — dequeue should block
			let resolved = false;
			const p = queue.dequeue().then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			// Clean up: resolve the pending dequeue
			await queue.handle(makeEvent({ state: "pending" }));
			await p;
		});

		it("resolves waiting dequeue when pending event arrives", async () => {
			const queue = createWorkQueue();
			const dequeuePromise = queue.dequeue();

			let resolved = false;
			dequeuePromise.then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			const event = makeEvent({ state: "pending" });
			await queue.handle(event);

			const dequeued = await dequeuePromise;
			expect(dequeued.id).toBe(event.id);
		});
	});

	describe("bootstrap", () => {
		it("buffers pending events", async () => {
			const queue = createWorkQueue();
			const event = makeEvent({ state: "pending" });
			await queue.bootstrap([event]);

			const dequeued = await queue.dequeue();
			expect(dequeued.id).toBe(event.id);
		});

		it("buffers processing events for retry", async () => {
			const queue = createWorkQueue();
			const event = makeEvent({ state: "processing" });
			await queue.bootstrap([event]);

			const dequeued = await queue.dequeue();
			expect(dequeued.id).toBe(event.id);
		});

		it("ignores terminal events", async () => {
			const queue = createWorkQueue();
			await queue.bootstrap([
				{ ...makeEvent(), state: "done", result: "succeeded" },
				{ ...makeEvent(), state: "done", result: "failed", error: "boom" },
				{ ...makeEvent(), state: "done", result: "skipped" },
			]);

			// Buffer should be empty
			let resolved = false;
			const p = queue.dequeue().then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			// Clean up
			await queue.handle(makeEvent({ state: "pending" }));
			await p;
		});

		it("skips archive batches (pending: false)", async () => {
			const queue = createWorkQueue();
			await queue.bootstrap(
				[makeEvent({ id: "evt_1", state: "pending" }), makeEvent({ id: "evt_2", state: "processing" })],
				{ pending: false },
			);

			// Buffer should be empty — archive batches are skipped
			let resolved = false;
			const p = queue.dequeue().then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			// Clean up
			await queue.handle(makeEvent({ state: "pending" }));
			await p;
		});

		it("buffers pending/processing from pending batches", async () => {
			const queue = createWorkQueue();
			await queue.bootstrap(
				[
					makeEvent({ id: "evt_a", state: "pending" }),
					makeEvent({ id: "evt_b", state: "processing" }),
					{ ...makeEvent({ id: "evt_c" }), state: "done", result: "succeeded" },
				],
				{ pending: true },
			);

			const d1 = await queue.dequeue();
			const d2 = await queue.dequeue();
			expect(d1.id).toBe("evt_a");
			expect(d2.id).toBe("evt_b");
		});
	});

	describe("dequeue", () => {
		it("returns buffered event immediately", async () => {
			const queue = createWorkQueue();
			const event = makeEvent();
			await queue.handle(event);

			const dequeued = await queue.dequeue();
			expect(dequeued.id).toBe(event.id);
		});

		it("blocks when buffer is empty", async () => {
			const queue = createWorkQueue();
			let resolved = false;
			const p = queue.dequeue().then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			await queue.handle(makeEvent());
			await p;
			expect(resolved).toBe(true);
		});

		it("serves multiple waiters in FIFO order", async () => {
			const queue = createWorkQueue();
			const first = makeEvent({ id: "evt_first" });
			const second = makeEvent({ id: "evt_second" });

			const d1 = queue.dequeue();
			const d2 = queue.dequeue();

			await queue.handle(first);
			await queue.handle(second);

			expect((await d1).id).toBe("evt_first");
			expect((await d2).id).toBe("evt_second");
		});

		it("rejects with AbortError when signal is aborted", async () => {
			const queue = createWorkQueue();
			const ac = new AbortController();
			const dequeuePromise = queue.dequeue(ac.signal);

			ac.abort();

			await expect(dequeuePromise).rejects.toThrow();
		});

		it("resolves before abort when event arrives first", async () => {
			const queue = createWorkQueue();
			const ac = new AbortController();
			const event = makeEvent();

			const dequeuePromise = queue.dequeue(ac.signal);
			await queue.handle(event);

			const dequeued = await dequeuePromise;
			expect(dequeued.id).toBe(event.id);

			// Abort after resolve — should be a no-op
			ac.abort();
		});

		it("cleans up waiter on abort", async () => {
			const queue = createWorkQueue();
			const ac = new AbortController();
			const dequeuePromise = queue.dequeue(ac.signal);

			ac.abort();
			await dequeuePromise.catch(() => { /* expected */ });

			// Subsequent event should not resolve the aborted promise
			const event = makeEvent();
			await queue.handle(event);

			// The event should be buffered, not consumed by aborted waiter
			const dequeued = await queue.dequeue();
			expect(dequeued.id).toBe(event.id);
		});
	});

	it("does not expose an enqueue method", () => {
		const queue = createWorkQueue();
		expect("enqueue" in queue).toBe(false);
	});
});
