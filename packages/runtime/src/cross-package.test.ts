import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowPlugin } from "@workflow-engine/sdk/vite-plugin";
import { Hono } from "hono";
import { build as viteBuild } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventStore } from "./event-bus/event-store.js";
import { createEventBus } from "./event-bus/index.js";
import {
	createPersistence,
	type InvocationRecord,
	scanArchive,
} from "./event-bus/persistence.js";
import { createExecutor } from "./executor/index.js";
import { createFsStorage } from "./storage/fs.js";
import { httpTriggerMiddleware } from "./triggers/http.js";
import {
	createWorkflowRegistry,
	loadWorkflows,
	type WorkflowRegistry,
} from "./workflow-registry.js";

// ---------------------------------------------------------------------------
// Cross-package integration test (Task 15.3)
// ---------------------------------------------------------------------------
//
// Validates the full SDK → vite-plugin → runtime seam using the REAL
// vite-plugin (not an inline fixture bundle like integration.test.ts).
// Steps per test:
//   1. Write a fixture workflow `.ts` that imports `@workflow-engine/sdk`
//      and declares one action + one http trigger.
//   2. Invoke the workflow-engine vite plugin programmatically to produce
//      `<tmp>/dist/<name>/manifest.json` + `<tmp>/dist/<name>/<name>.js`.
//   3. Load the built manifest + bundle via the runtime's workflow registry.
//   4. Boot the full runtime stack (storage + bus + consumers + executor +
//      http middleware).
//   5. Fire a webhook, assert the handler response, assert an archive
//      record was persisted.
//
// This validates:
//   - Brand-symbol discovery works on a plugin-bundled artifact (vs. our
//     hand-rolled fixture bundles).
//   - The plugin wrote the correct manifest shape + JSON Schemas.
//   - The plugin embedded the SDK action wrapper + Zod bundle so in-sandbox
//     dispatch (D11) works with the sandbox's __hostCallAction bridge.
//   - The runtime can load the artifacts unchanged and route a webhook
//     through to the handler, returning the handler's computed response.

const silentLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(function child() {
		return silentLogger;
	}),
};

// A minimal workflow source using the real v1 SDK. The action doubles a
// number; the trigger invokes it directly and returns the result. Env has
// one var with a default so no process.env setup is required.
const FIXTURE_SOURCE = `
import { action, defineWorkflow, env, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		GREETING: env({ default: "hello" }),
	},
});

export const doubler = action({
	input: z.object({ value: z.number() }),
	output: z.object({ doubled: z.number() }),
	handler: async ({ value }) => ({ doubled: value * 2 }),
});

export const echo = httpTrigger({
	path: "echo",
	body: z.object({ value: z.number() }),
	handler: async ({ body }) => {
		const { doubled } = await doubler({ value: body.value });
		return {
			status: 200,
			body: { greeting: workflow.env.GREETING, doubled },
		};
	},
});
`;

// Location of the runtime package on disk (this test file lives under
// packages/runtime/src/). We write the fixture .ts file + its build output
// inside that package (outside `src/` so tsc --build does not include it)
// so node module resolution finds the SDK through the runtime's own
// node_modules — otherwise the plugin's pre-bundle TypeScript check can't
// resolve `@workflow-engine/sdk`.
const RUNTIME_PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

