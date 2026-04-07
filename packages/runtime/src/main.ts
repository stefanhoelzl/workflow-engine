import { serve } from "@hono/node-server";
import { createDispatchAction } from "./actions/dispatch.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import type { LogLevel } from "./logger.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { sampleActions, sampleTriggers } from "./sample.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

// biome-ignore lint/style/noProcessEnv: entry-point config
const level = (process.env.LOG_LEVEL ?? "info") as LogLevel;

const httpLogger = createHttpLogger("http", { level });
const contextLogger = createLogger("context", { level });
const schedulerLogger = createLogger("scheduler", { level });

const registry = new HttpTriggerRegistry();
for (const trigger of sampleTriggers) {
	registry.register(trigger);
}

const queue = new InMemoryEventQueue();
// biome-ignore lint/style/noProcessEnv: entry-point config
const factory = new ContextFactory(queue, globalThis.fetch, process.env, contextLogger);

const actions = [...sampleActions];
const dispatch = createDispatchAction(actions);
actions.push(dispatch);

const scheduler = new Scheduler(queue, actions, factory.action, schedulerLogger);
scheduler.start();

const app = createServer(
	httpLogger,
	httpTriggerMiddleware(registry, factory.httpTrigger),
);

const defaultPort = 8080;
// biome-ignore lint/style/noProcessEnv: entry-point config
const port = Number(process.env.PORT) || defaultPort;
const startupLogger = createLogger("runtime", { level });
startupLogger.info("started", { port });
serve({ fetch: app.fetch, port });
