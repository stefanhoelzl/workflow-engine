import { describe, expect, it, vi } from "vitest";
import {
	type BusConsumer,
	createEventBus,
	type InvocationLifecycleEvent,
} from "./index.js";

function makeStartedEvent(
	overrides: Partial<InvocationLifecycleEvent> = {},
): InvocationLifecycleEvent {
	return {
		kind: "started",
		id: `evt_${crypto.randomUUID()}`,
		workflow: "w1",
		trigger: "t1",
		ts: new Date(),
		input: {},
		...overrides,
	} as InvocationLifecycleEvent;
}

function mockConsumer(overrides?: Partial<BusConsumer>): BusConsumer {
	return {
		handle: overrides?.handle ?? vi.fn<BusConsumer["handle"]>(),
	};
}

describe("createEventBus", () => {
	describe("emit", () => {
		it("calls handle on all consumers in registration order", async () => {
			const order: string[] = [];
			const a = mockConsumer({
				handle: async () => {
					order.push("a");
				},
			});
			const b = mockConsumer({
				handle: async () => {
					order.push("b");
				},
			});
			const c = mockConsumer({
				handle: async () => {
					order.push("c");
				},
			});
			const bus = createEventBus([a, b, c]);

			await bus.emit(makeStartedEvent());

			expect(order).toEqual(["a", "b", "c"]);
		});

		it("dispatches consumers sequentially (awaits each before next)", async () => {
			const events: string[] = [];
			const a = mockConsumer({
				handle: async () => {
					events.push("a:start");
					await new Promise((resolve) => setTimeout(resolve, 10));
					events.push("a:end");
				},
			});
			const b = mockConsumer({
				handle: async () => {
					events.push("b:start");
					events.push("b:end");
				},
			});
			const bus = createEventBus([a, b]);

			await bus.emit(makeStartedEvent());

			expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
		});

		it("passes the event to each consumer", async () => {
			const consumer = mockConsumer();
			const bus = createEventBus([consumer]);

			const event = makeStartedEvent();
			await bus.emit(event);

			expect(consumer.handle).toHaveBeenCalledWith(event);
		});

		it("propagates consumer error and stops fan-out", async () => {
			const a = mockConsumer({
				handle: async () => {
					throw new Error("consumer A failed");
				},
			});
			const b = mockConsumer();
			const bus = createEventBus([a, b]);

			await expect(bus.emit(makeStartedEvent())).rejects.toThrow(
				"consumer A failed",
			);
			expect(b.handle).not.toHaveBeenCalled();
		});

		it("awaits all consumers before resolving", async () => {
			let lastResolved = false;
			const slow = mockConsumer({
				handle: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					lastResolved = true;
				},
			});
			const bus = createEventBus([slow]);

			await bus.emit(makeStartedEvent());
			expect(lastResolved).toBe(true);
		});

		it("works with empty consumer list", async () => {
			const bus = createEventBus([]);
			await expect(bus.emit(makeStartedEvent())).resolves.toBeUndefined();
		});
	});
});