async function buildFixture(workflowName: string): Promise<{
	distDir: string;
	manifestPath: string;
	bundlePath: string;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(RUNTIME_PKG_DIR, ".wf-cross-build-"));
	const workflowFile = `${workflowName}.ts`;
	await writeFile(join(root, workflowFile), FIXTURE_SOURCE, "utf8");

	await viteBuild({
		configFile: false,
		logLevel: "silent",
		root,
		build: {
			outDir: "dist",
			emptyOutDir: true,
		},
		plugins: [workflowPlugin({ workflows: [`./${workflowFile}`] })],
	});

	const distDir = join(root, "dist", workflowName);
	return {
		distDir,
		manifestPath: join(distDir, "manifest.json"),
		bundlePath: join(distDir, `${workflowName}.js`),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

interface Setup {
	registry: WorkflowRegistry;
	app: Hono;
	persistencePath: string;
}

async function setupRuntime(manifestPath: string): Promise<Setup> {
	const root = await mkdtemp(join(tmpdir(), "wf-cross-runtime-"));
	const persistencePath = join(root, "persistence");
	await mkdir(persistencePath, { recursive: true });

	const storage = createFsStorage(persistencePath);
	await storage.init();

	const eventStore = await createEventStore({
		logger: silentLogger,
		persistence: { backend: storage },
	});
	await eventStore.initialized;
	const persistence = createPersistence(storage, { logger: silentLogger });
	const bus = createEventBus([persistence, eventStore]);

	const registry = createWorkflowRegistry({ logger: silentLogger });
	await loadWorkflows(registry, [manifestPath], { logger: silentLogger });

	const executor = createExecutor({ bus });

	const middleware = httpTriggerMiddleware(registry, executor);
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	if (middleware.match.endsWith("/*")) {
		app.all(middleware.match.slice(0, -2), middleware.handler);
	}

	return { registry, app, persistencePath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The plugin does a full Vite sub-build per workflow (typecheck + rolldown),
// which takes a couple of seconds in a cold Node import cache — give vitest
// breathing room.
const CROSS_PACKAGE_TEST_TIMEOUT_MS = 60_000;

describe("cross-package: SDK → vite-plugin → runtime", () => {
	const cleanups: (() => void | Promise<void>)[] = [];
	afterEach(async () => {
		for (const fn of cleanups) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
			await fn();
		}
		cleanups.length = 0;
	});

	it(
		"builds a fixture workflow via the real vite-plugin, loads it, and serves a webhook end-to-end",
		async () => {
			const built = await buildFixture("xpkg");
			cleanups.push(built.cleanup);

			// Sanity-check the plugin output before handing it to the runtime.
			const manifestRaw = await readFile(built.manifestPath, "utf8");
			const parsedManifest = JSON.parse(manifestRaw) as {
				name: string;
				module: string;
				env: Record<string, string>;
				actions: Array<{ name: string }>;
				triggers: Array<{ name: string; type: string; path: string }>;
			};
			expect(parsedManifest.name).toBe("xpkg");
			expect(parsedManifest.module).toBe("xpkg.js");
			expect(parsedManifest.env).toEqual({ GREETING: "hello" });
			expect(parsedManifest.actions).toEqual([
				expect.objectContaining({ name: "doubler" }),
			]);
			expect(parsedManifest.triggers).toEqual([
				expect.objectContaining({
					name: "echo",
					type: "http",
					path: "echo",
				}),
			]);

			// Load + boot the runtime against the real artifacts.
			const setup = await setupRuntime(built.manifestPath);
			cleanups.push(() => setup.registry.dispose());

			// Fire a webhook; the handler runs in the sandbox, calls the
			// action via the SDK wrapper + __hostCallAction bridge, and
			// returns a computed response.
			const res = await setup.app.request("/webhooks/echo", {
				method: "POST",
				body: JSON.stringify({ value: 21 }),
				headers: { "Content-Type": "application/json" },
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				greeting: "hello",
				doubled: 42,
			});

			// One archive record, status=succeeded, with the expected trigger.
			const storage = createFsStorage(setup.persistencePath);
			const entries: InvocationRecord[] = [];
			for await (const entry of scanArchive(storage)) {
				entries.push(entry);
			}
			expect(entries).toHaveLength(1);
			expect(entries[0]?.status).toBe("succeeded");
			expect(entries[0]?.workflow).toBe("xpkg");
			expect(entries[0]?.trigger).toBe("echo");
		},
		CROSS_PACKAGE_TEST_TIMEOUT_MS,
	);
});
