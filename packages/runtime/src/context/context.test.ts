import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { type Logger, createLogger } from "../logger.js";
import { ActionContext, ContextFactory, HttpTriggerContext } from "./index.js";

const silentLogger = createLogger("test", { level: "silent" });

function createTestLogger(level = "info"): {
	logger: Logger;
	lines: () => Record<string, unknown>[];
} {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});
	return {
		logger: createLogger("context", { level: level as "info", destination: stream }),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

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
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
			const event = makeEvent();

			const ctx = factory.action(event);

			expect(ctx).toBeInstanceOf(ActionContext);
			expect(ctx.event).toBe(event);
		});

		it("emit creates child event inheriting correlationId and setting parentEventId", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, silentLogger);
			const ctx = factory.action(makeEvent());

			const res = await ctx.fetch("https://api.example.com/orders/123");

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/orders/123", undefined);
			expect(await res.text()).toBe("ok");
		});

		it("delegates POST request with options to injected fetch", async () => {
			const queue = new InMemoryEventQueue();
			const fetchSpy = vi.fn().mockResolvedValue(Response.json({ id: "123" }));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, silentLogger);
			const ctx = factory.action(makeEvent());

			await expect(ctx.fetch("https://unreachable.example.com")).rejects.toThrow("fetch failed");
		});
	});

	describe("action env", () => {
		it("exposes injected env record on ctx.env", () => {
			const queue = new InMemoryEventQueue();
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const factory = new ContextFactory(queue, mockFetch, { FOO: "bar", BAZ: "qux" }, silentLogger);
			const ctx = factory.action(makeEvent());

			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			expect(ctx.env).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("returns undefined for missing env keys", () => {
			const queue = new InMemoryEventQueue();
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const factory = new ContextFactory(queue, mockFetch, { FOO: "bar" }, silentLogger);
			const ctx = factory.action(makeEvent());

			expect(ctx.env.MISSING).toBeUndefined();
		});
	});

	describe("arrow property binding", () => {
		it("factory.httpTrigger works when passed as a standalone reference", async () => {
			const queue = new InMemoryEventQueue();
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
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
			const factory = new ContextFactory(queue, mockFetch, mockEnv, silentLogger);
			const event = makeEvent();

			const createCtx = factory.action;
			const ctx = createCtx(event);

			await ctx.emit("test.event", {});
			const child = await queue.dequeue();
			expect(child.correlationId).toBe("corr_abc");
		});
	});

	describe("emit logging", () => {
		it("logs event.emitted at info level for root events from trigger", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const factory = new ContextFactory(queue, mockFetch, mockEnv, logger);
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);
			await ctx.emit("order.received", { orderId: "abc" });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted).toBeDefined();
			expect(emitted?.type).toBe("order.received");
			expect(emitted?.correlationId).toMatch(CORR_PREFIX);
			expect(emitted?.eventId).toMatch(EVT_PREFIX);
			expect(emitted?.parentEventId).toBeUndefined();
		});

		it("logs event.emitted at info level for child events from action", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const factory = new ContextFactory(queue, mockFetch, mockEnv, logger);
			const parentEvent = makeEvent({ id: "evt_parent", correlationId: "corr_xyz" });

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted).toBeDefined();
			expect(emitted?.correlationId).toBe("corr_xyz");
			expect(emitted?.parentEventId).toBe("evt_parent");
			expect(emitted?.type).toBe("order.validated");
		});

		it("logs event.emitted.payload at trace level", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger("trace");
			const factory = new ContextFactory(queue, mockFetch, mockEnv, logger);
			const ctx = factory.action(makeEvent());
			await ctx.emit("order.validated", { orderId: "123" });

			const output = lines();
			const payload = output.find((l) => l.msg === "event.emitted.payload");
			expect(payload).toBeDefined();
			expect(payload?.payload).toEqual({ orderId: "123" });
		});

		it("includes targetAction in log when set", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const factory = new ContextFactory(queue, mockFetch, mockEnv, logger);
			const ctx = factory.action(makeEvent());
			await ctx.emit("order.received", {}, { targetAction: "notify" });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted?.targetAction).toBe("notify");
		});
	});

	describe("fetch logging", () => {
		it("logs fetch.start and fetch.completed on success", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, logger);
			const ctx = factory.action(makeEvent({ correlationId: "corr_fetch" }));

			await ctx.fetch("https://api.example.com/orders/123");

			const output = lines();
			const start = output.find((l) => l.msg === "fetch.start");
			const completed = output.find((l) => l.msg === "fetch.completed");

			expect(start).toBeDefined();
			expect(start?.url).toBe("https://api.example.com/orders/123");
			expect(start?.method).toBe("GET");
			expect(start?.correlationId).toBe("corr_fetch");

			expect(completed).toBeDefined();
			expect(completed?.status).toBe(200);
			expect(completed?.durationMs).toBeTypeOf("number");
		});

		it("logs fetch.request.body at trace level", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger("trace");
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, logger);
			const ctx = factory.action(makeEvent());

			await ctx.fetch("https://api.example.com/orders", {
				method: "POST",
				body: JSON.stringify({ id: "123" }),
			});

			const output = lines();
			const body = output.find((l) => l.msg === "fetch.request.body");
			expect(body).toBeDefined();
			expect(body?.body).toBe(JSON.stringify({ id: "123" }));
		});

		it("logs fetch.failed on error", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network error"));
			const factory = new ContextFactory(queue, fetchSpy as typeof globalThis.fetch, mockEnv, logger);
			const ctx = factory.action(makeEvent());

			await expect(ctx.fetch("https://unreachable.example.com")).rejects.toThrow("network error");

			const output = lines();
			const failed = output.find((l) => l.msg === "fetch.failed");
			expect(failed).toBeDefined();
			expect(failed?.error).toBe("network error");
			expect(failed?.durationMs).toBeTypeOf("number");
			// pino error level = 50
			expect(failed?.level).toBe(50);
		});
	});
});
