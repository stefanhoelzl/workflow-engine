import { z, type WorkflowConfig } from "@workflow-engine/sdk";
import type { Action } from "./actions/index.js";
import { createConfig } from "./config.js";
import { createActionContext } from "./context/index.js";
import type { BusConsumer, EventBus } from "./event-bus/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createEventStore } from "./event-bus/event-store.js";
import { createLoggingConsumer } from "./event-bus/logging-consumer.js";
import { type PersistenceConsumer, createPersistence } from "./event-bus/persistence.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import { createS3Storage } from "./storage/s3.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { createEventSource } from "./event-source.js";
import { loadWorkflows } from "./loader.js";
import { createHttpLogger, createLogger } from "./logger.js";
import type { Service } from "./services/index.js";
import { createScheduler } from "./services/scheduler.js";
import { createServer } from "./services/server.js";
import { dashboardMiddleware } from "./dashboard/middleware.js";
import { triggerMiddleware } from "./trigger/middleware.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./triggers/http.js";

function createStorageBackend(config: ReturnType<typeof createConfig>): StorageBackend | undefined {
	if (config.persistenceS3Bucket) {
		return createS3Storage({
			bucket: config.persistenceS3Bucket,
			accessKeyId: config.persistenceS3AccessKeyId ?? "",
			secretAccessKey: config.persistenceS3SecretAccessKey ?? "",
			...(config.persistenceS3Endpoint ? { endpoint: config.persistenceS3Endpoint } : {}),
			...(config.persistenceS3Region ? { region: config.persistenceS3Region } : {}),
		});
	}
	if (config.persistencePath) {
		return createFsStorage(config.persistencePath);
	}
}

function initPersistence(
	config: ReturnType<typeof createConfig>,
	logger: ReturnType<typeof createLogger>,
): PersistenceConsumer | undefined {
	const backend = createStorageBackend(config);
	if (!backend) {
		return;
	}
	return createPersistence(backend, {
		concurrency: config.fileIoConcurrency,
		logger,
	});
}

function loadWorkflow(wf: WorkflowConfig) {
	const actions: Action[] = wf.actions.map((action) => ({
		name: action.name,
		on: action.on.name,
		handler: (ctx) =>
			action.handler({
				event: { name: ctx.event.type, payload: ctx.event.payload },
				emit: (type: string, payload: unknown) => ctx.emit(type, payload),
				env: ctx.env,
				fetch: (url, init) => ctx.fetch(url, init),
			}),
	}));

	return { actions, triggers: wf.triggers, events: wf.events };
}

function registerWorkflows(workflows: WorkflowConfig[]) {
	const registry = new HttpTriggerRegistry();
	const allActions: Action[] = [];
	const allEvents: Record<string, { parse(data: unknown): unknown }> = {};
	const allJsonSchemas: Record<string, object> = {};

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

		for (const [name, schema] of Object.entries(loaded.events)) {
			allJsonSchemas[name] = z.toJSONSchema(schema);
		}
	}

	return { registry, allActions, allEvents, allJsonSchemas };
}

async function init() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const contextLogger = createLogger("context", { level: config.logLevel });
	const eventLogger = createLogger("events", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	const workflows = await loadWorkflows(config.workflowDir, runtimeLogger);
	const { registry, allActions, allEvents, allJsonSchemas } = registerWorkflows(workflows);

	const workQueue = createWorkQueue();
	const eventStore = await createEventStore({ logger: runtimeLogger });
	const persistence = initPersistence(config, runtimeLogger);
	const logging = createLoggingConsumer(eventLogger);
	const consumers: BusConsumer[] = [];
	if (persistence) {
		consumers.push(persistence);
	}
	consumers.push(workQueue, eventStore, logging);
	const eventBus = createEventBus(consumers);

	const source = createEventSource(allEvents, eventBus);
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const createContext = createActionContext(source, globalThis.fetch, process.env, contextLogger);

	const scheduler = createScheduler(workQueue, source, allActions, createContext);
	const server = createServer(
		config.port,
		httpLogger,
		httpTriggerMiddleware(registry, source),
		dashboardMiddleware(eventStore),
		triggerMiddleware(allJsonSchemas, source),
	);

	return { runtimeLogger, eventBus, persistence, scheduler, server };
}

async function recover(persistence: PersistenceConsumer, eventBus: EventBus): Promise<void> {
	let total = 0;
	for await (const { events, pending } of persistence.recover()) {
		await eventBus.bootstrap(events, { pending });
		total += events.length;
	}
	await eventBus.bootstrap([], { finished: true, total });
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
		await recover(persistence, eventBus);
	}

	start(runtimeLogger, scheduler, server);
	runtimeLogger.info("main.started");
}

main();
