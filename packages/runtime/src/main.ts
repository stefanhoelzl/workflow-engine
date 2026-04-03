import { serve } from "@hono/node-server";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

const registry = new HttpTriggerRegistry();

// Temporary hardcoded trigger — replaced when SDK/manifest lands
registry.register({
	path: "order",
	method: "POST",
	event: "order.received",
	response: { status: 202, body: { accepted: true } },
});

const queue = new InMemoryEventQueue();
const factory = new ContextFactory(queue);

// Hardcoded sample actions — replaced when SDK/manifest lands
const actions: Action[] = [
	{
		name: "validateOrder",
		match: (e) =>
			e.type === "order.received" && e.targetAction === "validateOrder",
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[validateOrder] validating event ${ctx.event.id}`,
				ctx.event.payload,
			);
			await ctx.emit("order.validated", ctx.event.payload);
		},
	},
	{
		name: "fulfillOrder",
		match: (e) =>
			e.type === "order.validated" && e.targetAction === "fulfillOrder",
		// biome-ignore lint/suspicious/useAwait: handler interface requires async
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[fulfillOrder] fulfilling event ${ctx.event.id}`,
				ctx.event.payload,
			);
		},
	},
	{
		name: "notifyCustomer",
		match: (e) =>
			e.type === "order.validated" && e.targetAction === "notifyCustomer",
		// biome-ignore lint/suspicious/useAwait: handler interface requires async
		handler: async (ctx) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(
				`[notifyCustomer] notifying for event ${ctx.event.id}`,
				ctx.event.payload,
			);
		},
	},
];

const dispatch = createDispatchAction(actions);
actions.push(dispatch);

const scheduler = new Scheduler(queue, actions, factory.action);
scheduler.start();

const app = createServer(httpTriggerMiddleware(registry, factory.httpTrigger));

const port = 3000;
// biome-ignore lint/suspicious/noConsole: entry point logging
console.log(`Runtime listening on port ${port}`);
serve({ fetch: app.fetch, port });
