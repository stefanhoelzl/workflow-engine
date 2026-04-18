import { apiMiddleware } from "./api/index.js";
import { createConfig } from "./config.js";
import { createEventStore } from "./event-bus/event-store.js";
import type { BusConsumer, EventBus } from "./event-bus/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createLoggingConsumer } from "./event-bus/logging-consumer.js";
import {
	createPersistence,
	type PersistenceConsumer,
} from "./event-bus/persistence.js";
import { createExecutor } from "./executor/index.js";
import { healthMiddleware } from "./health.js";
import { createHttpLogger, createLogger } from "./logger.js";
import { recover } from "./recovery.js";
import type { Service } from "./services/index.js";
import { secureHeadersMiddleware } from "./services/secure-headers.js";
import { createServer } from "./services/server.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import { createS3Storage } from "./storage/s3.js";
import { httpTriggerMiddleware } from "./triggers/http.js";
import { dashboardMiddleware } from "./ui/dashboard/middleware.js";
import { staticMiddleware } from "./ui/static/middleware.js";
import { triggerMiddleware } from "./ui/trigger/middleware.js";
import { createWorkflowRegistry } from "./workflow-registry.js";

function createStorageBackend(
	config: ReturnType<typeof createConfig>,
	logger: ReturnType<typeof createLogger>,
): StorageBackend | undefined {
	if (config.persistenceS3Bucket) {
		return createS3Storage({
			bucket: config.persistenceS3Bucket,
			accessKeyId: config.persistenceS3AccessKeyId?.reveal() ?? "",
			secretAccessKey: config.persistenceS3SecretAccessKey?.reveal() ?? "",
			logger,
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
	logger: ReturnType<typeof createLogger>,
): PersistenceConsumer | undefined {
	if (!backend) {
		return;
	}
	return createPersistence(backend, { logger });
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: entry-point initialization wires all components
async function init() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const eventLogger = createLogger("events", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	if (config.githubAuth.mode === "disabled") {
		runtimeLogger.warn("api-auth.disabled");
	} else if (config.githubAuth.mode === "open") {
		runtimeLogger.warn("api-auth.open");
	}

	// 1. Init storage backend.
	const storageBackend = createStorageBackend(config, runtimeLogger);
	if (storageBackend) {
		await storageBackend.init();
	}

	// 2. Init event bus + consumers. EventStore bootstraps from archive at
	//    consumer init; await `initialized` before proceeding.
	const eventStore = await createEventStore({
		logger: runtimeLogger,
		...(storageBackend ? { persistence: { backend: storageBackend } } : {}),
	});
	await eventStore.initialized;
	const persistence = initPersistence(storageBackend, runtimeLogger);
	const logging = createLoggingConsumer(eventLogger);
	const consumers: BusConsumer[] = [];
	if (persistence) {
		consumers.push(persistence);
	}
	consumers.push(eventStore, logging);
	const eventBus: EventBus = createEventBus(consumers);

	// 3. Workflow registry. Boots from the storage backend by LISTing
	//    `workflows/*.tar.gz` tenant bundles. Previously supported a
	//    filesystem bootstrap via `WORKFLOWS_DIR` — removed; operators
	//    who still have either env var set get a warn log.
	const legacyWorkflowsDir =
		// biome-ignore lint/style/noProcessEnv: entry-point config read for deprecation warning
		process.env.WORKFLOWS_DIR ?? process.env.WORKFLOW_DIR;
	if (legacyWorkflowsDir) {
		runtimeLogger.warn("workflows.dir-env-ignored", {
			value: legacyWorkflowsDir,
			note: "workflow bootstrap is now storage-backend only; upload via `wfe upload --tenant <name>`",
		});
	}
	const registry = createWorkflowRegistry({
		logger: runtimeLogger,
		...(storageBackend ? { storageBackend } : {}),
	});
	if (storageBackend) {
		await registry.recover();
	}
	runtimeLogger.info("workflows.loaded", { count: registry.runners.length });

	// 4. Create the executor (serializes per-workflow invocations; emits
	//    started/completed/failed through the bus).
	const executor = createExecutor({ bus: eventBus });

	// 5. Sweep crashed pending invocations before binding the HTTP port.
	if (storageBackend) {
		await recover(
			{ backend: storageBackend, eventStore, logger: runtimeLogger },
			eventBus,
		);
	}

	// 6. Wire the HTTP server. Order matters: secure-headers → logger →
	//    health → static → webhooks (httpTrigger) → /dashboard (UI) →
	//    /trigger (UI) → /api.
	const server = createServer(
		config.port,
		secureHeadersMiddleware({
			// biome-ignore lint/style/noProcessEnv: entry-point config read
			localDeployment: process.env.LOCAL_DEPLOYMENT,
		}),
		httpLogger,
		healthMiddleware({ eventStore, storageBackend, baseUrl: config.baseUrl }),
		staticMiddleware(),
		httpTriggerMiddleware(registry, executor),
		dashboardMiddleware({ eventStore, registry }),
		triggerMiddleware({ triggerRegistry: registry.triggerRegistry }),
		apiMiddleware({
			githubAuth: config.githubAuth,
			registry,
			logger: runtimeLogger,
		}),
	);

	return { runtimeLogger, server };
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
	const { runtimeLogger, server } = await init();
	runtimeLogger.info("main.initialized");

	start(runtimeLogger, server);
	runtimeLogger.info("main.started");
}

main();
