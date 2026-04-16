import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventStore } from "./event-bus/event-store.js";
import { createEventBus } from "./event-bus/index.js";
import {
	createPersistence,
	type InvocationRecord,
	scanArchive,
	scanPending,
} from "./event-bus/persistence.js";
import { createExecutor } from "./executor/index.js";
import { recover } from "./recovery.js";
import { createFsStorage } from "./storage/fs.js";
import { httpTriggerMiddleware } from "./triggers/http.js";
import {
	createWorkflowRegistry,
	loadWorkflows,
	type WorkflowRegistry,
} from "./workflow-registry.js";

// ---------------------------------------------------------------------------
// Phase 4 end-to-end integration test
// ---------------------------------------------------------------------------
//
// Drives the full v1 startup pipeline: storage → bus + consumers (persistence
// + event-store + logging) → workflow registry loading a fixture manifest +
// bundle → executor → recover() (no-op on empty pending) → HTTP middleware
// wired up through Hono. Then fires a simulated webhook and asserts:
//   1. The handler's HttpTriggerResult is returned.
//   2. An archive/<id>.json record exists (persistence).
//   3. The event-store has an indexed row.
//
// Uses the same inline fixture bundle pattern as workflow-registry.test.ts.

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

function fixtureBundleSource(options?: {
	strictStringOutput?: boolean;
}): string {
	// Output schema behaviour is toggleable so one test can assert the
	// success path and another can assert SDK-wrapper output-validation
	// failure (returning {greeting} while the output schema requires a
	// string).
	const outputSchemaDecl = options?.strictStringOutput
		? `{ parse: (x) => { if (typeof x !== "string") { const err = new Error("output validation failed"); err.name = "ValidationError"; err.issues = [{path: [], message: "Expected string"}]; throw err; } return x; } }`
		: "{ parse: (x) => x }";
	return `
const ACTION_BRAND = Symbol.for("@workflow-engine/action");
const HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger");
const WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow");

export const workflow = Object.freeze({
	[WORKFLOW_BRAND]: true,
	name: "integration",
	env: Object.freeze({}),
});

function makeAction(handler, input, output) {
	let assignedName;
	const callable = async function callAction(x) {
		if (assignedName === undefined) throw new Error("unbound action");
		await globalThis.__hostCallAction(assignedName, x);
		const out = await handler(x);
		return output.parse(out);
	};
	Object.defineProperty(callable, ACTION_BRAND, { value: true, enumerable: false });
	Object.defineProperty(callable, "input", { value: input });
	Object.defineProperty(callable, "output", { value: output });
	Object.defineProperty(callable, "handler", { value: handler });
	Object.defineProperty(callable, "name", { get: () => assignedName ?? "" });
	Object.defineProperty(callable, "__setActionName", {
		value: (name) => { if (!assignedName) assignedName = name; },
	});
	return callable;
}

const passThrough = { parse: (x) => x };
const outputSchema = ${outputSchemaDecl};

export const greet = makeAction(
	async (input) => ({ greeting: "hello " + input.name }),
	passThrough,
	outputSchema,
);

export const hello = Object.freeze({
	[HTTP_TRIGGER_BRAND]: true,
	path: "hello",
	method: "POST",
	body: passThrough,
	params: passThrough,
	query: undefined,
	handler: async (payload) => {
		const result = await greet({ name: payload.body.name });
		return { status: 200, body: result };
	},
});
`;
}

interface Setup {
	registry: WorkflowRegistry;
	app: Hono;
	persistencePath: string;
	workflowsDir: string;
	eventStore: Awaited<ReturnType<typeof createEventStore>>;
}

async function setupIntegration(): Promise<Setup> {
	const root = await mkdtemp(join(tmpdir(), "wf-integration-"));
	const persistencePath = join(root, "persistence");
	const workflowsDir = join(root, "workflows");

	// Storage.
	const storage = createFsStorage(persistencePath);
	await storage.init();

	// Event bus + consumers.
	const eventStore = await createEventStore({
		logger: silentLogger,
		persistence: { backend: storage },
	});
	await eventStore.initialized;
	const persistence = createPersistence(storage, { logger: silentLogger });
	const bus = createEventBus([persistence, eventStore]);

	// Fixture workflow on disk.
	const fixtureDir = join(workflowsDir, "integration");
	const manifestPath = join(fixtureDir, "manifest.json");
	const bundlePath = join(fixtureDir, "integration.js");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(
		manifestPath,
		JSON.stringify(
			{
				name: "integration",
				module: "integration.js",
				env: {},
				actions: [
					{
						name: "greet",
						input: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
						output: {
							type: "object",
							properties: { greeting: { type: "string" } },
							required: ["greeting"],
						},
					},
				],
				triggers: [
					{
						name: "hello",
						type: "http",
						path: "hello",
						method: "POST",
						body: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
						params: [],
						schema: { type: "object" },
					},
				],
			},
			null,
			2,
		),
		{},
	);
	await writeFile(bundlePath, fixtureBundleSource(), {});

	// Registry + loading.
	const registry = createWorkflowRegistry({ logger: silentLogger });
	await loadWorkflows(registry, [manifestPath], { logger: silentLogger });

	// Executor.
	const executor = createExecutor({ bus });

	// Recover (no-op on empty pending).
	await recover({ backend: storage }, bus);

	// HTTP.
	const middleware = httpTriggerMiddleware(registry, executor);
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	if (middleware.match.endsWith("/*")) {
		app.all(middleware.match.slice(0, -2), middleware.handler);
	}

	return { registry, app, persistencePath, workflowsDir, eventStore };
}

