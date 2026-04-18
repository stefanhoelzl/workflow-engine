import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { InvocationEvent } from "@workflow-engine/core";
import { pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.js";
import { createFsStorage } from "./storage/fs.js";
import {
	createWorkflowRegistry,
	type WorkflowRegistry,
} from "./workflow-registry.js";

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

const VALID_WORKFLOW = {
	name: "demo",
	module: "demo.js",
	sha: "0".repeat(64),
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
			path: "ping",
			method: "POST",
			body: { type: "object" },
			params: [],
			schema: { type: "object" },
		},
	],
};

const VALID_TENANT_MANIFEST = { workflows: [VALID_WORKFLOW] };

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
    async (payload) => ({ status: 200, body: { received: payload.body, action: await exports.doIt({ x: 1 }) } }),
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

function tenantFiles(): Map<string, string> {
	return new Map([
		["manifest.json", JSON.stringify(VALID_TENANT_MANIFEST)],
		["demo.js", BUNDLE_SOURCE],
	]);
}

async function packTenantBundle(
	files: Map<string, string>,
): Promise<Uint8Array> {
	const packer = tarPack();
	for (const [name, content] of files) {
		packer.entry({ name }, content);
	}
	packer.finalize();
	const chunks: Buffer[] = [];
	const gzip = createGzip();
	gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
	await pipeline(packer, gzip);
	const buf = Buffer.concat(chunks);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("workflow registry", () => {
	let registry: WorkflowRegistry;

	beforeEach(() => {
		/* no-op */
	});

	afterEach(() => {
		registry?.dispose();
	});

	it("registers a tenant and exposes its runner", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant("acme", tenantFiles());
		expect(result.ok).toBe(true);
		expect(registry.runners).toHaveLength(1);
		const runner = registry.runners[0];
		expect(runner?.tenant).toBe("acme");
		expect(runner?.name).toBe("demo");
	});

	it("invokeHandler stamps id/tenant/workflow/workflowSha onto emitted events", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("expected at least one runner");
		}

		const events: InvocationEvent[] = [];
		runner.onEvent((e) => events.push(e));

		const result = await runner.invokeHandler("evt_x", "onPing", {
			body: { hello: "world" },
		});
		expect(result.status).toBe(200);

		for (const e of events) {
			expect(e.id).toBe("evt_x");
			expect(e.tenant).toBe("acme");
			expect(e.workflow).toBe("demo");
			expect(e.workflowSha).toBe(VALID_WORKFLOW.sha);
		}
		expect(events[0]?.kind).toBe("trigger.request");
		expect(events.at(-1)?.kind).toBe("trigger.response");
	});

	it("emits action.* and host.validateAction events for in-sandbox action calls", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("expected at least one runner");
		}
		const events: InvocationEvent[] = [];
		runner.onEvent((e) => events.push(e));

		await runner.invokeHandler("evt_y", "onPing", { body: {} });

		const actionRequest = events.find(
			(e) => e.kind === "action.request" && e.name === "doIt",
		);
		const actionResponse = events.find(
			(e) => e.kind === "action.response" && e.name === "doIt",
		);
		expect(actionRequest).toBeDefined();
		expect(actionResponse).toBeDefined();

		const validateReq = events.find(
			(e) => e.kind === "system.request" && e.name === "host.validateAction",
		);
		expect(validateReq).toBeDefined();
		expect(actionResponse?.ref).toBe(actionRequest?.seq);
	});

	it("__hostCallAction and __emitEvent are not on globalThis after workflow load", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.doIt = async (input) => globalThis.__dispatchAction(
					"doIt", input, async (i) => i, { parse: (x) => x },
				);
				exports.onPing = Object.assign(
					async (payload) => ({
						status: 200,
						body: {
							hostCallAction: typeof globalThis.__hostCallAction,
							emitEvent: typeof globalThis.__emitEvent,
							hostFetch: typeof globalThis.__hostFetch,
							reportErrorBridge: typeof globalThis.__reportError,
							dispatcher: typeof globalThis.__dispatchAction,
						},
					}),
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const files = new Map([
			["manifest.json", JSON.stringify(VALID_TENANT_MANIFEST)],
			["demo.js", probeBundle],
		]);
		await registry.registerTenant("acme", files);
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("expected at least one runner");
		}
		const result = await runner.invokeHandler("evt_probe", "onPing", {
			body: {},
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			hostCallAction: "undefined",
			emitEvent: "undefined",
			hostFetch: "undefined",
			reportErrorBridge: "undefined",
			dispatcher: "function",
		});
	});

	it("__dispatchAction is non-writable and non-configurable after workflow load", async () => {
		const probeBundle = `
			var __wfe_exports__ = (function(exports) {
				exports.doIt = async (input) => globalThis.__dispatchAction(
					"doIt", input, async (i) => ({ echoed: i }), { parse: (x) => x },
				);
				exports.onPing = Object.assign(
					async (payload) => {
						"use strict";
						const descriptor = Object.getOwnPropertyDescriptor(
							globalThis, "__dispatchAction"
						);
						let assignError = null;
						try { globalThis.__dispatchAction = () => "pwned"; }
						catch (e) { assignError = e.name; }
						let deleteError = null;
						let deleteReturn = null;
						try { deleteReturn = delete globalThis.__dispatchAction; }
						catch (e) { deleteError = e.name; }
						const stillFunction = typeof globalThis.__dispatchAction;
						const result = await exports.doIt({ x: 1 });
						return {
							status: 200,
							body: {
								writable: descriptor && descriptor.writable,
								configurable: descriptor && descriptor.configurable,
								assignError, deleteError, deleteReturn, stillFunction,
								actionResult: result,
							},
						};
					},
					{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
				);
				return exports;
			})({});
		`;
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const files = new Map([
			["manifest.json", JSON.stringify(VALID_TENANT_MANIFEST)],
			["demo.js", probeBundle],
		]);
		await registry.registerTenant("acme", files);
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("expected at least one runner");
		}
		const result = await runner.invokeHandler("evt_lock", "onPing", {
			body: {},
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			writable: boolean;
			configurable: boolean;
			assignError: string | null;
			deleteError: string | null;
			deleteReturn: unknown;
			stillFunction: string;
			actionResult: unknown;
		};
		expect(body.writable).toBe(false);
		expect(body.configurable).toBe(false);
		// In strict mode a silent assignment or delete throws TypeError. In
		// sloppy mode the assignment is a no-op and delete returns false. We
		// accept either behavior — what matters is that __dispatchAction is
		// untouched afterwards.
		if (body.assignError !== null) {
			expect(body.assignError).toBe("TypeError");
		}
		if (body.deleteError === null) {
			expect(body.deleteReturn).toBe(false);
		} else {
			expect(body.deleteError).toBe("TypeError");
		}
		expect(body.stillFunction).toBe("function");
		expect(body.actionResult).toEqual({ echoed: { x: 1 } });
	});

	it("same workflow name in two tenants coexists and is keyed by (tenant, name)", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		await registry.registerTenant("contoso", tenantFiles());
		expect(registry.runners).toHaveLength(2);
		expect(registry.lookupRunner("acme", "demo")?.tenant).toBe("acme");
		expect(registry.lookupRunner("contoso", "demo")?.tenant).toBe("contoso");
		expect(registry.lookupRunner("other", "demo")).toBeUndefined();
	});

	it("re-registering a tenant atomically replaces its workflow set", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		expect(registry.runners).toHaveLength(1);
		// Re-upload with an empty workflow set removes the tenant's runners.
		const empty = new Map([
			["manifest.json", JSON.stringify({ workflows: [] })],
		]);
		await registry.registerTenant("acme", empty);
		expect(registry.runners).toHaveLength(0);
	});

	it("rejects upload when a referenced workflow module is missing (all-or-nothing)", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		// First upload succeeds
		await registry.registerTenant("acme", tenantFiles());

		// Second upload has a broken workflow — entire upload must fail,
		// existing bundle must survive
		const broken = new Map([
			[
				"manifest.json",
				JSON.stringify({
					workflows: [{ ...VALID_WORKFLOW, module: "missing.js" }],
				}),
			],
		]);
		const result = await registry.registerTenant("acme", broken);
		expect(result.ok).toBe(false);
		expect(registry.runners).toHaveLength(1);
		expect(registry.runners[0]?.name).toBe("demo");
	});

	it("rejects upload with missing manifest.json", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant("acme", new Map());
		expect(result.ok).toBe(false);
	});

	it("rejects upload with invalid manifest", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const result = await registry.registerTenant(
			"acme",
			new Map([["manifest.json", "{ not json"]]),
		);
		expect(result.ok).toBe(false);
	});

	it("re-upload while an invocation is in-flight defers dispose of the old sandbox until the invocation finishes", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant("acme", tenantFiles());
		const runnerV1 = registry.runners[0];
		if (!runnerV1) {
			throw new Error("expected a runner");
		}

		// Start an invocation but do NOT await it yet.
		const inflight = runnerV1.invokeHandler("evt_hot", "onPing", { body: {} });

		// Re-upload while the invocation is still running. Because per-workflow
		// serialization keeps the sandbox busy, the old sandbox must stay alive
		// until `inflight` finishes.
		await registry.registerTenant("acme", tenantFiles());

		// The in-flight invocation should still complete successfully against the
		// retiring sandbox — not throw "Sandbox is disposed".
		const result = await inflight;
		expect(result.status).toBe(200);

		// Post-swap lookup returns the NEW runner instance.
		const runnerV2 = registry.lookupRunner("acme", "demo");
		expect(runnerV2).toBeDefined();
		expect(runnerV2).not.toBe(runnerV1);
	});
});

