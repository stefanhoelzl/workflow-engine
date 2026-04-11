import { describe, expect, it } from "vitest";
import type { Action } from "./actions/index.js";
import { type ActionContext, createActionContext } from "./context/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { createEventSource } from "./event-source.js";
import type { Sandbox } from "./sandbox/index.js";
import { createScheduler } from "./services/scheduler.js";
import { createApp } from "./services/server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

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
		const source = createEventSource({ events: defaultSchemas }, bus);
		const createContext = createActionContext(source);

		const spawnCalls: { source: string; ctx: ActionContext }[] = [];
		const sandbox: Sandbox = {
			async spawn(actionSource, ctx) {
				spawnCalls.push({ source: actionSource, ctx });
				// Simulate the validateOrder action emitting
				if (actionSource.includes("validateOrder")) {
					await ctx.emit("order.validated", ctx.event.payload);
				}
				return { ok: true, logs: [] };
			},
		};

		const actions: Action[] = [
			{
				name: "validateOrder",
				on: "webhook.order",
				env: {},
				source: "export default async (ctx) => { /* validateOrder */ }",
				exportName: "default",
			},
			{
				name: "fulfillOrder",
				on: "order.validated",
				env: {},
				source: "export default async (ctx) => { /* fulfillOrder */ }",
				exportName: "default",
			},
			{
				name: "notifyCustomer",
				on: "order.validated",
				env: {},
				source: "export default async (ctx) => { /* notifyCustomer */ }",
				exportName: "default",
			},
		];

		const scheduler = createScheduler(
			workQueue,
			source,
			{ actions },
			createContext,
			sandbox,
		);
		scheduler.start();

		const app = createApp(
			httpTriggerMiddleware({ triggerRegistry: registry }, source),
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

		// validateOrder + fulfillOrder + notifyCustomer
		expect(spawnCalls).toHaveLength(3);

		const fulfillCall = spawnCalls.find((c) =>
			c.source.includes("fulfillOrder"),
		);
		const notifyCall = spawnCalls.find((c) =>
			c.source.includes("notifyCustomer"),
		);
		expect(fulfillCall).toBeDefined();
		expect(notifyCall).toBeDefined();

		// biome-ignore lint/style/noNonNullAssertion: test assertions guarantee elements exist
		const fulfill = fulfillCall!;
		// biome-ignore lint/style/noNonNullAssertion: test assertions guarantee elements exist
		const notify = notifyCall!;

		expect(fulfill.ctx.event.correlationId).toBe(
			notify.ctx.event.correlationId,
		);
		expect(fulfill.ctx.event.correlationId).toMatch(CORR_PREFIX);

		// Payload includes the full HTTP context shape
		expect(fulfill.ctx.event.payload).toHaveProperty("body");
		expect(fulfill.ctx.event.payload).toHaveProperty("headers");
		expect(fulfill.ctx.event.payload).toHaveProperty("url");
		expect(fulfill.ctx.event.payload).toHaveProperty("method");

		expect(fulfill.ctx.event.parentEventId).toBeDefined();
		expect(notify.ctx.event.parentEventId).toBeDefined();
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
		const source = createEventSource({ events: defaultSchemas }, bus);
		const createContext = createActionContext(source);

		const spawnCalls: { source: string; ctx: ActionContext }[] = [];
		const sandbox: Sandbox = {
			async spawn(actionSource, ctx) {
				spawnCalls.push({ source: actionSource, ctx });
				return { ok: true, logs: [] };
			},
		};

		const actions: Action[] = [
			{
				name: "handleOrder",
				on: "webhook.order",
				env: {},
				source: "export default async (ctx) => { /* handleOrder */ }",
				exportName: "default",
			},
		];

		const scheduler = createScheduler(
			workQueue,
			source,
			{ actions },
			createContext,
			sandbox,
		);
		scheduler.start();

		const app = createApp(
			httpTriggerMiddleware({ triggerRegistry: registry }, source),
		);

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

		expect(spawnCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
		const ctx = spawnCalls[0]!.ctx;
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
