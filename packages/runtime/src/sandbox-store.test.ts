import type { InvocationEvent, WorkflowManifest } from "@workflow-engine/core";
import { createSandboxFactory } from "@workflow-engine/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.js";
import { createSandboxStore, type SandboxStore } from "./sandbox-store.js";

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

const WORKFLOW: WorkflowManifest = {
	name: "demo",
	module: "demo.js",
	sha: "a".repeat(64),
	env: {},
	actions: [
		{
			name: "doIt",
			input: { type: "object" },
			output: { type: "object" },
		},
	],
	triggers: [
		{
			name: "onPing",
			type: "http",
			method: "POST",
			body: { type: "object" },
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
		},
	],
};

// IIFE bundle: the vite-plugin outputs `format: "iife"` assigning exports to
// `globalThis.__wfe_exports__` (see IIFE_NAMESPACE in @workflow-engine/core).
const BUNDLE_SOURCE = `
var __wfe_exports__ = (function(exports) {
  exports.doIt = async (input) => globalThis.__dispatchAction(
    "doIt",
    input,
    async (i) => ({ echoed: i }),
    { parse: (x) => x },
  );
  exports.onPing = Object.assign(
    async (payload) => ({
      status: 200,
      body: {
        received: payload.body,
        action: await exports.doIt({ x: 1 }),
      },
    }),
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

function makeStore(): SandboxStore {
	const logger = makeLogger();
	const factory = createSandboxFactory({ logger });
	return createSandboxStore({ sandboxFactory: factory, logger });
}

describe("sandbox-store: caching", () => {
	let store: SandboxStore;

	afterEach(() => {
		store?.dispose();
	});

	it("first get constructs a new sandbox; second get returns the same instance", async () => {
		store = makeStore();
		const a = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const b = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		expect(a).toBe(b);
	});

	it("different tenants with the same sha get distinct sandboxes", async () => {
		store = makeStore();
		const a = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const b = await store.get("contoso", WORKFLOW, BUNDLE_SOURCE);
		expect(a).not.toBe(b);
	});

	it("different shas within a tenant get distinct sandboxes (and orphan the old)", async () => {
		store = makeStore();
		const v1 = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const WORKFLOW_V2: WorkflowManifest = { ...WORKFLOW, sha: "b".repeat(64) };
		const v2 = await store.get("acme", WORKFLOW_V2, BUNDLE_SOURCE);
		expect(v2).not.toBe(v1);

		// v1 is still reachable via its original sha.
		const v1Again = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		expect(v1Again).toBe(v1);
	});

	it("concurrent gets for the same key share construction", async () => {
		store = makeStore();
		const [a, b, c] = await Promise.all([
			store.get("acme", WORKFLOW, BUNDLE_SOURCE),
			store.get("acme", WORKFLOW, BUNDLE_SOURCE),
			store.get("acme", WORKFLOW, BUNDLE_SOURCE),
		]);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("dispose tears down every cached sandbox", async () => {
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		store.dispose();
		// Post-dispose run throws because the worker is terminated.
		await expect(
			sb.run(
				"onPing",
				{ body: {} },
				{
					invocationId: "evt_x",
					tenant: "acme",
					workflow: "demo",
					workflowSha: WORKFLOW.sha,
				},
			),
		).rejects.toThrow();
	});
});

describe("sandbox-store: execution (end-to-end)", () => {
	let store: SandboxStore;

	afterEach(() => {
		store?.dispose();
	});

	const RUN_OPTS = {
		invocationId: "evt_x",
		tenant: "acme",
		workflow: "demo",
		workflowSha: WORKFLOW.sha,
	};

	it("runs a trigger handler and emits trigger/action/system events", async () => {
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const events: InvocationEvent[] = [];
		sb.onEvent((e) => events.push(e));

		const result = await sb.run(
			"onPing",
			{ body: { hello: "world" } },
			RUN_OPTS,
		);
		expect(result.ok).toBe(true);

		const kinds = events.map((e) => e.kind);
		expect(kinds[0]).toBe("trigger.request");
		expect(kinds.at(-1)).toBe("trigger.response");
		expect(kinds).toContain("action.request");
		expect(kinds).toContain("action.response");
		expect(kinds).toContain("system.request");

		// Every event carries the run metadata stamped by sb.run.
		for (const e of events) {
			expect(e.id).toBe(RUN_OPTS.invocationId);
			expect(e.tenant).toBe(RUN_OPTS.tenant);
			expect(e.workflow).toBe(RUN_OPTS.workflow);
			expect(e.workflowSha).toBe(RUN_OPTS.workflowSha);
		}
	});

	it("__hostCallAction rejects unknown action names", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.onPing = Object.assign(
					async (_payload) => {
						let err = null;
						try {
							await globalThis.__dispatchAction(
								"unknownAction",
								{ some: "input" },
								async (i) => i,
								{ parse: (x) => x },
							);
						} catch (e) {
							err = e.message;
						}
						return { status: 200, body: { error: err } };
					},
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, probeBundle);
		const result = await sb.run("onPing", { body: {} }, RUN_OPTS);
		expect(result.ok).toBe(true);
		const body = (result.ok && result.result) as {
			body: { error: string };
		};
		expect(body.body.error).toContain("unknownAction");
	});

	it("__hostCallAction / __emitEvent are NOT on globalThis after workflow load", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.onPing = Object.assign(
					async () => ({
						status: 200,
						body: {
							hostCallAction: typeof globalThis.__hostCallAction,
							emitEvent: typeof globalThis.__emitEvent,
							dispatcher: typeof globalThis.__dispatchAction,
						},
					}),
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, probeBundle);
		const result = await sb.run("onPing", { body: {} }, RUN_OPTS);
		expect(result.ok).toBe(true);
		const runResult = result.ok && result.result;
		expect(runResult).toEqual({
			status: 200,
			body: {
				hostCallAction: "undefined",
				emitEvent: "undefined",
				dispatcher: "function",
			},
		});
	});
});

describe("sandbox-store: orphan survives re-upload", () => {
	let store: SandboxStore;

	afterEach(() => {
		store?.dispose();
	});

	it("in-flight invocation completes on the orphaned sandbox after re-upload", async () => {
		store = makeStore();
		const v1 = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);

		// Start a run but do NOT await it yet.
		const inflight = v1.run(
			"onPing",
			{ body: { tag: "v1" } },
			{
				invocationId: "evt_hot",
				tenant: "acme",
				workflow: "demo",
				workflowSha: WORKFLOW.sha,
			},
		);

		// Re-upload with a new sha → new sandbox. Old one is orphaned but
		// remains reachable to the in-flight invocation.
		const WORKFLOW_V2: WorkflowManifest = { ...WORKFLOW, sha: "c".repeat(64) };
		const v2 = await store.get("acme", WORKFLOW_V2, BUNDLE_SOURCE);
		expect(v2).not.toBe(v1);

		// The in-flight invocation still completes successfully.
		const result = await inflight;
		expect(result.ok).toBe(true);

		// The old sandbox is still in the store (not disposed) — another get
		// with the original sha returns the same instance.
		const v1Again = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		expect(v1Again).toBe(v1);
	});
});
