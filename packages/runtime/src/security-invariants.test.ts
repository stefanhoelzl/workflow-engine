// Security invariants enforced end-to-end against the production plugin
// composition via `sandbox-store`. Each describe block maps to one of the
// plugin-discipline rules in SECURITY.md §2.

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
	sha: "s".repeat(64),
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
			name: "probe",
			type: "http",
			method: "POST",
			request: {
				body: { type: "object" },
				headers: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
		},
	],
};

function makeStore(): SandboxStore {
	const logger = makeLogger();
	const factory = createSandboxFactory({
		logger,
		memoryBytes: 67_108_864,
		stackBytes: 524_288,
		cpuMs: 30_000,
		outputBytes: 33_554_432,
		pendingCallables: 256,
	});
	const stubKeyStore = {
		getPrimary: () => ({
			keyId: "0000000000000000",
			pk: new Uint8Array(32),
			sk: new Uint8Array(32),
		}),
		lookup: () => undefined,
		allKeyIds: () => ["0000000000000000"],
	};
	return createSandboxStore({
		sandboxFactory: factory,
		logger,
		keyStore: stubKeyStore,
		maxCount: 100,
	});
}

async function probe(code: string, store: SandboxStore): Promise<unknown> {
	const bundle = `
		var __wfe_exports__ = (function(exports) {
			exports.probe = Object.assign(
				async () => ({ status: 200, body: (${code})() }),
				{ body: { parse: (x) => x }, schema: { parse: (x) => x } },
			);
			return exports;
		})({});
	`;
	const sb = await store.get("acme", WORKFLOW, bundle);
	const result = await sb.run("probe", { body: {} });
	if (!result.ok) {
		throw new Error(`probe failed: ${JSON.stringify(result.error)}`);
	}
	return (result.result as { body: unknown }).body;
}

// §4.2 — private descriptors from all composed plugins are unreachable from
// guest source after Phase-3 deletion. The canonical ones are:
//   - `__sdkDispatchAction` (sdk-support)
//   - `__reportErrorHost` (web-platform)
//   - `$fetch/do` (fetch)
//   - `__console_{log,info,warn,error,debug}` (console)
describe("§4.2 — private descriptors invisible to owner source", () => {
	let store: SandboxStore;
	afterEach(() => store?.dispose());

	it("__sdkDispatchAction is deleted from globalThis after phase 3", async () => {
		store = makeStore();
		const body = (await probe(
			`() => ({
				sdkDispatchType: typeof globalThis.__sdkDispatchAction,
				hasKey: Object.hasOwn(globalThis, "__sdkDispatchAction"),
			})`,
			store,
		)) as { sdkDispatchType: string; hasKey: boolean };
		expect(body.sdkDispatchType).toBe("undefined");
		expect(body.hasKey).toBe(false);
	});

	it("__reportErrorHost is deleted from globalThis after phase 3", async () => {
		store = makeStore();
		const body = (await probe(
			`() => ({
				type: typeof globalThis.__reportErrorHost,
				hasKey: Object.hasOwn(globalThis, "__reportErrorHost"),
			})`,
			store,
		)) as { type: string; hasKey: boolean };
		expect(body.type).toBe("undefined");
		expect(body.hasKey).toBe(false);
	});

	it("$fetch/do is not reachable via bracket notation after phase 3", async () => {
		store = makeStore();
		// `$fetch/do` is not a valid identifier — bracket-access with the
		// literal name is the only way a guest could reach it.
		const body = (await probe(
			`() => ({
				type: typeof globalThis["$fetch/do"],
				hasKey: Object.hasOwn(globalThis, "$fetch/do"),
			})`,
			store,
		)) as { type: string; hasKey: boolean };
		expect(body.type).toBe("undefined");
		expect(body.hasKey).toBe(false);
	});

	it("__console_* descriptors are deleted from globalThis after phase 3", async () => {
		store = makeStore();
		const body = (await probe(
			`() => ({
				log: { t: typeof globalThis.__console_log, k: Object.hasOwn(globalThis, "__console_log") },
				info: { t: typeof globalThis.__console_info, k: Object.hasOwn(globalThis, "__console_info") },
				warn: { t: typeof globalThis.__console_warn, k: Object.hasOwn(globalThis, "__console_warn") },
				error: { t: typeof globalThis.__console_error, k: Object.hasOwn(globalThis, "__console_error") },
				debug: { t: typeof globalThis.__console_debug, k: Object.hasOwn(globalThis, "__console_debug") },
			})`,
			store,
		)) as Record<string, { t: string; k: boolean }>;
		for (const method of ["log", "info", "warn", "error", "debug"]) {
			expect(body[method]?.t).toBe("undefined");
			expect(body[method]?.k).toBe(false);
		}
	});

	it("legacy raw bridges __hostCallAction / __emitEvent / __dispatchAction / __hostFetch are not installed", async () => {
		store = makeStore();
		const body = (await probe(
			`() => ({
				hostCallAction: typeof globalThis.__hostCallAction,
				emitEvent: typeof globalThis.__emitEvent,
				dispatchAction: typeof globalThis.__dispatchAction,
				hostFetch: typeof globalThis.__hostFetch,
			})`,
			store,
		)) as Record<string, string>;
		expect(body.hostCallAction).toBe("undefined");
		expect(body.emitEvent).toBe("undefined");
		expect(body.dispatchAction).toBe("undefined");
		expect(body.hostFetch).toBe("undefined");
	});
});

