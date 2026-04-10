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
	"webhook.order": passthroughSchema,
	"order.validated": passthroughSchema,
	stop: passthroughSchema,
};

const CORR_PREFIX = /^corr_/;

describe("integration: HTTP → trigger → fan-out → action → emit → fan-out", () => {
	it("processes a full chaining pipeline with fan-out after emit", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const workQueue = createWorkQueue();
		const bus = createEventBus([workQueue]);
		const source = createEventSource(defaultSchemas, bus);
		const createContext = createActionContext(source, globalThis.fetch, silentLogger);

		const fulfillHandler = vi.fn();
		const notifyHandler = vi.fn();

		const actions: Action[] = [
			{
				name: "validateOrder",
				on: "webhook.order",
				env: {},
				handler: async (ctx) => {
					await ctx.emit("order.validated", ctx.event.payload);
				},
			},
			{
				name: "fulfillOrder",
				on: "order.validated",
				env: {},
				handler: fulfillHandler,
			},
			{
				name: "notifyCustomer",
				on: "order.validated",
				env: {},
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

		// Payload includes the full HTTP context shape
		expect(fulfillCtx.event.payload).toHaveProperty("body");
		expect(fulfillCtx.event.payload).toHaveProperty("headers");
		expect(fulfillCtx.event.payload).toHaveProperty("url");
		expect(fulfillCtx.event.payload).toHaveProperty("method");

		expect(fulfillCtx.event.parentEventId).toBeDefined();
		expect(notifyCtx.event.parentEventId).toBeDefined();
	});

	it("propagates headers and url through the full pipeline", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { ok: true } },
		});

		const workQueue = createWorkQueue();
		const bus = createEventBus([workQueue]);
		const source = createEventSource(defaultSchemas, bus);
		const createContext = createActionContext(source, globalThis.fetch, silentLogger);

		const actionHandler = vi.fn();
		const actions: Action[] = [
			{ name: "handleOrder", on: "webhook.order", env: {}, handler: actionHandler },
		];

		const scheduler = createScheduler(workQueue, source, actions, createContext);
		scheduler.start();

		const app = createApp(httpTriggerMiddleware(registry, source));

		await app.request("/webhooks/order?source=shopify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature": "sha256=test",
			},
			body: JSON.stringify({ orderId: "xyz" }),
		});

		await new Promise((r) => setTimeout(r, 100));
		await scheduler.stop();

		expect(actionHandler).toHaveBeenCalledOnce();
		const ctx = actionHandler.mock.calls[0]?.[0];
		const payload = ctx.event.payload as {
			body: { orderId: string };
			headers: Record<string, string>;
			url: string;
			method: string;
		};

		expect(payload.body).toEqual({ orderId: "xyz" });
		expect(payload.headers["x-signature"]).toBe("sha256=test");
		expect(payload.url).toBe("http://localhost/webhooks/order?source=shopify");
		expect(payload.method).toBe("POST");
	});
});
