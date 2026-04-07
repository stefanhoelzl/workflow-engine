import { serve } from "@hono/node-server";
import { createDispatchAction } from "./actions/dispatch.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { sampleActions, sampleTriggers } from "./sample.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

const registry = new HttpTriggerRegistry();
for (const trigger of sampleTriggers) {
	registry.register(trigger);
}

const queue = new InMemoryEventQueue();
// biome-ignore lint/style/noProcessEnv: entry-point config
const factory = new ContextFactory(queue, globalThis.fetch, process.env);

const actions = [...sampleActions];
const dispatch = createDispatchAction(actions);
actions.push(dispatch);

const scheduler = new Scheduler(queue, actions, factory.action);
scheduler.start();

const app = createServer(httpTriggerMiddleware(registry, factory.httpTrigger));

const port = 3000;
// biome-ignore lint/suspicious/noConsole: entry point logging
console.log(`Runtime listening on port ${port}`);
serve({ fetch: app.fetch, port });
