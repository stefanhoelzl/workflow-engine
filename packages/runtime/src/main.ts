import { createConfig } from "./config.js";
import { createActionContext } from "./context/index.js";
import type { BusConsumer, EventBus } from "./event-bus/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createEventStore } from "./event-bus/event-store.js";
import { createLoggingConsumer } from "./event-bus/logging-consumer.js";
import {
	type PersistenceConsumer,
	createPersistence,
} from "./event-bus/persistence.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import { createS3Storage } from "./storage/s3.js";
import { createWorkQueue } from "./event-bus/work-queue.js";
import { createEventSource } from "./event-source.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { createSandbox } from "./sandbox/index.js";
import type { Service } from "./services/index.js";
import { createScheduler } from "./services/scheduler.js";
import { createServer } from "./services/server.js";
import { dashboardMiddleware } from "./dashboard/middleware.js";
import { triggerMiddleware } from "./trigger/middleware.js";
import { healthMiddleware } from "./health.js";
import { httpTriggerMiddleware } from "./triggers/http.js";
import { createWorkflowRegistry } from "./workflow-registry.js";
import { apiMiddleware } from "./api/index.js";

function createStorageBackend(
	config: ReturnType<typeof createConfig>,
): StorageBackend | undefined {
	if (config.persistenceS3Bucket) {
		return createS3Storage({
			bucket: config.persistenceS3Bucket,
			accessKeyId: config.persistenceS3AccessKeyId ?? "",
			secretAccessKey: config.persistenceS3SecretAccessKey ?? "",
			...(config.persistenceS3Endpoint
				? { endpoint: config.persistenceS3Endpoint }
				: {}),
			...(config.persistenceS3Region
				? { region: config.persistenceS3Region }
				: {}),
		});
	}
	if (config.persistencePath) {
		return createFsStorage(config.persistencePath);
	}
}

function initPersistence(
	backend: StorageBackend | undefined,
	config: ReturnType<typeof createConfig>,
	logger: ReturnType<typeof createLogger>,
): PersistenceConsumer | undefined {
	if (!backend) {
		return;
	}
	return createPersistence(backend, {
		concurrency: config.fileIoConcurrency,
		logger,
	});
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: entry-point initialization wires all components
async function init() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const contextLogger = createLogger("context", { level: config.logLevel });
	const eventLogger = createLogger("events", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	// 1. Init storage backend
	const storageBackend = createStorageBackend(config);
	if (storageBackend) {
		await storageBackend.init();
	}

	// 2. Init event bus + consumers
	const workQueue = createWorkQueue();
	const eventStore = await createEventStore({ logger: runtimeLogger });
	const persistence = initPersistence(storageBackend, config, runtimeLogger);
	const logging = createLoggingConsumer(eventLogger);
	const consumers: BusConsumer[] = [];
	if (persistence) {
		consumers.push(persistence);
	}
	consumers.push(workQueue, eventStore, logging);
	const eventBus = createEventBus(consumers);

	// 3. Recover events
	if (persistence) {
		await recover(persistence, eventBus);
	}

	// 4. Load workflows from storage backend
	const registry = createWorkflowRegistry({
		backend: storageBackend,
		logger: runtimeLogger,
	});
	await registry.recover();

	// Wire up event source and scheduler using registry getters
	const source = createEventSource(registry, eventBus);
	const createContext = createActionContext(
		source,
		globalThis.fetch,
		contextLogger,
	);
	const sandbox = await createSandbox();

	const scheduler = createScheduler(
		workQueue,
		source,
		registry,
		createContext,
		sandbox,
	);

	const server = createServer(
		config.port,
		httpLogger,
		healthMiddleware({ eventStore, storageBackend, baseUrl: config.baseUrl }),
		httpTriggerMiddleware(registry, source),
		dashboardMiddleware(eventStore),
		triggerMiddleware(registry, source),
		...apiMiddleware({ registry, githubUser: config.githubUser }),
	);

	return { runtimeLogger, scheduler, server };
}

async function recover(
	persistence: PersistenceConsumer,
	eventBus: EventBus,
): Promise<void> {
	let total = 0;
	for await (const { events, pending } of persistence.recover()) {
		await eventBus.bootstrap(events, { pending });
		total += events.length;
	}
	await eventBus.bootstrap([], { finished: true, total });
}

function start(
	logger: ReturnType<typeof createLogger>,
	...services: Service[]
) {
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
	const { runtimeLogger, scheduler, server } = await init();
	runtimeLogger.info("main.initialized");

	// 5. Start scheduler + server
	start(runtimeLogger, scheduler, server);
	runtimeLogger.info("main.started");
}

main();
