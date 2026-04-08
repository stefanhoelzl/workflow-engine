import { describe, expect, it, vi } from "vitest";
import { ContextFactory } from "../context/index.js";
import { type BusConsumer, type RuntimeEvent, createEventBus } from "../event-bus/index.js";
import { createLogger } from "../logger.js";
import { createDispatchAction } from "./dispatch.js";
import type { Action } from "./index.js";

const silentLogger = createLogger("test", { level: "silent" });

const passthroughSchema = { parse: (d: unknown) => d };
const defaultSchemas: Record<string, { parse(data: unknown): unknown }> = {
	"order.received": passthroughSchema,
	"order.shipped": passthroughSchema,
	"audit.log": passthroughSchema,
};

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: "evt_original",
		type: "order.received",
		payload: { orderId: "123" },
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	};
}

function createCollectorBus(): { bus: ReturnType<typeof createEventBus>; emitted: RuntimeEvent[] } {
	const emitted: RuntimeEvent[] = [];
	const collector: BusConsumer = {
		async handle(event) { emitted.push(event); },
		async bootstrap() { /* no-op */ },
	};
	return { bus: createEventBus([collector]), emitted };
}

describe("dispatch action", () => {
	it("fans out to multiple subscribers", async () => {
		const { bus, emitted } = createCollectorBus();
		const factory = new ContextFactory(bus, defaultSchemas, vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
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
		const dispatch = createDispatchAction(actions);
		actions.push(dispatch);

		const event = makeEvent();
		const ctx = factory.action(event);
		await dispatch.handler(ctx);

		expect(emitted.length).toBe(2);
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const first = emitted[0]!;
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const second = emitted[1]!;

		expect(first.type).toBe("order.received");
		expect(first.targetAction).toBe("parseOrder");
		expect(first.payload).toEqual({ orderId: "123" });
		expect(first.id).not.toBe("evt_original");
		expect(first.correlationId).toBe("corr_test");
		expect(first.parentEventId).toBe("evt_original");

		expect(second.type).toBe("order.received");
		expect(second.targetAction).toBe("sendEmail");
		expect(second.payload).toEqual({ orderId: "123" });
		expect(second.id).not.toBe("evt_original");
		expect(second.correlationId).toBe("corr_test");
		expect(second.parentEventId).toBe("evt_original");
	});

	it("emits nothing when there are zero subscribers", async () => {
		const { bus, emitted } = createCollectorBus();
		const factory = new ContextFactory(bus, defaultSchemas, vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
		const unrelated: Action = {
			name: "updateInventory",
			match: (e) =>
				e.type === "order.shipped" && e.targetAction === "updateInventory",
			handler: vi.fn(),
		};
		const actions = [unrelated];
		const dispatch = createDispatchAction(actions);
		actions.push(dispatch);

		const event = makeEvent({ type: "audit.log" });
		const ctx = factory.action(event);
		await dispatch.handler(ctx);

		expect(emitted.length).toBe(0);
	});

	it("does not dispatch to itself", async () => {
		const { bus, emitted } = createCollectorBus();
		const factory = new ContextFactory(bus, defaultSchemas, vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
		const actions: Action[] = [];
		const dispatch = createDispatchAction(actions);
		actions.push(dispatch);

		const event = makeEvent();
		const ctx = factory.action(event);
		await dispatch.handler(ctx);

		expect(emitted.length).toBe(0);
	});

	it("matches only events with targetAction undefined", () => {
		const dispatch = createDispatchAction([]);

		expect(dispatch.match(makeEvent())).toBe(true);
		expect(dispatch.match(makeEvent({ targetAction: "parseOrder" }))).toBe(
			false,
		);
	});
});
