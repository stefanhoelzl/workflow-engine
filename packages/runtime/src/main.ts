import type { WorkflowConfig } from "@workflow-engine/sdk";
import { createDispatchAction } from "./actions/dispatch.js";
import type { Action } from "./actions/index.js";
import { createConfig } from "./config.js";
import { ContextFactory } from "./context/index.js";
import type { BusConsumer, EventBus } from "./event-bus/index.js";
import { createEventBus } from "./event-bus/index.js";
import { type PersistenceConsumer, createPersistence } from "./event-bus/persistence.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { loadWorkflows } from "./loader.js";
import { createHttpLogger, createLogger } from "./logger.js";
import type { Service } from "./services/index.js";
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
async function init() {
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

	const workQueue = createWorkQueue();
	const consumers: BusConsumer[] = [workQueue];
	const persistence = config.persistencePath
		? createPersistence(config.persistencePath, {
				concurrency: config.fileIoConcurrency,
				logger: runtimeLogger,
			})
		: undefined;
	if (persistence) {
		consumers.push(persistence);
	}
	const eventBus = createEventBus(consumers);

	// biome-ignore lint/style/noProcessEnv: entry-point config
	const contextFactory = new ContextFactory(eventBus, allEvents, globalThis.fetch, process.env, contextLogger);

	const scheduler = createScheduler(workQueue, eventBus, allActions, contextFactory.action, schedulerLogger);
	const server = createServer(
		config.port,
		httpLogger,
		httpTriggerMiddleware(registry, contextFactory.httpTrigger),
	);

	return { runtimeLogger, eventBus, persistence, scheduler, server };
}

async function recover(persistence: PersistenceConsumer, eventBus: EventBus): Promise<number> {
	let count = 0;
	for await (const batch of persistence.recover()) {
		await eventBus.bootstrap(batch);
		count += batch.length;
	}
	await eventBus.bootstrap([], { finished: true });
	return count;
}

function start(logger: ReturnType<typeof createLogger>, ...services: Service[]) {
	let shuttingDown = false;
	const shutdown = async (code: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info(code === 0 ? "shutting-down" : "shutting-down-on-error");
		await Promise.allSettled(services.map((s) => s.stop()));
		logger.info("main.shutdown");
		setImmediate(() => process.exit(code));
	};

	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));

	const onError = (err: unknown) => {
		logger.error("main.service-failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		shutdown(1);
	};

	for (const service of services) {
		service.start().catch(onError);
	}
}

async function main() {
	const { runtimeLogger, eventBus, persistence, scheduler, server } = await init();
	runtimeLogger.info("main.initialized");

	if (persistence) {
		const count = await recover(persistence, eventBus);
		runtimeLogger.info("main.events-recovered", { count });
	}

	start(runtimeLogger, scheduler, server);
	runtimeLogger.info("main.started");
}

main();
