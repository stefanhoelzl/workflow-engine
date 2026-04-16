import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWorkflowRegistry,
	loadWorkflows,
	type WorkflowRegistry,
} from "./workflow-registry.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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

interface FixtureManifestAction {
	name: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
}

interface FixtureManifestTrigger {
	name: string;
	type: "http";
	path: string;
	method: string;
	body: Record<string, unknown>;
	params: string[];
	query?: Record<string, unknown>;
	schema: Record<string, unknown>;
}

interface FixtureManifest {
	name: string;
	module: string;
	env: Record<string, string>;
	actions: FixtureManifestAction[];
	triggers: FixtureManifestTrigger[];
}

async function makeFixture(
	manifest: FixtureManifest,
	bundleSource: string,
): Promise<{ dir: string; manifestPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "wf-registry-test-"));
	const manifestPath = join(dir, "manifest.json");
	const bundlePath = join(dir, manifest.module);
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
	await writeFile(bundlePath, bundleSource, "utf8");
	return { dir, manifestPath };
}

// A minimal v1 bundle built by hand. Each action/trigger export must carry
// the correct brand symbol for the registry's discovery to pick them up.
// The action callable mirrors the SDK's new wrapper model:
//   1. notify the host via __hostCallAction (input validation + audit log),
//   2. run the user handler in-sandbox via a direct JS call,
//   3. validate the handler output against the output schema.
// Using a passThrough schema (`parse: (x) => x`) here keeps the fixture
// small; the SDK's real wrapper uses inlined Zod.
function simpleBundleSource(): string {
	return `
const ACTION_BRAND = Symbol.for("@workflow-engine/action");
const HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger");
const WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow");

export const workflow = Object.freeze({
	[WORKFLOW_BRAND]: true,
	name: "fixture",
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

export const double = makeAction(
	async (x) => x * 2,
	passThrough,
	passThrough,
);

export const webhookTrigger = Object.freeze({
	[HTTP_TRIGGER_BRAND]: true,
	path: "test",
	method: "POST",
	body: passThrough,
	params: passThrough,
	query: undefined,
	handler: async (payload) => {
		const doubled = await double(payload.body.value);
		return { status: 200, body: { doubled } };
	},
});
`;
}

