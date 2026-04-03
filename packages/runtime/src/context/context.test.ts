import { describe, expect, it } from "vitest";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { ActionContext, ContextFactory, HttpTriggerContext } from "./index.js";

const EVT_PREFIX = /^evt_/;
const CORR_PREFIX = /^corr_/;

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: "evt_001",
		type: "order.received",
		payload: { orderId: "123" },
		correlationId: "corr_abc",
		createdAt: new Date(),
		...overrides,
	};
}

describe("ContextFactory", () => {
	describe("httpTrigger", () => {
		it("returns an HttpTriggerContext with request and definition", () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);

			expect(ctx).toBeInstanceOf(HttpTriggerContext);
			expect(ctx.request.body).toEqual({ orderId: "abc" });
			expect(ctx.definition).toBe(definition);
		});

		it("emit creates root event with new correlationId and no parentEventId", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);
			await ctx.emit("order.received", { orderId: "abc" });

			const event = await queue.dequeue();
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.correlationId).toMatch(CORR_PREFIX);
			expect(event.parentEventId).toBeUndefined();
			expect(event.targetAction).toBeUndefined();
			expect(event.createdAt).toBeInstanceOf(Date);
		});
	});

	describe("action", () => {
		it("returns an ActionContext with the source event", () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const event = makeEvent();

			const ctx = factory.action(event);

			expect(ctx).toBeInstanceOf(ActionContext);
			expect(ctx.event).toBe(event);
		});

		it("emit creates child event inheriting correlationId and setting parentEventId", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });

			const child = await queue.dequeue();
			expect(child.type).toBe("order.validated");
			expect(child.payload).toEqual({ valid: true });
			expect(child.correlationId).toBe("corr_xyz");
			expect(child.parentEventId).toBe("evt_parent");
			expect(child.id).toMatch(EVT_PREFIX);
			expect(child.targetAction).toBeUndefined();
		});

		it("multiple emits all inherit from the same parent", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });
			await ctx.emit("order.logged", { logged: true });

			const first = await queue.dequeue();
			const second = await queue.dequeue();

			expect(first.correlationId).toBe("corr_xyz");
			expect(first.parentEventId).toBe("evt_parent");
			expect(second.correlationId).toBe("corr_xyz");
			expect(second.parentEventId).toBe("evt_parent");
			expect(first.id).not.toBe(second.id);
		});
	});

	describe("arrow property binding", () => {
		it("factory.httpTrigger works when passed as a standalone reference", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const createCtx = factory.httpTrigger;
			const ctx = createCtx({ orderId: "abc" }, definition);

			await ctx.emit("order.received", { orderId: "abc" });
			const event = await queue.dequeue();
			expect(event.correlationId).toMatch(CORR_PREFIX);
		});

		it("factory.action works when passed as a standalone reference", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue);
			const event = makeEvent();

			const createCtx = factory.action;
			const ctx = createCtx(event);

			await ctx.emit("test.event", {});
			const child = await queue.dequeue();
			expect(child.correlationId).toBe("corr_abc");
		});
	});
});
