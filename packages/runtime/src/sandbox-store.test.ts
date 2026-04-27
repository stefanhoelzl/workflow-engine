import type { SandboxEvent, WorkflowManifest } from "@workflow-engine/core";
import {
	createSandboxFactory,
	type Sandbox,
	type SandboxFactory,
	type TerminationCause,
} from "@workflow-engine/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.js";
import { createSandboxStore, type SandboxStore } from "./sandbox-store.js";
import type { SecretsKeyStore } from "./secrets/index.js";

const stubKeyStore: SecretsKeyStore = {
	getPrimary: () => ({
		keyId: "0000000000000000",
		pk: new Uint8Array(32),
		sk: new Uint8Array(32),
	}),
	lookup: () => undefined,
	allKeyIds: () => ["0000000000000000"],
};

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

function makeStore(maxCount = 100): SandboxStore {
	const logger = makeLogger();
	const factory = createSandboxFactory({
		logger,
		memoryBytes: 67_108_864,
		stackBytes: 524_288,
		cpuMs: 30_000,
		outputBytes: 33_554_432,
		pendingCallables: 256,
	});
	return createSandboxStore({
		sandboxFactory: factory,
		logger,
		keyStore: stubKeyStore,
		maxCount,
	});
}

describe("sandbox-store: caching", () => {
	let store: SandboxStore;

	afterEach(async () => {
		await store?.dispose();
	});

	it("first get constructs a new sandbox; second get returns the same instance", async () => {
		store = makeStore();
		const a = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const b = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		expect(a).toBe(b);
	});

	it("different owners with the same sha get distinct sandboxes", async () => {
		store = makeStore();
		const a = await store.get("acme", WORKFLOW, BUNDLE_SOURCE);
		const b = await store.get("contoso", WORKFLOW, BUNDLE_SOURCE);
		expect(a).not.toBe(b);
	});

	it("different shas within a owner get distinct sandboxes (and orphan the old)", async () => {
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
		await store.dispose();
		// Post-dispose run throws because the worker is terminated.
		await expect(sb.run("onPing", { body: {} })).rejects.toThrow();
	});
});