// When an action export is NOT declared in the manifest, the sandbox's
// name-binder never runs for it, so the SDK callable remains without a
// name and fails fast with "unbound action". (If a bundle bypasses the
// SDK and calls __hostCallAction directly with an unknown name, the
// dispatcher rejects it with "not declared in the manifest" — covered
// by the sandbox package's own host-call tests.)
const UNBOUND_ACTION_RE = /unbound action/;
const VALIDATION_RE = /validation/i;
const UNDECLARED_NOBODY_RE = /nobody.*not declared/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow-registry: v1 manifest loading", () => {
	let registry: WorkflowRegistry | null = null;

	afterEach(async () => {
		await registry?.dispose();
		registry = null;
	});

	it("exposes runners with name/env/actions/triggers (no events)", async () => {
		const manifest: FixtureManifest = {
			name: "fixture",
			module: "fixture.js",
			env: { FOO: "bar" },
			actions: [
				{
					name: "double",
					input: { type: "number" },
					output: { type: "number" },
				},
			],
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: "test",
					method: "POST",
					body: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, simpleBundleSource());

		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });

		expect(registry.runners).toHaveLength(1);
		const runner = registry.runners[0];
		expect(runner?.name).toBe("fixture");
		expect(runner?.env).toEqual({ FOO: "bar" });
		expect(runner?.actions).toEqual([
			expect.objectContaining({ name: "double" }),
		]);
		expect(runner?.triggers).toEqual([
			expect.objectContaining({
				name: "webhookTrigger",
				type: "http",
				path: "test",
				method: "POST",
			}),
		]);
		// No `events` field anywhere on the runner.
		expect("events" in (runner ?? {})).toBe(false);
	});

	it("registers http triggers with the trigger registry", async () => {
		const manifest: FixtureManifest = {
			name: "fixture",
			module: "fixture.js",
			env: {},
			actions: [
				{
					name: "double",
					input: { type: "number" },
					output: { type: "number" },
				},
			],
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: "test",
					method: "POST",
					body: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, simpleBundleSource());

		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });

		expect(registry.triggerRegistry.size).toBe(1);
		const match = registry.triggerRegistry.lookup("test", "POST");
		expect(match?.descriptor.name).toBe("webhookTrigger");
		expect(match?.workflow.name).toBe("fixture");
	});

	it("runs the full path: trigger handler -> SDK wrapper -> host bridge (validate+log) -> in-sandbox handler -> output", async () => {
		const manifest: FixtureManifest = {
			name: "fixture",
			module: "fixture.js",
			env: {},
			actions: [
				{
					name: "double",
					input: { type: "number" },
					output: { type: "number" },
				},
			],
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: "test",
					method: "POST",
					body: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, simpleBundleSource());

		// Spy on the logger.info call so we can confirm the dispatcher
		// audit-logs the action invocation.
		const auditLogger = {
			...silentLogger,
			info: vi.fn(),
		};

		registry = createWorkflowRegistry({ logger: auditLogger });
		await loadWorkflows(registry, [manifestPath], { logger: auditLogger });

		const runner = registry.runners[0];
		expect(runner).toBeDefined();
		if (!runner) {
			return;
		}

		// Invoke the trigger handler. The handler in the bundle calls
		// `double(21)`. The SDK wrapper (emulated in the fixture) posts to
		// __hostCallAction first (which validates input + logs), THEN runs
		// the handler (which returns 42) in-sandbox, THEN validates the
		// output schema. The host never dispatches the handler.
		const result = await runner.invokeHandler("webhookTrigger", {
			body: { value: 21 },
			headers: {},
			url: "http://host/webhooks/test",
			method: "POST",
			params: {},
			query: {},
		});
		expect(result).toEqual({ status: 200, body: { doubled: 42 } });

		// The dispatcher audit-logged the invocation with the validated
		// input. Exactly one `action.invoked` entry was emitted.
		const invokedCalls = auditLogger.info.mock.calls.filter(
			(c) => c[0] === "action.invoked",
		);
		expect(invokedCalls).toHaveLength(1);
		expect(invokedCalls[0]?.[1]).toMatchObject({
			workflow: "fixture",
			action: "double",
			input: 21,
		});
	});

	it("dispatcher rejects bad input before the sandbox handler runs", async () => {
		const manifest: FixtureManifest = {
			name: "fixture",
			module: "fixture.js",
			env: {},
			actions: [
				{
					name: "double",
					input: { type: "number" }, // handler will be called with a string
					output: { type: "number" },
				},
			],
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: "test",
					method: "POST",
					body: {
						// Let anything through at the trigger layer so we hit the
						// action-input boundary, not the trigger-input boundary.
						type: "object",
					},
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, simpleBundleSource());

		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });

		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("runner not loaded");
		}

		await expect(
			runner.invokeHandler("webhookTrigger", {
				body: { value: "not-a-number" }, // triggers double("not-a-number")
				headers: {},
				url: "http://host/webhooks/test",
				method: "POST",
				params: {},
				query: {},
			}),
		).rejects.toThrow(VALIDATION_RE);
	});

	it("rejects an action call when the name isn't declared in the manifest", async () => {
		const manifest: FixtureManifest = {
			name: "fixture",
			module: "fixture.js",
			env: {},
			actions: [], // NO double here — bundle calls it anyway.
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: "test",
					method: "POST",
					body: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, simpleBundleSource());

		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });
		const runner = registry.runners[0];
		expect(runner).toBeDefined();
		if (!runner) {
			return;
		}

		await expect(
			runner.invokeHandler("webhookTrigger", {
				body: { value: 5 },
				headers: {},
				url: "",
				method: "POST",
				params: {},
				query: {},
			}),
		).rejects.toThrow(UNBOUND_ACTION_RE);
	});

	it("dispatcher rejects __hostCallAction calls with unknown names", async () => {
		// The fixture bundle above goes through the SDK wrapper, which binds
		// the action's name before calling the host. To probe the dispatcher
		// directly we use a tiny bundle whose trigger handler reaches the
		// host bridge with a name that isn't in the manifest — the host
		// MUST reject it.
		const HTTP_TRIGGER_BRAND = "@workflow-engine/http-trigger";
		const bundle = `
const HTTP_TRIGGER_BRAND = Symbol.for(${JSON.stringify(HTTP_TRIGGER_BRAND)});
const passThrough = { parse: (x) => x };
export const shot = Object.freeze({
	[HTTP_TRIGGER_BRAND]: true,
	path: "shot",
	method: "POST",
	body: passThrough,
	params: passThrough,
	query: undefined,
	handler: async () => {
		await globalThis.__hostCallAction("nobody", {});
		return { status: 200, body: "unreachable" };
	},
});
`;
		const manifest: FixtureManifest = {
			name: "direct",
			module: "direct.js",
			env: {},
			actions: [],
			triggers: [
				{
					name: "shot",
					type: "http",
					path: "shot",
					method: "POST",
					body: { type: "object" },
					params: [],
					schema: { type: "object" },
				},
			],
		};
		const { manifestPath } = await makeFixture(manifest, bundle);
		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [manifestPath], { logger: silentLogger });
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("no runner");
		}
		await expect(
			runner.invokeHandler("shot", {
				body: {},
				headers: {},
				url: "",
				method: "POST",
				params: {},
				query: {},
			}),
		).rejects.toThrow(UNDECLARED_NOBODY_RE);
	});

	it("loads multiple workflows from multiple manifests", async () => {
		const makeManifest = (name: string): FixtureManifest => ({
			name,
			module: `${name}.js`,
			env: {},
			actions: [
				{
					name: "double",
					input: { type: "number" },
					output: { type: "number" },
				},
			],
			triggers: [
				{
					name: "webhookTrigger",
					type: "http",
					path: `trigger-${name}`,
					method: "POST",
					body: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
					params: [],
					schema: { type: "object" },
				},
			],
		});

		const m1 = makeManifest("alpha");
		const m2 = makeManifest("beta");

		// Fixtures: each bundle uses a unique filename to avoid Node ESM
		// import cache collisions.
		const dirAlpha = await mkdtemp(join(tmpdir(), "wf-reg-alpha-"));
		const dirBeta = await mkdtemp(join(tmpdir(), "wf-reg-beta-"));
		const alphaPath = join(dirAlpha, "manifest.json");
		const betaPath = join(dirBeta, "manifest.json");
		await writeFile(alphaPath, JSON.stringify(m1), "utf8");
		await writeFile(join(dirAlpha, "alpha.js"), simpleBundleSource(), "utf8");
		await writeFile(betaPath, JSON.stringify(m2), "utf8");
		await writeFile(join(dirBeta, "beta.js"), simpleBundleSource(), "utf8");

		registry = createWorkflowRegistry({ logger: silentLogger });
		await loadWorkflows(registry, [alphaPath, betaPath], {
			logger: silentLogger,
		});

		expect(registry.runners.map((r) => r.name).sort()).toEqual([
			"alpha",
			"beta",
		]);
		expect(registry.triggerRegistry.size).toBe(2);
	});

	it("skips a broken manifest but keeps the runtime bootable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wf-reg-broken-"));
		const badPath = join(dir, "manifest.json");
		await writeFile(badPath, "not-json", "utf8");
		const errorLogger = {
			...silentLogger,
			error: vi.fn(),
		};

		registry = createWorkflowRegistry({ logger: errorLogger });
		await loadWorkflows(registry, [badPath], { logger: errorLogger });

		expect(registry.runners).toHaveLength(0);
		expect(errorLogger.error).toHaveBeenCalledWith(
			"workflow-registry.load-failed",
			expect.objectContaining({ manifestPath: badPath }),
		);
	});
});
