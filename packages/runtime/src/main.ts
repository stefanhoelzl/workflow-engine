import { serve } from "@hono/node-server";
import type { WorkflowConfig } from "@workflow-engine/sdk";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { ContextFactory } from "./context/index.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import type { LogLevel } from "./logger.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { sampleWorkflow } from "./sample.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

// biome-ignore lint/style/noProcessEnv: entry-point config
const level = (process.env.LOG_LEVEL ?? "info") as LogLevel;

const httpLogger = createHttpLogger("http", { level });
const contextLogger = createLogger("context", { level });
const schedulerLogger = createLogger("scheduler", { level });

function loadWorkflow(config: WorkflowConfig) {
	const registry = new HttpTriggerRegistry();
	for (const trigger of config.triggers) {
		registry.register(trigger);
	}

	const actions: Action[] = config.actions.map((action) => ({
		name: action.name,
		match: (event) =>
			event.type === action.on.name && event.targetAction === action.name,
		handler: (ctx) =>
			action.handler({
				event: { name: ctx.event.type, payload: ctx.event.payload },
				emit: ctx.emit,
				env: ctx.env,
				fetch: (url, init) => ctx.fetch(url, init),
			}),
	}));

	return { registry, actions };
}

const { registry, actions } = loadWorkflow(sampleWorkflow);
const dispatch = createDispatchAction(actions);
actions.push(dispatch);

const queue = new InMemoryEventQueue();
// biome-ignore lint/style/noProcessEnv: entry-point config
const factory = new ContextFactory(queue, globalThis.fetch, process.env, contextLogger);

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