describe("workflow registry: persistence and recovery", () => {
	let storageDir: string;
	let registry: WorkflowRegistry;

	beforeEach(async () => {
		storageDir = await mkdtemp(join(tmpdir(), "wf-persist-"));
	});

	afterEach(async () => {
		registry?.dispose();
		await rm(storageDir, { recursive: true, force: true });
	});

	it("persists the tenant tarball to workflows/<tenant>.tar.gz when tarballBytes are provided", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();
		registry = createWorkflowRegistry({ logger, storageBackend: backend });

		const files = tenantFiles();
		const tarballBytes = await packTenantBundle(files);
		const result = await registry.registerTenant("acme", files, {
			tarballBytes,
		});
		expect(result.ok).toBe(true);

		// The final key should exist, no temp keys should remain.
		const keys: string[] = [];
		for await (const k of backend.list("workflows/")) {
			keys.push(k);
		}
		expect(keys).toEqual(["workflows/acme.tar.gz"]);
	});

	it("recover() loads persisted tenants from storage at startup", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		// Simulate a prior upload by writing a tenant tarball directly.
		const files = tenantFiles();
		const tarballBytes = await packTenantBundle(files);
		await backend.writeBytes("workflows/acme.tar.gz", tarballBytes);

		// Fresh registry with the same backend should pick it up on recover().
		registry = createWorkflowRegistry({ logger, storageBackend: backend });
		await registry.recover();

		expect(registry.runners).toHaveLength(1);
		expect(registry.runners[0]?.tenant).toBe("acme");
		expect(registry.runners[0]?.name).toBe("demo");
	});

	it("recover() skips non-.tar.gz keys and handles unreadable tarballs gracefully", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(storageDir);
		await backend.init();

		// One valid, one junk.
		const validFiles = tenantFiles();
		const validBytes = await packTenantBundle(validFiles);
		await backend.writeBytes("workflows/acme.tar.gz", validBytes);
		await backend.writeBytes(
			"workflows/broken.tar.gz",
			new Uint8Array([1, 2, 3]),
		);
		// Stray non-tarball key — must be ignored.
		await backend.write("workflows/readme.txt", "noop");

		registry = createWorkflowRegistry({ logger, storageBackend: backend });
		await registry.recover();

		expect(registry.runners).toHaveLength(1);
		expect(registry.runners[0]?.tenant).toBe("acme");
	});
});
