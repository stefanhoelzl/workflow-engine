import { describe, expect, it, vi } from "vitest";
import type { Action } from "./actions/index.js";
import { createActionContext } from "./context/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { createEventSource } from "./event-source.js";
import { createLogger } from "./logger.js";
import { createScheduler } from "./services/scheduler.js";
import { createApp } from "./services/server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

const silentLogger = createLogger("test", { level: "silent" });

const passthroughSchema = { parse: (d: unknown) => d };
const defaultSchemas: Record<string, { parse(data: unknown): unknown }> = {
	"order.received": passthroughSchema,
	"order.validated": passthroughSchema,
	stop: passthroughSchema,
};

const CORR_PREFIX = /^corr_/;

describe("integration: HTTP → trigger → fan-out → action → emit → fan-out", () => {
	it("processes a full chaining pipeline with fan-out after emit", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const workQueue = createWorkQueue();
		const bus = createEventBus([workQueue]);
		const source = createEventSource(defaultSchemas, bus);
		const createContext = createActionContext(source, globalThis.fetch, {}, silentLogger);

		const fulfillHandler = vi.fn();
		const notifyHandler = vi.fn();

		const actions: Action[] = [
			{
				name: "validateOrder",
				on: "order.received",
				handler: async (ctx) => {
					await ctx.emit("order.validated", ctx.event.payload);
				},
			},
			{
				name: "fulfillOrder",
				on: "order.validated",
				handler: fulfillHandler,
			},
			{
				name: "notifyCustomer",
				on: "order.validated",
				handler: notifyHandler,
			},
		];

		const scheduler = createScheduler(workQueue, source, actions, createContext);
		scheduler.start();

		const app = createApp(
			httpTriggerMiddleware(registry, source),
		);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });

		await new Promise((r) => setTimeout(r, 100));

		await scheduler.stop();

		expect(fulfillHandler).toHaveBeenCalledTimes(1);
		expect(notifyHandler).toHaveBeenCalledTimes(1);

		const fulfillCtx = fulfillHandler.mock.calls.at(0)?.at(0);
		const notifyCtx = notifyHandler.mock.calls.at(0)?.at(0);
		expect(fulfillCtx.event.correlationId).toBe(notifyCtx.event.correlationId);
		expect(fulfillCtx.event.correlationId).toMatch(CORR_PREFIX);

		expect(fulfillCtx.event.payload).toEqual({ orderId: "abc" });
		expect(notifyCtx.event.payload).toEqual({ orderId: "abc" });

		expect(fulfillCtx.event.parentEventId).toBeDefined();
		expect(notifyCtx.event.parentEventId).toBeDefined();
	});
});
