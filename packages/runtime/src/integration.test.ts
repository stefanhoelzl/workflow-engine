import { describe, expect, it, vi } from "vitest";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import type { Event } from "./event-queue/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

describe("integration: HTTP → trigger → dispatch → action", () => {
	it("processes an HTTP request end-to-end through the pipeline", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});

		const queue = new InMemoryEventQueue();

		const handler = vi.fn();
		const actions: Action[] = [
			{
				name: "logOrder",
				match: (e) =>
					e.type === "order.received" && e.targetAction === "logOrder",
				handler,
			},
		];
		const dispatch = createDispatchAction(actions, queue);
		actions.push(dispatch);

		const scheduler = new Scheduler(queue, actions);
		scheduler.start();

		const app = createServer(
			httpTriggerMiddleware(registry, (definition, body) => {
				const event: Event = {
					id: `evt_${crypto.randomUUID()}`,
					type: definition.event,
					payload: body,
					createdAt: new Date(),
				};
				queue.enqueue(event);
			}),
		);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });

		// Give the scheduler time to process dispatch + targeted event
		await new Promise((r) => setTimeout(r, 50));

		scheduler.stop();
		await queue.enqueue({
			id: "evt_stop",
			type: "stop",
			payload: null,
			createdAt: new Date(),
		});
		await scheduler.stopped;

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "order.received",
				targetAction: "logOrder",
				payload: { orderId: "abc" },
			}),
		);
	});
});
