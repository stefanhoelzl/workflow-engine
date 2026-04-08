import { describe, expect, it, vi } from "vitest";
import { type BusConsumer, type RuntimeEvent, createEventBus } from "./index.js";

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "test.event",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	} as RuntimeEvent;
}

function mockConsumer(overrides?: Partial<BusConsumer>): BusConsumer {
	return {
		handle: overrides?.handle ?? vi.fn<BusConsumer["handle"]>(),
		bootstrap: overrides?.bootstrap ?? vi.fn<BusConsumer["bootstrap"]>(),
	};
}

describe("createEventBus", () => {
	describe("emit", () => {
		it("calls handle on all consumers in registration order", async () => {
			const order: string[] = [];
			const a = mockConsumer({
				async handle() {
					order.push("a");
				},
			});
			const b = mockConsumer({
				async handle() {
					order.push("b");
				},
			});
			const c = mockConsumer({
				async handle() {
					order.push("c");
				},
			});
			const bus = createEventBus([a, b, c]);

			await bus.emit(makeEvent());

			expect(order).toEqual(["a", "b", "c"]);
		});

		it("passes the event to each consumer", async () => {
			const consumer = mockConsumer();
			const bus = createEventBus([consumer]);

			const event = makeEvent();
			await bus.emit(event);

			expect(consumer.handle).toHaveBeenCalledWith(event);
		});

		it("propagates consumer error and stops fan-out", async () => {
			const a = mockConsumer({
				async handle() {
					throw new Error("consumer A failed");
				},
			});
			const b = mockConsumer();
			const bus = createEventBus([a, b]);

			await expect(bus.emit(makeEvent())).rejects.toThrow("consumer A failed");
			expect(b.handle).not.toHaveBeenCalled();
		});

		it("works with empty consumer list", async () => {
			const bus = createEventBus([]);
			await expect(bus.emit(makeEvent())).resolves.toBeUndefined();
		});
	});

	describe("bootstrap", () => {
		it("calls bootstrap on all consumers in registration order", async () => {
			const order: string[] = [];
			const a = mockConsumer({
				async bootstrap() {
					order.push("a");
				},
			});
			const b = mockConsumer({
				async bootstrap() {
					order.push("b");
				},
			});
			const bus = createEventBus([a, b]);

			await bus.bootstrap([makeEvent()]);

			expect(order).toEqual(["a", "b"]);
		});

		it("passes events and options to each consumer", async () => {
			const consumer = mockConsumer();
			const bus = createEventBus([consumer]);

			const events = [makeEvent()];
			await bus.bootstrap(events, { finished: true });

			expect(consumer.bootstrap).toHaveBeenCalledWith(events, { finished: true });
		});

		it("passes finished signal through", async () => {
			const consumer = mockConsumer();
			const bus = createEventBus([consumer]);

			await bus.bootstrap([], { finished: true });

			expect(consumer.bootstrap).toHaveBeenCalledWith([], { finished: true });
		});

		it("propagates consumer error and stops fan-out", async () => {
			const a = mockConsumer({
				async bootstrap() {
					throw new Error("bootstrap failed");
				},
			});
			const b = mockConsumer();
			const bus = createEventBus([a, b]);

			await expect(bus.bootstrap([makeEvent()])).rejects.toThrow("bootstrap failed");
			expect(b.bootstrap).not.toHaveBeenCalled();
		});

		it("works with empty consumer list", async () => {
			const bus = createEventBus([]);
			await expect(bus.bootstrap([makeEvent()])).resolves.toBeUndefined();
		});
	});
});
