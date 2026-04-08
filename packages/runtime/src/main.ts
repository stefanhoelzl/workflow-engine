import type { WorkflowConfig } from "@workflow-engine/sdk";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { createConfig } from "./config.js";
import { ContextFactory } from "./context/index.js";
import { FileSystemEventQueue } from "./event-queue/fs-queue.js";
import { InMemoryEventQueue } from "./event-queue/in-memory.js";
import { loadWorkflows } from "./loader.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { createScheduler } from "./services/scheduler.js";
import { createServer } from "./services/server.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

function loadWorkflow(wf: WorkflowConfig) {
	const actions: Action[] = wf.actions.map((action) => ({
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

	return { actions, triggers: wf.triggers, events: wf.events };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: entrypoint orchestration
async function main() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const contextLogger = createLogger("context", { level: config.logLevel });
	const schedulerLogger = createLogger("scheduler", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	const workflows = await loadWorkflows(config.workflowDir, runtimeLogger);

	const registry = new HttpTriggerRegistry();
	const allActions: Action[] = [];
	const allEvents: Record<string, { parse(data: unknown): unknown }> = {};

	for (const wf of workflows) {
		const loaded = loadWorkflow(wf);

		for (const trigger of loaded.triggers) {
			const existing = registry.lookup(
				trigger.path,
				trigger.method ?? "POST",
			);
			if (existing) {
				throw new Error(
					`Duplicate trigger path: ${trigger.path} (method: ${trigger.method ?? "POST"})`,
				);
			}
			registry.register(trigger);
		}

		allActions.push(...loaded.actions);
		Object.assign(allEvents, loaded.events);
	}

	const dispatch = createDispatchAction(allActions);
	allActions.push(dispatch);

	// biome-ignore lint/style/noProcessEnv: entry-point config
	const eventQueuePath = process.env.EVENT_QUEUE_PATH;
	const queue = eventQueuePath
		? await FileSystemEventQueue.create(eventQueuePath, { concurrency: config.fileIoConcurrency })
		: new InMemoryEventQueue();
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const factory = new ContextFactory(queue, allEvents, globalThis.fetch, process.env, contextLogger);

	const scheduler = createScheduler(queue, allActions, factory.action, schedulerLogger);
	const server = createServer(
		config.port,
		httpLogger,
		httpTriggerMiddleware(registry, factory.httpTrigger),
	);

	let shuttingDown = false;
	const shutdown = async (code: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		runtimeLogger.info(code === 0 ? "shutting-down" : "shutting-down-on-error");
		await Promise.allSettled([server.stop(), scheduler.stop()]);
		runtimeLogger.info("shutdown-complete");
		// Let pino flush its async destination before exiting
		setImmediate(() => process.exit(code));
	};

	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));

	const onError = (err: unknown) => {
		runtimeLogger.error("service-error", {
			error: err instanceof Error ? err.message : String(err),
		});
		shutdown(1);
	};

	scheduler.start().catch(onError);
	server.start().catch(onError);
	runtimeLogger.info("services-started")
}

main();
