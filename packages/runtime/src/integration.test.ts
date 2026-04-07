import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { type Logger, createHttpLogger, createLogger } from "./logger.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

const silentLogger = createLogger("test", { level: "silent" });
const silentHttpLogger = createHttpLogger("test", { level: "silent" });

const passthroughSchema = { parse: (d: unknown) => d };
const defaultSchemas: Record<string, { parse(data: unknown): unknown }> = {
	"order.received": passthroughSchema,
	"order.validated": passthroughSchema,
	stop: passthroughSchema,
};

function createTestLoggers(): {
	contextLogger: Logger;
	schedulerLogger: Logger;
	httpLogger: ReturnType<typeof createHttpLogger>;
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
		contextLogger: createLogger("context", { level: "info", destination: stream }),
		schedulerLogger: createLogger("scheduler", { level: "info", destination: stream }),
		httpLogger: createHttpLogger("http", { level: "info", destination: stream }),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

const CORR_PREFIX = /^corr_/;

describe("integration: HTTP → trigger → dispatch → action → emit → fan-out", () => {
	it("processes a full chaining pipeline with fan-out after emit", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const queue = new InMemoryEventQueue();
		const factory = new ContextFactory(queue, defaultSchemas, globalThis.fetch, {}, silentLogger);

		const fulfillHandler = vi.fn();
		const notifyHandler = vi.fn();

		const actions: Action[] = [
			{
				name: "validateOrder",
				match: (e) =>
					e.type === "order.received" && e.targetAction === "validateOrder",
				handler: async (ctx) => {
					await ctx.emit("order.validated", ctx.event.payload);
				},
			},
			{
				name: "fulfillOrder",
				match: (e) =>
					e.type === "order.validated" && e.targetAction === "fulfillOrder",
				handler: fulfillHandler,
			},
			{
				name: "notifyCustomer",
				match: (e) =>
					e.type === "order.validated" && e.targetAction === "notifyCustomer",
				handler: notifyHandler,
			},
		];

		const dispatch = createDispatchAction(actions);
		actions.push(dispatch);

		const scheduler = new Scheduler(queue, actions, factory.action, silentLogger);
		scheduler.start();

		const app = createServer(
			silentHttpLogger,
			httpTriggerMiddleware(registry, factory.httpTrigger),
		);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });

		// Give the scheduler time to process the full chain:
		// 1. trigger event → dispatch → validateOrder
		// 2. validateOrder emits → dispatch → fulfillOrder + notifyCustomer
		await new Promise((r) => setTimeout(r, 100));

		scheduler.stop();
		await queue.enqueue({
			id: "evt_stop",
			type: "stop",
			payload: null,
			correlationId: "corr_stop",
			createdAt: new Date(),
		});
		await scheduler.stopped;

		expect(fulfillHandler).toHaveBeenCalledTimes(1);
		expect(notifyHandler).toHaveBeenCalledTimes(1);

		// Verify correlationId propagates through the chain
		const fulfillCtx = fulfillHandler.mock.calls.at(0)?.at(0);
		const notifyCtx = notifyHandler.mock.calls.at(0)?.at(0);
		expect(fulfillCtx.event.correlationId).toBe(notifyCtx.event.correlationId);
		expect(fulfillCtx.event.correlationId).toMatch(CORR_PREFIX);

		// Verify payload propagates
		expect(fulfillCtx.event.payload).toEqual({ orderId: "abc" });
		expect(notifyCtx.event.payload).toEqual({ orderId: "abc" });

		// Verify parentEventId is set (events came through dispatch)
		expect(fulfillCtx.event.parentEventId).toBeDefined();
		expect(notifyCtx.event.parentEventId).toBeDefined();
	});

	it("produces structured log output across the full pipeline", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const queue = new InMemoryEventQueue();
		const { contextLogger, schedulerLogger, httpLogger, lines } = createTestLoggers();
		const factory = new ContextFactory(queue, defaultSchemas, globalThis.fetch, {}, contextLogger);

		const actions: Action[] = [
			{
				name: "handleOrder",
				match: (e) =>
					e.type === "order.received" && e.targetAction === "handleOrder",
				handler: vi.fn(),
			},
		];

		const dispatch = createDispatchAction(actions);
		actions.push(dispatch);

		const scheduler = new Scheduler(queue, actions, factory.action, schedulerLogger);
		scheduler.start();

		const app = createServer(
			httpLogger,
			httpTriggerMiddleware(registry, factory.httpTrigger),
		);

		await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		await new Promise((r) => setTimeout(r, 100));

		scheduler.stop();
		await queue.enqueue({
			id: "evt_stop",
			type: "stop",
			payload: null,
			correlationId: "corr_stop",
			createdAt: new Date(),
		});
		await scheduler.stopped;

		const output = lines();

		// HTTP access log (hono-pino format)
		const httpLogs = output.filter((l) => l.name === "http");
		expect(httpLogs.length).toBeGreaterThanOrEqual(1);
		const responseLog = httpLogs.find((l) => l.msg === "Request completed");
		expect(responseLog).toBeDefined();
		expect(responseLog?.responseTime).toBeTypeOf("number");

		// Context emit logs
		const contextLogs = output.filter((l) => l.name === "context" && l.msg === "event.emitted");
		expect(contextLogs.length).toBeGreaterThanOrEqual(1);
		// All emitted events should share the same correlationId
		const correlationIds = new Set(contextLogs.map((l) => l.correlationId));
		// corr_stop is from the stop event, filter it out
		correlationIds.delete("corr_stop");
		expect(correlationIds.size).toBe(1);

		// Scheduler logs
		const schedulerLogs = output.filter((l) => l.name === "scheduler");
		const started = schedulerLogs.filter((l) => l.msg === "action.started");
		const completed = schedulerLogs.filter((l) => l.msg === "action.completed");
		expect(started.length).toBeGreaterThanOrEqual(1);
		expect(completed.length).toBeGreaterThanOrEqual(1);
		// Verify duration tracking
		for (const log of completed) {
			expect(log.durationMs).toBeTypeOf("number");
		}
	});
});
