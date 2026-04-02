import { serve } from "@hono/node-server";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import type { Event } from "./event-queue/index.js";
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

// Hardcoded sample actions — replaced when SDK/manifest lands
const actions: Action[] = [
	{
		name: "logOrder",
		match: (e) => e.type === "order.received" && e.targetAction === "logOrder",
		handler: (e) => {
			// biome-ignore lint/suspicious/noConsole: sample action
			console.log(`[logOrder] received event ${e.id}`, e.payload);
		},
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

const port = 3000;
// biome-ignore lint/suspicious/noConsole: entry point logging
console.log(`Runtime listening on port ${port}`);
serve({ fetch: app.fetch, port });