describe("Phase 4 bootstrap integration", () => {
	const cleanups: (() => void | Promise<void>)[] = [];
	afterEach(async () => {
		for (const fn of cleanups) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
			await fn();
		}
		cleanups.length = 0;
	});

	it("end-to-end: webhook → executor → handler response → archive + event-store", async () => {
		const setup = await setupIntegration();
		cleanups.push(() => setup.registry.dispose());

		const res = await setup.app.request("/webhooks/hello", {
			method: "POST",
			body: JSON.stringify({ name: "world" }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ greeting: "hello world" });

		// Archive entry present.
		const storage = createFsStorage(setup.persistencePath);
		const archiveEntries: InvocationRecord[] = [];
		for await (const entry of scanArchive(storage)) {
			archiveEntries.push(entry);
		}
		expect(archiveEntries).toHaveLength(1);
		const entry = archiveEntries[0];
		expect(entry?.status).toBe("succeeded");
		expect(entry?.workflow).toBe("integration");
		expect(entry?.trigger).toBe("hello");

		// No pending entries left.
		const pendingEntries: InvocationRecord[] = [];
		for await (const p of scanPending(storage)) {
			pendingEntries.push(p);
		}
		expect(pendingEntries).toHaveLength(0);

		// EventStore indexed the invocation — dashboard list view reads
		// from this table, so 15.1 asserts it explicitly.
		const rows = await setup.eventStore.query.selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("succeeded");
		expect(rows[0]?.workflow).toBe("integration");
		expect(rows[0]?.trigger).toBe("hello");
	});

	it("404 when no trigger matches the webhook path", async () => {
		const setup = await setupIntegration();
		cleanups.push(() => setup.registry.dispose());

		const res = await setup.app.request("/webhooks/nope", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
	});

	it("422 when body fails validation — executor never invoked", async () => {
		const setup = await setupIntegration();
		cleanups.push(() => setup.registry.dispose());

		const res = await setup.app.request("/webhooks/hello", {
			method: "POST",
			body: JSON.stringify({ wrong: "shape" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("payload_validation_failed");

		// No archive entry because the executor was never invoked.
		const storage = createFsStorage(setup.persistencePath);
		const entries: InvocationRecord[] = [];
		for await (const e of scanArchive(storage)) {
			entries.push(e);
		}
		expect(entries).toHaveLength(0);
	});

	it("handler throw → 500 + failed archive entry", async () => {
		// This test exercises an in-sandbox output validation failure: the
		// SDK wrapper (emulated in the fixture) throws when the handler's
		// {greeting} return does not match a string output schema. That
		// surfaces as an uncaught rejection from `invokeHandler`, which
		// the executor records as a `failed` invocation + 500 response.
		const root = await mkdtemp(join(tmpdir(), "wf-integration-fail-"));
		const persistencePath = join(root, "persistence");
		const workflowsDir = join(root, "workflows");
		const fixtureDir = join(workflowsDir, "integration");
		const manifestPath = join(fixtureDir, "manifest.json");
		const bundlePath = join(fixtureDir, "integration.js");

		const storage = createFsStorage(persistencePath);
		await storage.init();
		const eventStore = await createEventStore({
			logger: silentLogger,
			persistence: { backend: storage },
		});
		await eventStore.initialized;
		const persistence = createPersistence(storage, { logger: silentLogger });
		const bus = createEventBus([persistence, eventStore]);

		// Action "greet" with a STRICT string output schema that the
		// in-sandbox handler's `{greeting}` return will fail — the SDK
		// wrapper surfaces that as a rejection.
		await mkdir(fixtureDir, { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify({
				name: "integration-fail",
				module: "integration.js",
				env: {},
				actions: [
					{
						name: "greet",
						input: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
						output: { type: "string" },
					},
				],
				triggers: [
					{
						name: "hello",
						type: "http",
						path: "hello",
						method: "POST",
						body: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
						params: [],
						schema: { type: "object" },
					},
				],
			}),
			{},
		);
		await writeFile(
			bundlePath,
			fixtureBundleSource({ strictStringOutput: true }),
			{},
		);

		const registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });
		cleanups.push(() => registry.dispose());
		const executor = createExecutor({ bus });

		const middleware = httpTriggerMiddleware(registry, executor);
		const app = new Hono();
		app.all(middleware.match, middleware.handler);
		if (middleware.match.endsWith("/*")) {
			app.all(middleware.match.slice(0, -2), middleware.handler);
		}

		const res = await app.request("/webhooks/hello", {
			method: "POST",
			body: JSON.stringify({ name: "world" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(500);

		const archiveEntries: InvocationRecord[] = [];
		for await (const e of scanArchive(storage)) {
			archiveEntries.push(e);
		}
		expect(archiveEntries).toHaveLength(1);
		expect(archiveEntries[0]?.status).toBe("failed");
	});
});
