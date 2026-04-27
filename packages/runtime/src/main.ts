import { createSandboxFactory } from "@workflow-engine/sandbox";
import { apiMiddleware } from "./api/index.js";
import {
	buildProviderFactories,
	buildRegistry,
	type ProviderRegistry,
} from "./auth/providers/index.js";
import { authMiddleware, loginPageMiddleware } from "./auth/routes.js";
import { sessionMiddleware } from "./auth/session-mw.js";
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
import { createSandboxStore } from "./sandbox-store.js";
import { createKeyStore, readyCrypto } from "./secrets/index.js";
import type { Service } from "./services/index.js";
import { secureHeadersMiddleware } from "./services/secure-headers.js";
import { createServer } from "./services/server.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import { createS3Storage } from "./storage/s3.js";
import { createCronTriggerSource } from "./triggers/cron.js";
import type { Middleware } from "./triggers/http.js";
import { createHttpTriggerSource } from "./triggers/http.js";
import { createImapTriggerSource } from "./triggers/imap.js";
import { createManualTriggerSource } from "./triggers/manual.js";
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

function logRegistry(
	logger: ReturnType<typeof createLogger>,
	registry: ProviderRegistry,
) {
	if (registry.providers.length === 0) {
		logger.warn("auth.no-providers");
		return;
	}
	const counts = registry.providers.map((p) => ({ id: p.id }));
	logger.info("auth.providers-registered", {
		count: registry.providers.length,
		providers: counts,
	});
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: entry-point initialization wires all components
async function init() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	// libsodium is WASM-backed; initialise once before building the key-store.
	await readyCrypto();
	const keyStore = createKeyStore(config.secretsPrivateKeys.reveal());

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const eventLogger = createLogger("events", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	const localDeployment = config.localDeployment === "1";
	const secureCookies = !localDeployment;

	// biome-ignore lint/style/noProcessEnv: provider factory list reads LOCAL_DEPLOYMENT
	const factories = buildProviderFactories(process.env);
	const authRegistry = buildRegistry(config.authAllow, factories, {
		secureCookies,
		nowFn: () => Date.now(),
		...(config.githubOauthClientId === undefined
			? {}
			: { clientId: config.githubOauthClientId }),
		...(config.githubOauthClientSecret === undefined
			? {}
			: { clientSecret: config.githubOauthClientSecret.reveal() }),
		...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
	});
	logRegistry(runtimeLogger, authRegistry);

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
	const eventBus: EventBus = createEventBus(consumers, {
		logger: runtimeLogger,
	});

	// Deprecation warning for removed filesystem-bootstrap env vars.
	const legacyWorkflowsDir =
		// biome-ignore lint/style/noProcessEnv: entry-point config read for deprecation warning
		process.env.WORKFLOWS_DIR ?? process.env.WORKFLOW_DIR;
	if (legacyWorkflowsDir) {
		runtimeLogger.warn("workflows.dir-env-ignored", {
			value: legacyWorkflowsDir,
			note: "workflow bootstrap is now storage-backend only; upload via `wfe upload --owner <name>`",
		});
	}

	// 3 + 4. Construct the sandbox factory and sandbox store. The store is
	//        keyed by (owner, workflow.sha); sandboxes live for process
	//        lifetime.
	const sandboxFactory = createSandboxFactory({
		logger: runtimeLogger,
		memoryBytes: config.sandboxLimitMemoryBytes,
		stackBytes: config.sandboxLimitStackBytes,
		cpuMs: config.sandboxLimitCpuMs,
		outputBytes: config.sandboxLimitOutputBytes,
		pendingCallables: config.sandboxLimitPendingCallables,
	});
	const sandboxStore = createSandboxStore({
		sandboxFactory,
		logger: runtimeLogger,
		keyStore,
		maxCount: config.sandboxMaxCount,
	});

	// 5. Create the executor (serializes per-(owner, sha) invocations;
	//    resolves sandboxes via the store; emits trigger.* events through
	//    the bus).
	const executor = createExecutor({
		bus: eventBus,
		sandboxStore,
	});

	// 6. Construct trigger backends and start them. Every backend's start()
	//    MUST complete before registry.recover() runs, because recover()
	//    drives reconfigure() on each backend.
	const httpSource = createHttpTriggerSource();
	const cronSource = createCronTriggerSource({
		logger: runtimeLogger,
	});
	const manualSource = createManualTriggerSource();
	const imapSource = createImapTriggerSource({
		logger: runtimeLogger,
	});
	const triggerBackends = [httpSource, cronSource, manualSource, imapSource];
	await Promise.all(triggerBackends.map((s) => s.start()));

	// 7. Workflow registry. Boots from the storage backend by LISTing
	//    `workflows/*.tar.gz` owner bundles and reconfiguring every
	//    started backend with the persisted owner entries.
	const registry = createWorkflowRegistry({
		logger: runtimeLogger,
		executor,
		keyStore,
		backends: triggerBackends,
		...(storageBackend ? { storageBackend } : {}),
	});
	if (storageBackend) {
		await registry.recover();
	}
	runtimeLogger.info("workflows.loaded", { count: registry.size });

	// 8. Sweep crashed pending invocations before binding the HTTP port.
	if (storageBackend) {
		await recover(
			{ backend: storageBackend, eventStore, logger: runtimeLogger },
			eventBus,
		);
	}

	// Auth wiring. sessionMw gates `/dashboard/*` and `/trigger/*`;
	// loginPageMiddleware renders the login card; authMiddleware mounts
	// per-provider routes under /auth/<id>/* and /auth/logout.
	const sessionMw = sessionMiddleware({
		registry: authRegistry,
		secureCookies,
	});
	const authRoutes: Middleware[] = [
		loginPageMiddleware({ secureCookies, registry: authRegistry }),
		authMiddleware({ secureCookies, registry: authRegistry }),
	];

	// 9. Wire the HTTP server. Order matters: secure-headers → logger →
	//    health → static → webhooks (httpTrigger) → /auth (login + per-provider
	//    routes, unprotected) → /dashboard (UI, session-guarded) → /trigger
	//    (UI, session-guarded) → /api. The session middleware is mounted
	//    inside the dashboard/trigger middleware factories.
	const server = createServer(
		config.port,
		{ logger: runtimeLogger },
		secureHeadersMiddleware({
			localDeployment: config.localDeployment,
		}),
		httpLogger,
		healthMiddleware({ eventStore, storageBackend, baseUrl: config.baseUrl }),
		staticMiddleware(),
		httpSource.middleware,
		...authRoutes,
		dashboardMiddleware({ eventStore, registry, sessionMw }),
		triggerMiddleware({ registry, sessionMw }),
		apiMiddleware({
			authRegistry,
			registry,
			logger: runtimeLogger,
			keyStore,
			bus: eventBus,
			eventStore,
		}),
	);

	const sandboxService: Service = {
		start: () => Promise.resolve(),
		async stop() {
			await Promise.allSettled(triggerBackends.map((s) => s.stop()));
			await sandboxStore.dispose();
		},
	};

	return { runtimeLogger, server, sandboxService, httpSource };
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
		const startedAt = Date.now();
		logger.info(code === 0 ? "shutting-down" : "shutting-down-on-error");
		await Promise.allSettled(services.map((s) => s.stop()));
		logger.info("shutdown.complete", {
			code,
			durationMs: Date.now() - startedAt,
		});
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
	const { runtimeLogger, server, sandboxService, httpSource } = await init();
	runtimeLogger.info("main.initialized");

	start(runtimeLogger, server, sandboxService);
	httpSource.markReady();
	runtimeLogger.info("main.started");
}

main();
// 1777133046701353883
// 1777161535758443155
