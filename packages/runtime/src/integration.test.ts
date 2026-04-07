import { describe, expect, it, vi } from "vitest";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

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
		const factory = new ContextFactory(queue, globalThis.fetch, {});

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

		const scheduler = new Scheduler(queue, actions, factory.action);
		scheduler.start();

		const app = createServer(
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
});