// §4.3 — hardenedFetch is the structural default in production plugin
// composition. The fetch plugin's `worker()` closes over `hardenedFetch`
// unconditionally; the only opt-out is replacing the entire plugin via
// `__pluginLoaderOverride` — a worker-side test hook, not reachable from
// the main thread's sandbox-store path.
describe("§4.3 — hardenedFetch is the structural production default", () => {
	it("fetch plugin source references hardenedFetch and has no config-driven opt-out", async () => {
		const { readFile } = await import("node:fs/promises");
		const src = await readFile(
			new URL("../../sandbox-stdlib/src/fetch/index.ts", import.meta.url),
			"utf8",
		);
		// `worker()` closes over `hardenedFetch` directly — no opts.fetch
		// parameter, no config-derived override path.
		expect(src).toMatch(/hardenedFetch/);
		expect(src).toMatch(/fetchDispatcherDescriptor\(hardenedFetch\)/);
		// No `opts.fetch` / `config.fetch` opt-out path exists.
		expect(src).not.toMatch(/opts\.fetch/);
		expect(src).not.toMatch(/config\.fetch/);
	});
});

// §4.4 — owner isolation: two concurrent owners run against distinct
// sandbox instances with independent event streams. Owner/workflow/
// workflowSha/id labels are added by the runtime executor at its
// `sb.onEvent` boundary (SECURITY.md §2 R-8); the sandbox itself emits
// `SandboxEvent` without those fields. This test asserts that the sandboxes
// are distinct and their streams do not cross-pollinate.
describe("§4.4 — owner isolation across concurrent invocations", () => {
	let store: SandboxStore;
	afterEach(() => store?.dispose());

	it("two owners with the same sha get distinct sandboxes with non-overlapping event streams", async () => {
		store = makeStore();
		const sbAcme = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const sbBeta = await store.get("beta", WORKFLOW, BUNDLE_SOURCE);
		expect(sbAcme).not.toBe(sbBeta);

		const acmeEvents: SandboxEvent[] = [];
		const betaEvents: SandboxEvent[] = [];
		sbAcme.onEvent((e) => acmeEvents.push(e));
		sbBeta.onEvent((e) => betaEvents.push(e));

		const [resA, resB] = await Promise.all([
			sbAcme.run("onPing", { body: { tag: "acme" } }),
			sbBeta.run("onPing", { body: { tag: "beta" } }),
		]);
		expect(resA.ok).toBe(true);
		expect(resB.ok).toBe(true);
		await new Promise((r) => setImmediate(r));

		// Each stream contains only events from its own sandbox's run. The
		// trigger.request event's `input` carries the per-run tag.
		const acmeTriggerReq = acmeEvents.find((e) => e.kind === "trigger.request");
		const betaTriggerReq = betaEvents.find((e) => e.kind === "trigger.request");
		expect(
			(acmeTriggerReq?.input as { body?: { tag?: string } })?.body?.tag,
		).toBe("acme");
		expect(
			(betaTriggerReq?.input as { body?: { tag?: string } })?.body?.tag,
		).toBe("beta");
		expect(acmeEvents.length).toBeGreaterThan(0);
		expect(betaEvents.length).toBeGreaterThan(0);
	});
});

// §4.7 — no Node.js surface reachable from guest source. The sandbox is a
// QuickJS VM; none of Node's standard-library globals should be present.
describe("§4.7 — no Node.js surface leaks into guest scope", () => {
	let store: SandboxStore;
	afterEach(() => store?.dispose());

	it("require / process / Buffer / global / fs / net / child_process are all undefined", async () => {
		store = makeStore();
		const body = (await probe(
			`() => ({
				require: typeof (globalThis).require,
				process: typeof (globalThis).process,
				Buffer: typeof (globalThis).Buffer,
				global: typeof (globalThis).global,
				fs: typeof (globalThis).fs,
				net: typeof (globalThis).net,
				child_process: typeof (globalThis).child_process,
				__filename: typeof (globalThis).__filename,
				__dirname: typeof (globalThis).__dirname,
			})`,
			store,
		)) as Record<string, string>;
		for (const key of Object.keys(body)) {
			expect(body[key]).toBe("undefined");
		}
	});
});

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
      body: { received: payload.body, action: await exports.doIt({ x: 1 }) },
    }),
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;