describe("sandbox-store: execution (end-to-end)", () => {
	let store: SandboxStore;

	afterEach(async () => {
		await store?.dispose();
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

		// The sandbox emits `SandboxEvent` — no owner/workflow/workflowSha/id.
		// The runtime executor widens to `InvocationEvent` by stamping those
		// at its `sb.onEvent` boundary (SECURITY.md §2 R-8). Covered by
		// executor/index.test.ts.
		for (const e of events) {
			expect(e).not.toHaveProperty("id");
			expect(e).not.toHaveProperty("owner");
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

	it("exposes only __sdk to owner source; __sdkDispatchAction, __hostCallAction, __emitEvent, __dispatchAction are absent", async () => {
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

	afterEach(async () => {
		await store?.dispose();
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

describe("sandbox-store: __mail lock semantics (SECURITY.md §2 R-2)", () => {
	let store: SandboxStore;

	afterEach(async () => {
		await store?.dispose();
	});

	async function probeMailLock(code: string): Promise<unknown> {
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

	it("__mail is installed with a send function", async () => {
		const body = (await probeMailLock(`() => ({
			mail: typeof globalThis.__mail,
			send: typeof globalThis.__mail.send,
		})`)) as { mail: string; send: string };
		expect(body.mail).toBe("object");
		expect(body.send).toBe("function");
	});

	it("$mail/send private descriptor is deleted after phase 3", async () => {
		const body = (await probeMailLock(`() => ({
			type: typeof globalThis["$mail/send"],
			hasKey: Object.hasOwn(globalThis, "$mail/send"),
		})`)) as { type: string; hasKey: boolean };
		expect(body.type).toBe("undefined");
		expect(body.hasKey).toBe(false);
	});

	it("__mail reassignment throws in strict mode (non-writable property)", async () => {
		const body = (await probeMailLock(`() => {
			'use strict';
			let threw = null;
			try { globalThis.__mail = { send: () => 'pwned' }; }
			catch (e) { threw = e.message; }
			return { threw: threw, stillObject: typeof globalThis.__mail === 'object', send: typeof globalThis.__mail.send };
		}`)) as { threw: string; stillObject: boolean; send: string };
		expect(body.threw).toMatch(/assign|read.?only|Cannot/i);
		expect(body.stillObject).toBe(true);
		expect(body.send).toBe("function");
	});

	it("delete __mail returns false (non-configurable property)", async () => {
		const body = (await probeMailLock(`() => {
			const deleted = delete globalThis.__mail;
			return { deleted: deleted, stillThere: typeof globalThis.__mail };
		}`)) as { deleted: boolean; stillThere: string };
		expect(body.deleted).toBe(false);
		expect(body.stillThere).toBe("object");
	});

	it("__mail.send reassignment is rejected (inner object is frozen)", async () => {
		const body = (await probeMailLock(`() => {
			'use strict';
			let threw = null;
			try { globalThis.__mail.send = () => 'pwned'; }
			catch (e) { threw = e.message; }
			return { threw: threw, sendType: typeof globalThis.__mail.send };
		}`)) as { threw: string; sendType: string };
		expect(body.threw).toMatch(/assign|read.?only|Cannot/i);
		expect(body.sendType).toBe("function");
	});
});

describe("sandbox-store: orphan survives re-upload", () => {
	let store: SandboxStore;

	afterEach(async () => {
		await store?.dispose();
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

describe("sandbox-store: secrets plugin end-to-end", () => {
	let store: SandboxStore;

	afterEach(async () => {
		await store?.dispose();
	});

	it("populates workflow.env from manifest.env and redacts plaintexts in outbound events", async () => {
		const { derivePublicKey, generateKeypair, sealCiphertext } = await import(
			"@workflow-engine/core/secrets-crypto"
		);
		const { createKeyStore, readyCrypto } = await import("./secrets/index.js");
		await readyCrypto();
		const sk = generateKeypair().secretKey;
		const pk = derivePublicKey(sk);
		const realKeyStore = createKeyStore(
			`k1:${Buffer.from(sk).toString("base64")}`,
		);
		const primary = realKeyStore.getPrimary();

		const plaintext = "PLAINTEXT_SECRET_VALUE";
		const ct = sealCiphertext(plaintext, pk);

		const logger = makeLogger();
		const factory = createSandboxFactory({
			logger,
			memoryBytes: 67_108_864,
			stackBytes: 524_288,
			cpuMs: 30_000,
			outputBytes: 33_554_432,
			pendingCallables: 256,
		});
		store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: realKeyStore,
			maxCount: 100,
		});

		const workflow = {
			name: "sec",
			module: "sec.js",
			sha: "c".repeat(64),
			env: { REGION: "us-east-1" },
			secrets: { TOKEN: Buffer.from(ct).toString("base64") },
			secretsKeyId: primary.keyId,
			actions: [
				{
					name: "reveal",
					input: { type: "object" },
					output: { type: "object" },
				},
			],
			triggers: [
				{
					name: "onPing",
					type: "http" as const,
					method: "POST",
					body: { type: "object" },
					inputSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
			],
		};
		const bundle = `
var __wfe_exports__ = (function(exports) {
  exports.reveal = async (input) => globalThis.__sdk.dispatchAction(
    "reveal",
    input,
    async () => ({
      region: globalThis.workflow.env.REGION,
      token: globalThis.workflow.env.TOKEN,
    }),
    (raw) => raw,
  );
  exports.onPing = Object.assign(
    async (payload) => {
      const r = await exports.reveal({});
      return {
        status: 200,
        body: { tokenSeen: r.token, region: r.region },
      };
    },
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

		const sb = await store.get("t", workflow, bundle);
		const events: SandboxEvent[] = [];
		sb.onEvent((e) => {
			events.push(e);
		});
		const result = await sb.run("onPing", { body: {} });
		expect(result.ok).toBe(true);

		// Wait for onEvent settles
		await new Promise((r) => setImmediate(r));

		// The handler read workflow.env.TOKEN (which has the plaintext) — the
		// scrubber's onPost redacts every occurrence before events leave the
		// worker. No archived event should contain the plaintext.
		const allEventJson = JSON.stringify(events);
		expect(allEventJson).not.toContain(plaintext);
		expect(allEventJson).toContain("[secret]");
	});
});

// -------- Fake-sandbox eviction tests --------
//
// These tests exercise the LRU + sweep logic without paying per-run worker
// spawn cost. The fake factory hands back controllable `Sandbox` stubs where
// `isActive` is a plain writable boolean and `dispose()` is a spy. This lets
// the tests drive the exact cache pressure that evicts, skips, and promotes
// entries — behaviour that is orthogonal to guest execution and therefore
// doesn't need a real QuickJS worker.

interface FakeSandbox extends Sandbox {
	disposeSpy: ReturnType<typeof vi.fn>;
	setActive(active: boolean): void;
	fireTerminated(cause: TerminationCause): void;
}

interface FakeFactory extends SandboxFactory {
	createSpy: ReturnType<typeof vi.fn>;
	pending: Map<string, (sb: FakeSandbox) => void>;
	buildQueue: FakeSandbox[];
	buildNext(make?: () => FakeSandbox): FakeSandbox;
}

function makeFakeSandbox(): FakeSandbox {
	let active = false;
	const dispose = vi.fn(() => Promise.resolve());
	let terminatedCb: ((cause: TerminationCause) => void) | null = null;
	return {
		run: () => Promise.reject(new Error("fake")),
		onEvent: () => {},
		dispose,
		onTerminated: (cb) => {
			terminatedCb = cb;
		},
		get isActive() {
			return active;
		},
		disposeSpy: dispose,
		setActive(v: boolean) {
			active = v;
		},
		fireTerminated(cause: TerminationCause) {
			terminatedCb?.(cause);
		},
	};
}

function makeFakeFactory(): FakeFactory {
	const createSpy = vi.fn<(opts: unknown) => Promise<FakeSandbox>>();
	const buildQueue: FakeSandbox[] = [];
	createSpy.mockImplementation(() => {
		const sb = buildQueue.shift() ?? makeFakeSandbox();
		return Promise.resolve(sb);
	});
	return {
		create: createSpy as unknown as SandboxFactory["create"],
		createSpy,
		pending: new Map(),
		buildQueue,
		buildNext(make = makeFakeSandbox) {
			const sb = make();
			buildQueue.push(sb);
			return sb;
		},
	};
}

function workflowWithSha(sha: string): WorkflowManifest {
	return { ...WORKFLOW, sha };
}

async function flushMicrotasks(): Promise<void> {
	// Chain a handful of microtask turns so promise-then callbacks (eviction
	// dispose, entry.sandbox population) observably settle before assertions.
	for (let i = 0; i < 5; i++) {
		// biome-ignore lint/performance/noAwaitInLoops: intentional sequential await — each turn must complete before the next is scheduled
		await Promise.resolve();
	}
}

describe("sandbox-store: LRU eviction", () => {
	it("evicts the least recently used idle sandbox when the cap is exceeded", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 2,
		});
		const a = factory.buildNext();
		const b = factory.buildNext();
		const c = factory.buildNext();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		// Miss for `c` → sweep evicts `a` (LRU, idle).
		await store.get("o", workflowWithSha("c".repeat(64)), "src");
		await flushMicrotasks();
		expect(a.disposeSpy).toHaveBeenCalledTimes(1);
		expect(b.disposeSpy).not.toHaveBeenCalled();
		expect(c.disposeSpy).not.toHaveBeenCalled();
		// Log line shape: logger.info(message, meta).
		const calls = (logger.info as unknown as { mock: { calls: unknown[][] } })
			.mock.calls;
		const evictionCall = calls.find((c1) => c1[0] === "sandbox evicted");
		expect(evictionCall).toBeDefined();
		const payload = evictionCall?.[1] as {
			owner: string;
			sha: string;
			reason: string;
			ageMs: number;
			runCount: number;
		};
		expect(payload.owner).toBe("o");
		expect(payload.sha).toBe("a".repeat(64));
		expect(payload.reason).toBe("lru");
		expect(typeof payload.ageMs).toBe("number");
		expect(typeof payload.runCount).toBe("number");
		await store.dispose();
	});

	it("skips active sandboxes during sweep (soft cap)", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 1,
		});
		const a = factory.buildNext();
		const b = factory.buildNext();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		a.setActive(true);
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		await flushMicrotasks();
		// a is mid-run → not evicted; cache holds both (soft cap exceeded).
		expect(a.disposeSpy).not.toHaveBeenCalled();
		expect(b.disposeSpy).not.toHaveBeenCalled();
		// Clear the active flag so dispose's drain loop exits immediately.
		a.setActive(false);
		await store.dispose();
	});

	it("cache hit promotes entry to MRU so a later miss evicts the other entry", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 2,
		});
		const a = factory.buildNext();
		const b = factory.buildNext();
		const c = factory.buildNext();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		// Hit on `a` promotes it to MRU; `b` becomes LRU.
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		// Miss for `c` → sweep evicts `b`.
		await store.get("o", workflowWithSha("c".repeat(64)), "src");
		await flushMicrotasks();
		expect(b.disposeSpy).toHaveBeenCalledTimes(1);
		expect(a.disposeSpy).not.toHaveBeenCalled();
		expect(c.disposeSpy).not.toHaveBeenCalled();
		await store.dispose();
	});

	it("skips unresolved building entries without awaiting them", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		// Override create to make the first build never resolve.
		let neverResolve: Promise<FakeSandbox>;
		const b = makeFakeSandbox();
		const c = makeFakeSandbox();
		let call = 0;
		factory.createSpy.mockImplementation(() => {
			call++;
			if (call === 1) {
				neverResolve = new Promise<FakeSandbox>(() => {
					/* never */
				});
				return neverResolve;
			}
			if (call === 2) {
				return Promise.resolve(b);
			}
			return Promise.resolve(c);
		});
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 1,
		});
		// First get: promise returned but never resolves.
		const _ignored = store.get("o", workflowWithSha("a".repeat(64)), "src");
		expect(_ignored).toBeInstanceOf(Promise);
		// Second get: triggers sweep; unresolved entry is skipped; cache grows.
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		await flushMicrotasks();
		// Neither sandbox was disposed; the unresolved entry stayed in the cache
		// (skipped rather than awaited).
		expect(b.disposeSpy).not.toHaveBeenCalled();
		// Don't await store.dispose() here — the unresolved build would block it.
	});

	it("dispose awaits pending fire-and-forget dispose promises", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 1,
		});
		const resolvers: (() => void)[] = [];
		const slow = makeFakeSandbox();
		slow.disposeSpy.mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolvers.push(r);
				}),
		);
		factory.buildQueue.push(slow);
		factory.buildQueue.push(makeFakeSandbox());
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		// Miss evicts `slow`; its dispose() does not resolve until we say so.
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		await flushMicrotasks();
		expect(slow.disposeSpy).toHaveBeenCalledTimes(1);
		let disposed = false;
		const disposePromise = store.dispose().then(() => {
			disposed = true;
		});
		await flushMicrotasks();
		expect(disposed).toBe(false);
		resolvers[0]?.();
		await disposePromise;
		expect(disposed).toBe(true);
	});

	it("eviction does not share state across owners (no plaintext leak between tenants)", async () => {
		// Per-entry plugin construction means evicting owner A's sandbox cannot
		// surface its decrypted secrets into owner B's sandbox. This is a
		// structural guarantee — each `get()` miss routes through
		// `buildPluginDescriptors(workflow, keyStore)` which calls
		// `decryptWorkflowSecrets(workflow, keyStore)` freshly; the fake factory
		// sees two independent `options.plugins` arrays here, proving no shared
		// descriptor leaks between the two owners.
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 1,
		});
		factory.buildQueue.push(makeFakeSandbox());
		factory.buildQueue.push(makeFakeSandbox());
		await store.get("ownerA", workflowWithSha("a".repeat(64)), "src");
		await store.get("ownerB", workflowWithSha("a".repeat(64)), "src");
		await flushMicrotasks();
		const callArgs = factory.createSpy.mock.calls;
		expect(callArgs.length).toBe(2);
		// Plugin arrays are distinct instances — no object identity sharing.
		expect(callArgs[0]?.[0]).not.toBe(callArgs[1]?.[0]);
		const pluginsA = (callArgs[0]?.[0] as { plugins: unknown[] }).plugins;
		const pluginsB = (callArgs[1]?.[0] as { plugins: unknown[] }).plugins;
		expect(pluginsA).not.toBe(pluginsB);
		await store.dispose();
	});
});

describe("sandbox-store: termination eviction", () => {
	it("evicts the cached entry when the sandbox terminates with a limit cause", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 10,
		});
		const sb1 = factory.buildNext();
		const sb2 = factory.buildNext();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await flushMicrotasks();
		// Trigger a cpu limit termination on the cached sandbox.
		sb1.fireTerminated({ kind: "limit", dim: "cpu", observed: 100 });
		await flushMicrotasks();
		// Next get for the same (owner, sha) MUST rebuild a fresh sandbox.
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await flushMicrotasks();
		expect(factory.createSpy).toHaveBeenCalledTimes(2);
		expect(sb1).not.toBe(sb2);
		await store.dispose();
	});

	it("evicts the cached entry on a crash termination", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 10,
		});
		const sb1 = factory.buildNext();
		factory.buildNext();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await flushMicrotasks();
		sb1.fireTerminated({ kind: "crash", err: new Error("boom") });
		await flushMicrotasks();
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await flushMicrotasks();
		expect(factory.createSpy).toHaveBeenCalledTimes(2);
		await store.dispose();
	});
});

describe("sandbox-store: dispose error reporting", () => {
	it("per-entry dispose failure logs at error severity with locked-in fields", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 10,
		});
		const err = new Error("terminate failed");
		const sb = makeFakeSandbox();
		sb.disposeSpy.mockRejectedValueOnce(err);
		factory.buildQueue.push(sb);
		const ownerSha = "f".repeat(64);
		await store.get("acme", workflowWithSha(ownerSha), "src");
		await flushMicrotasks();

		await store.dispose();

		const errCalls = (
			logger.error as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		const failed = errCalls.filter((c) => c[0] === "sandbox dispose failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.[1]).toEqual({
			owner: "acme",
			sha: ownerSha,
			reason: "store-dispose",
			err,
		});
	});

	it("one failing dispose does not strand siblings", async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 10,
		});
		const a = makeFakeSandbox();
		const b = makeFakeSandbox();
		const c = makeFakeSandbox();
		const bErr = new Error("only b fails");
		b.disposeSpy.mockRejectedValueOnce(bErr);
		factory.buildQueue.push(a, b, c);
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		await store.get("o", workflowWithSha("c".repeat(64)), "src");
		await flushMicrotasks();

		await expect(store.dispose()).resolves.toBeUndefined();

		expect(a.disposeSpy).toHaveBeenCalledTimes(1);
		expect(b.disposeSpy).toHaveBeenCalledTimes(1);
		expect(c.disposeSpy).toHaveBeenCalledTimes(1);
		const errCalls = (
			logger.error as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		const failed = errCalls.filter((c1) => c1[0] === "sandbox dispose failed");
		expect(failed.length).toBe(1);
		expect((failed[0]?.[1] as { sha: string }).sha).toBe("b".repeat(64));
	});

	it('LRU eviction failure logs reason "lru"', async () => {
		const factory = makeFakeFactory();
		const logger = makeLogger();
		const store = createSandboxStore({
			sandboxFactory: factory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 1,
		});
		const failing = makeFakeSandbox();
		const evictErr = new Error("evict-time terminate failed");
		failing.disposeSpy.mockRejectedValueOnce(evictErr);
		factory.buildQueue.push(failing);
		factory.buildQueue.push(makeFakeSandbox());
		await store.get("o", workflowWithSha("a".repeat(64)), "src");
		await store.get("o", workflowWithSha("b".repeat(64)), "src");
		await flushMicrotasks();

		const errCalls = (
			logger.error as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		const failed = errCalls.filter((c) => c[0] === "sandbox dispose failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.[1]).toEqual({
			owner: "o",
			sha: "a".repeat(64),
			reason: "lru",
			err: evictErr,
		});
		await store.dispose();
	});
});
