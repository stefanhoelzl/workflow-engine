import { describe, expect, it, vi } from "vitest";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { ActionContext, ContextFactory, HttpTriggerContext } from "./index.js";

const EVT_PREFIX = /^evt_/;
const CORR_PREFIX = /^corr_/;
const mockFetch = vi.fn() as unknown as typeof globalThis.fetch;
// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
const mockEnv: Record<string, string | undefined> = { API_KEY: "secret", EMPTY: undefined };

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
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
			const event = makeEvent();

			const ctx = factory.action(event);

			expect(ctx).toBeInstanceOf(ActionContext);
			expect(ctx.event).toBe(event);
		});

		it("emit creates child event inheriting correlationId and setting parentEventId", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
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

	describe("action fetch", () => {
		it("delegates GET request to injected fetch", async () => {
			const queue = new InMemoryEventQueue();
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv);
			const ctx = factory.action(makeEvent());

			const res = await ctx.fetch("https://api.example.com/orders/123");

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/orders/123", undefined);
			expect(await res.text()).toBe("ok");
		});

		it("delegates POST request with options to injected fetch", async () => {
			const queue = new InMemoryEventQueue();
			const fetchSpy = vi.fn().mockResolvedValue(Response.json({ id: "123" }));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv);
			const ctx = factory.action(makeEvent());

			const init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "123" }),
			};
			const res = await ctx.fetch("https://api.example.com/orders", init);

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/orders", init);
			expect(res).toBeInstanceOf(Response);
		});

		it("propagates fetch errors to the caller", async () => {
			const queue = new InMemoryEventQueue();
			const fetchSpy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv);
			const ctx = factory.action(makeEvent());

			await expect(ctx.fetch("https://unreachable.example.com")).rejects.toThrow("fetch failed");
		});
	});

	describe("action env", () => {
		it("exposes injected env record on ctx.env", () => {
			const queue = new InMemoryEventQueue();
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const factory = new ContextFactory(queue, mockFetch, { FOO: "bar", BAZ: "qux" });
			const ctx = factory.action(makeEvent());

			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			expect(ctx.env).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("returns undefined for missing env keys", () => {
			const queue = new InMemoryEventQueue();
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const factory = new ContextFactory(queue, mockFetch, { FOO: "bar" });
			const ctx = factory.action(makeEvent());

			expect(ctx.env.MISSING).toBeUndefined();
		});
	});

	describe("arrow property binding", () => {
		it("factory.httpTrigger works when passed as a standalone reference", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv);
			const event = makeEvent();

			const createCtx = factory.action;
			const ctx = createCtx(event);

			await ctx.emit("test.event", {});
			const child = await queue.dequeue();
			expect(child.correlationId).toBe("corr_abc");
		});
	});
});
