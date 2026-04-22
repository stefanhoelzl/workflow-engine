import type { SandboxEvent, WorkflowManifest } from "@workflow-engine/core";
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
// The SDK's action() calls `globalThis.__sdk.dispatchAction(name, input,
// handler, completer)` where completer = (raw) => outputSchema.parse(raw);
// the sdk-support plugin installs `__sdk` as a locked global during boot.
const BUNDLE_SOURCE = `
var __wfe_exports__ = (function(exports) {
  exports.doIt = async (input) => globalThis.__sdk.dispatchAction(
    "doIt",
    input,
    async (i) => ({ echoed: i }),
    (raw) => raw,
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
		await expect(sb.run("onPing", { body: {} })).rejects.toThrow();
	});
});

describe("sandbox-store: execution (end-to-end)", () => {
	let store: SandboxStore;

	afterEach(() => {
		store?.dispose();
	});

	it("runs a trigger handler and emits trigger/action lifecycle events (intrinsic fields only — metadata added by executor)", async () => {
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const events: SandboxEvent[] = [];
		sb.onEvent((e) => events.push(e));

		const result = await sb.run("onPing", { body: { hello: "world" } });
		expect(result.ok).toBe(true);

		const kinds = events.map((e) => e.kind);
		expect(kinds[0]).toBe("trigger.request");
		expect(kinds.at(-1)).toBe("trigger.response");
		expect(kinds).toContain("action.request");
		expect(kinds).toContain("action.response");

		// The sandbox emits `SandboxEvent` — no tenant/workflow/workflowSha/id.
		// The runtime executor widens to `InvocationEvent` by stamping those
		// at its `sb.onEvent` boundary (SECURITY.md §2 R-8). Covered by
		// executor/index.test.ts.
		for (const e of events) {
			expect(e).not.toHaveProperty("id");
			expect(e).not.toHaveProperty("tenant");
			expect(e).not.toHaveProperty("workflow");
			expect(e).not.toHaveProperty("workflowSha");
		}
	});

	it("__sdk.dispatchAction rejects unknown action names with a ValidationError-style throw", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.onPing = Object.assign(
					async (_payload) => {
						let err = null;
						try {
							await globalThis.__sdk.dispatchAction(
								"unknownAction",
								{ some: "input" },
								async (i) => i,
								(raw) => raw,
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
		const result = await sb.run("onPing", { body: {} });
		expect(result.ok).toBe(true);
		const body = (result.ok && result.result) as {
			body: { error: string };
		};
		expect(body.body.error).toContain("unknownAction");
	});

	it("exposes only __sdk to tenant source; __sdkDispatchAction, __hostCallAction, __emitEvent, __dispatchAction are absent", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.onPing = Object.assign(
					async () => ({
						status: 200,
						body: {
							sdk: typeof globalThis.__sdk,
							sdkDispatchAction: typeof globalThis.__sdkDispatchAction,
							hostCallAction: typeof globalThis.__hostCallAction,
							emitEvent: typeof globalThis.__emitEvent,
							legacyDispatcher: typeof globalThis.__dispatchAction,
							dispatchFn: typeof globalThis.__sdk.dispatchAction,
						},
					}),
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, probeBundle);
		const result = await sb.run("onPing", { body: {} });
		expect(result.ok).toBe(true);
		const runResult = result.ok && result.result;
		// The sdk-dispatcher IIFE captures `__hostCallAction` + `__emitEvent`
		// and deletes them from globalThis. `__sdk.dispatchAction` is the
		// only guest-reachable entry point.
		expect(runResult).toEqual({
			status: 200,
			body: {
				sdk: "object",
				sdkDispatchAction: "undefined",
				hostCallAction: "undefined",
				emitEvent: "undefined",
				legacyDispatcher: "undefined",
				dispatchFn: "function",
			},
		});
	});
});

describe("sandbox-store: __sdk lock semantics (SECURITY.md §2)", () => {
	let store: SandboxStore;

	afterEach(() => {
		store?.dispose();
	});

	async function probeSdkLock(code: string): Promise<unknown> {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.onPing = Object.assign(
					async () => ({ status: 200, body: (${code})() }),
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		store = makeStore();
		const sb = await store.get("acme", WORKFLOW, probeBundle);
		const result = await sb.run("onPing", { body: {} });
		if (!result.ok) {
			throw new Error(`probe failed: ${JSON.stringify(result.error)}`);
		}
		return (result.result as { body: unknown }).body;
	}

	it("__sdk reassignment throws in strict mode (non-writable property)", async () => {
		const body = (await probeSdkLock(`() => {
			'use strict';
			let threw = null;
			try { globalThis.__sdk = { dispatchAction: () => 'pwned' }; }
			catch (e) { threw = e.message; }
			return { threw: threw, stillObject: typeof globalThis.__sdk === 'object', dispatch: typeof globalThis.__sdk.dispatchAction };
		}`)) as { threw: string; stillObject: boolean; dispatch: string };
		expect(body.threw).toMatch(/assign|read.?only|Cannot/i);
		expect(body.stillObject).toBe(true);
		expect(body.dispatch).toBe("function");
	});

	it("delete __sdk returns false (non-configurable property)", async () => {
		const body = (await probeSdkLock(`() => {
			const deleted = delete globalThis.__sdk;
			return { deleted: deleted, stillThere: typeof globalThis.__sdk };
		}`)) as { deleted: boolean; stillThere: string };
		expect(body.deleted).toBe(false);
		expect(body.stillThere).toBe("object");
	});

	it("__sdk.dispatchAction reassignment is rejected (inner object is frozen)", async () => {
		const body = (await probeSdkLock(`() => {
			'use strict';
			let threw = null;
			try { globalThis.__sdk.dispatchAction = () => 'pwned'; }
			catch (e) { threw = e.message; }
			return { threw: threw, dispatchType: typeof globalThis.__sdk.dispatchAction };
		}`)) as { threw: string; dispatchType: string };
		expect(body.threw).toMatch(/assign|read.?only|Cannot/i);
		expect(body.dispatchType).toBe("function");
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
		const inflight = v1.run("onPing", { body: { tag: "v1" } });

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
