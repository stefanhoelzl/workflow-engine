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
import { createEventStore } from "./event-store.js";
import { createExecutor } from "./executor/index.js";
import { healthMiddleware } from "./health.js";
import { createHttpLogger, createLogger } from "./logger.js";
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
import { isUpgradeProvider, type UpgradeProvider } from "./triggers/source.js";
import { createWsTriggerSource } from "./triggers/ws.js";
import { dashboardMiddleware } from "./ui/dashboard/middleware.js";
import { staticMiddleware } from "./ui/static/middleware.js";
import { triggerMiddleware } from "./ui/trigger/middleware.js";
import { createWorkflowRegistry } from "./workflow-registry.js";

function createStorageBackend(
	config: ReturnType<typeof createConfig>,
	_logger: ReturnType<typeof createLogger>,
): StorageBackend | undefined {
	if (config.persistenceS3Bucket) {
		const accessKeyId = config.persistenceS3AccessKeyId;
		const secretAccessKey = config.persistenceS3SecretAccessKey;
		if (!(accessKeyId && secretAccessKey)) {
			throw new Error(
				"PERSISTENCE_S3_ACCESS_KEY_ID and PERSISTENCE_S3_SECRET_ACCESS_KEY are required when PERSISTENCE_S3_BUCKET is set",
			);
		}
		return createS3Storage({
			bucket: config.persistenceS3Bucket,
			accessKeyId,
			secretAccessKey,
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

	// 2. Init EventStore. Opens the DuckLake catalog (downloaded for S3, opened
	//    locally for FS). Constant-time boot regardless of archived event count.
	if (!storageBackend) {
		throw new Error(
			"persistence backend is required: set PERSISTENCE_PATH or PERSISTENCE_S3_*",
		);
	}
	const eventStore = await createEventStore({
		backend: storageBackend,
		logger: runtimeLogger,
		config: {
			checkpointIntervalMs: config.eventStoreCheckpointIntervalMs,
			checkpointMaxInlinedRows: config.eventStoreCheckpointMaxInlinedRows,
			checkpointMaxCatalogBytes: config.eventStoreCheckpointMaxCatalogBytes,
			commitMaxRetries: config.eventStoreCommitMaxRetries,
			commitBackoffMs: config.eventStoreCommitBackoffMs,
			sigtermFlushTimeoutMs: config.eventStoreSigtermFlushTimeoutMs,
		},
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
	//    resolves sandboxes via the store; records trigger.* events directly
	//    against EventStore and emits invocation.* lifecycle log lines).
	const executor = createExecutor({
		eventStore,
		logger: eventLogger,
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
	const wsSource = createWsTriggerSource({
		logger: runtimeLogger,
		authRegistry,
	});
	const triggerBackends = [
		httpSource,
		cronSource,
		manualSource,
		imapSource,
		wsSource,
	];
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

	// 8. (No recovery scan in the new model — `pending/` is gone, in-flight
	//    invocations live in RAM, SIGKILL deliberately loses them.)

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
	const upgradeProviders: UpgradeProvider[] = [];
	for (const backend of triggerBackends) {
		if (isUpgradeProvider(backend)) {
			upgradeProviders.push(backend);
		}
	}
	const server = createServer(
		config.port,
		{ logger: runtimeLogger, upgradeProviders },
		secureHeadersMiddleware({
			localDeployment: config.localDeployment,
		}),
		httpLogger,
		healthMiddleware({
			eventStore,
			baseUrl: config.baseUrl,
			gitSha: config.gitSha,
		}),
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
			eventStore,
		}),
	);

	const sandboxService: Service = {
		start: () => Promise.resolve(),
		async stop() {
			await Promise.allSettled(triggerBackends.map((s) => s.stop()));
			await sandboxStore.dispose();
			await eventStore.drainAndClose();
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
