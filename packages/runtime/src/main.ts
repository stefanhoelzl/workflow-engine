import { serve } from "@hono/node-server";
import type { WorkflowConfig } from "@workflow-engine/sdk";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { createConfig } from "./config.js";
import { ContextFactory } from "./context/index.js";
import { FileSystemEventQueue } from "./event-queue/fs-queue.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { sampleWorkflow } from "./sample.js";
import { Scheduler } from "./scheduler/index.js";
import { createServer } from "./server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

// biome-ignore lint/style/noProcessEnv: entry-point config
const config = createConfig(process.env);

const runtimeLogger = createLogger("runtime", { level: config.logLevel });
const httpLogger = createHttpLogger("http", { level: config.logLevel });
const contextLogger = createLogger("context", { level: config.logLevel });
const schedulerLogger = createLogger("scheduler", { level: config.logLevel });

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

	return { registry, actions, events: config.events };
}

runtimeLogger.info("initialize", { config });

const { registry, actions, events } = loadWorkflow(sampleWorkflow);
const dispatch = createDispatchAction(actions);
actions.push(dispatch);

// biome-ignore lint/style/noProcessEnv: entry-point config
const eventQueuePath = process.env.EVENT_QUEUE_PATH;
const queue = eventQueuePath
	? await FileSystemEventQueue.create(eventQueuePath, { concurrency: config.fileIoConcurrency })
	: new InMemoryEventQueue();
// biome-ignore lint/style/noProcessEnv: entry-point config
const factory = new ContextFactory(queue, events, globalThis.fetch, process.env, contextLogger);

const scheduler = new Scheduler(queue, actions, factory.action, schedulerLogger);
scheduler.start();
runtimeLogger.info("scheduler started")

const app = createServer(
	httpLogger,
	httpTriggerMiddleware(registry, factory.httpTrigger),
);

runtimeLogger.info("serve", { port: config.port });
serve({ fetch: app.fetch, port: config.port });
