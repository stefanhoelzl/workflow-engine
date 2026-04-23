import { createSandboxFactory } from "@workflow-engine/sandbox";
import { apiMiddleware } from "./api/index.js";
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
import type { Service } from "./services/index.js";
import { secureHeadersMiddleware } from "./services/secure-headers.js";
import { createServer } from "./services/server.js";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import { createS3Storage } from "./storage/s3.js";
import { createCronTriggerSource } from "./triggers/cron.js";
import type { Middleware } from "./triggers/http.js";
import { createHttpTriggerSource } from "./triggers/http.js";
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: entry-point initialization wires all components
async function init() {
	// biome-ignore lint/style/noProcessEnv: entry-point config
	const config = createConfig(process.env);

	const runtimeLogger = createLogger("runtime", { level: config.logLevel });
	const httpLogger = createHttpLogger("http", { level: config.logLevel });
	const eventLogger = createLogger("events", { level: config.logLevel });

	runtimeLogger.info("initialize", { config });

	if (config.auth.mode === "disabled") {
		runtimeLogger.warn("auth.disabled");
	} else if (config.auth.mode === "open") {
		runtimeLogger.warn("auth.open");
	} else {
		runtimeLogger.info("auth.restricted", {
			users: config.auth.users.size,
			orgs: config.auth.orgs.size,
		});
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
	// 3. Construct the sandbox factory + store. The store is keyed by
	//    (tenant, workflow.sha); sandboxes live for process lifetime.
	const sandboxFactory = createSandboxFactory({ logger: runtimeLogger });
	const sandboxStore = createSandboxStore({
		sandboxFactory,
		logger: runtimeLogger,
	});

	// 5. Create the executor (serializes per-(tenant, sha) invocations;
	//    resolves sandboxes via the store; emits trigger.* events through
	//    the bus).
	const executor = createExecutor({ bus: eventBus, sandboxStore });

	// 5a. Construct trigger backends. Each backend is a protocol adapter for
	//     one trigger kind; backends plug into WorkflowRegistry which pushes
	//     `reconfigure(tenant, entries)` per upload. Backends never touch
	//     the executor directly — the registry builds `fire` closures via
	//     `buildFire` and attaches them to each `TriggerEntry`.
	//     main.ts owns start/stop lifecycle.
	const httpSource = createHttpTriggerSource();
	const cronSource = createCronTriggerSource({
		logger: runtimeLogger,
	});
	const manualSource = createManualTriggerSource();
	const triggerBackends = [httpSource, cronSource, manualSource];
	await Promise.all(triggerBackends.map((s) => s.start()));

	// 6. Workflow registry. Boots from the storage backend by LISTing
	//    `workflows/*.tar.gz` tenant bundles. Calls `reconfigure(tenant,
	//    entries)` on every registered backend for every successful upload.
	const registry = createWorkflowRegistry({
		logger: runtimeLogger,
		executor,
		backends: triggerBackends,
		...(storageBackend ? { storageBackend } : {}),
	});
	if (storageBackend) {
		await registry.recover();
	}
	runtimeLogger.info("workflows.loaded", { count: registry.size });

	// 5. Sweep crashed pending invocations before binding the HTTP port.
	if (storageBackend) {
		await recover(
			{ backend: storageBackend, eventStore, logger: runtimeLogger },
			eventBus,
		);
	}

	// Auth wiring. sessionMw gates `/dashboard/*` and `/trigger/*`; `/auth/*`
	// is only mounted in restricted mode (login/callback/logout). In open or
	// disabled mode there is no login flow to host.
	// biome-ignore lint/style/noProcessEnv: entry-point config read
	const localDeployment = Boolean(process.env.LOCAL_DEPLOYMENT);
	const secureCookies = !localDeployment;
	const sessionMw = sessionMiddleware({
		auth: config.auth,
		secureCookies,
	});
	const authRoutes: Middleware[] =
		config.auth.mode === "restricted" &&
		config.githubOauthClientId !== undefined &&
		config.githubOauthClientSecret !== undefined &&
		config.baseUrl !== undefined
			? (() => {
					const opts = {
						auth: config.auth,
						clientId: config.githubOauthClientId,
						clientSecret: config.githubOauthClientSecret.reveal(),
						baseUrl: config.baseUrl,
						secureCookies,
					};
					return [loginPageMiddleware(opts), authMiddleware(opts)];
				})()
			: [];

	// 6. Wire the HTTP server. Order matters: secure-headers → logger →
	//    health → static → webhooks (httpTrigger) → /auth (OAuth routes,
	//    unprotected) → /dashboard (UI, session-guarded) → /trigger (UI,
	//    session-guarded) → /api. The session middleware is mounted
	//    inside the dashboard/trigger middleware factories.
	const server = createServer(
		config.port,
		secureHeadersMiddleware({
			// biome-ignore lint/style/noProcessEnv: entry-point config read
			localDeployment: process.env.LOCAL_DEPLOYMENT,
		}),
		httpLogger,
		healthMiddleware({ eventStore, storageBackend, baseUrl: config.baseUrl }),
		staticMiddleware(),
		httpSource.middleware,
		...authRoutes,
		dashboardMiddleware({ eventStore, registry, sessionMw }),
		triggerMiddleware({ registry, sessionMw }),
		apiMiddleware({
			auth: config.auth,
			registry,
			logger: runtimeLogger,
		}),
	);

	const sandboxService: Service = {
		start: () => Promise.resolve(),
		async stop() {
			await Promise.allSettled(triggerBackends.map((s) => s.stop()));
			sandboxStore.dispose();
			await sandboxFactory.dispose();
		},
	};

	return { runtimeLogger, server, sandboxService };
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
	const { runtimeLogger, server, sandboxService } = await init();
	runtimeLogger.info("main.initialized");

	start(runtimeLogger, server, sandboxService);
	runtimeLogger.info("main.started");
}

main();
