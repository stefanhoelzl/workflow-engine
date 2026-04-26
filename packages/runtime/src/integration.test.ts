import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeKeyId, type InvocationEvent } from "@workflow-engine/core";
import {
	generateKeypair,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { createSandboxFactory } from "@workflow-engine/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore } from "./event-bus/event-store.js";
import { createEventBus } from "./event-bus/index.js";
import { createPersistence } from "./event-bus/persistence.js";
import { createExecutor, type Executor } from "./executor/index.js";
import { createLogger, type Logger } from "./logger.js";
import { recover } from "./recovery.js";
import { createSandboxStore, type SandboxStore } from "./sandbox-store.js";
import { createKeyStore, readyCrypto } from "./secrets/index.js";
import { createFsStorage } from "./storage/fs.js";
import { createCronTriggerSource } from "./triggers/cron.js";
import { createHttpTriggerSource } from "./triggers/http.js";
import { createManualTriggerSource } from "./triggers/manual.js";
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

// Shared dummy keystore for tests whose fixture manifests declare no
// `secrets` — the registry threads a keystore for trigger-config sentinel
// resolution, but `decryptWorkflowSecrets` short-circuits to `{}` when
// `workflow.secrets` is absent, so the store is never consulted.
const dummyKeyStore = {
	getPrimary: () => ({
		keyId: "0000000000000000",
		pk: new Uint8Array(32),
		sk: new Uint8Array(32),
	}),
	lookup: () => undefined,
	allKeyIds: () => ["0000000000000000"],
};

const WORKFLOW = {
	name: "demo",
	module: "demo.js",
	sha: "1".repeat(64),
	env: {},
	actions: [
		{ name: "echo", input: { type: "object" }, output: { type: "object" } },
	],
	triggers: [
		{
			name: "ping",
			type: "http",
			path: "ping",
			method: "POST",
			body: { type: "object" },
			params: [],
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
		},
	],
};
const OWNER_MANIFEST = { workflows: [WORKFLOW] };

// IIFE bundle: the vite-plugin emits `format: "iife"` and assigns exports to
// `globalThis.__wfe_exports__` (see IIFE_NAMESPACE in @workflow-engine/core).
// Post-PR 2 (sandbox-plugin-architecture §2.2): SDK-produced action callables
// route through `globalThis.__sdk.dispatchAction(name, input, handler,
// completer)` where completer is `(raw) => outputSchema.parse(raw)`. The
// sandbox-store's dispatcher IIFE installs `__sdk` as a locked global.
const BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.echo = async (input) => globalThis.__sdk.dispatchAction(
    "echo",
    input,
    async (i) => i,
    (raw) => raw,
  );
  exports.ping = Object.assign(
    async (payload) => {
      const e = await exports.echo({ msg: payload.body?.msg ?? "hi" });
      return { status: 200, body: { echoed: e.msg } };
    },
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

describe("end-to-end event flow", () => {
	let dir: string;
	let registry: WorkflowRegistry;
	let store: EventStore;
	let sandboxStore: SandboxStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "integration-test-"));
		await readyCrypto();
	});

	afterEach(async () => {
		registry?.dispose();
		sandboxStore?.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	it("trigger → action → host validation → trigger.response, persisted to events table and archive", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		// Wire the runtime as main.ts does (minus HTTP).
		store = await createEventStore({
			persistence: { backend },
			logger,
		});
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		const sandboxFactory = createSandboxFactory({ logger });
		const stubKeyStore = {
			getPrimary: () => ({
				keyId: "0000000000000000",
				pk: new Uint8Array(32),
				sk: new Uint8Array(32),
			}),
			lookup: () => undefined,
			allKeyIds: () => ["0000000000000000"],
		};
		sandboxStore = createSandboxStore({
			sandboxFactory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 100,
		});
		const executor = createExecutor({ bus, sandboxStore });
		registry = createWorkflowRegistry({
			logger,
			executor,
			keyStore: stubKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(OWNER_MANIFEST)],
				["demo.js", BUNDLE],
			]),
		);
		const entries = registry.list("acme");
		const entry = entries[0];
		const descriptor = entry?.triggers.find((t) => t.name === "ping");
		if (!(entry && descriptor)) {
			throw new Error("expected a ping trigger descriptor");
		}
		const result = await executor.invoke(
			"acme",
			"demo",
			entry.workflow,
			descriptor,
			{ body: { msg: "hello" } },
			{ bundleSource: entry.bundleSource },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("expected result.ok");
		}
		const output = result.output as { status: number; body: unknown };
		expect(output.status).toBe(200);
		expect(output.body).toEqual({ echoed: "hello" });

		// Allow any onEvent forwarding to settle (executor wires fire-and-forget).
		await new Promise((r) => setImmediate(r));

		// The events table should contain the full trace.
		const rows = await store
			.query([{ owner: "acme", repo: "demo" }])
			.selectAll()
			.orderBy("seq", "asc")
			.execute();
		const kinds = rows.map((r) => r.kind);
		expect(kinds[0]).toBe("trigger.request");
		expect(kinds.at(-1)).toBe("trigger.response");
		expect(kinds).toContain("action.request");
		expect(kinds).toContain("action.response");
		// system.* retired under plugin composition (§10): host-side Ajv
		// validation no longer fires system.request/system.response pairs —
		// validation is now a plugin-internal call (`deps["host-call-action"]
		// .validateAction`) and the action.* pair fully covers the audit trail.

		// All events share the same invocation id and workflow metadata.
		const ids = new Set(rows.map((r) => r.id));
		expect(ids.size).toBe(1);
		const id = [...ids][0];
		if (!id) {
			throw new Error("expected one invocation id");
		}

		// All pending files were cleaned up on trigger.response.
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		// Archive is a single JSON-array file for the invocation.
		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive).toEqual([`archive/${id}.json`]);

		const archived = JSON.parse(await backend.read(`archive/${id}.json`));
		expect(Array.isArray(archived)).toBe(true);
		expect(archived.length).toBe(rows.length);
		expect(archived[0].kind).toBe("trigger.request");
		expect(archived.at(-1).kind).toBe("trigger.response");
		// External-webhook-equivalent dispatch path: no dispatch passed →
		// archived trigger.request carries meta.dispatch = { source: "trigger" }.
		expect(archived[0].meta).toEqual({ dispatch: { source: "trigger" } });
		// Non-trigger events MUST NOT carry meta.dispatch.
		for (const e of archived.slice(1)) {
			expect(e.meta).toBeUndefined();
		}
	});

	it("manual UI dispatch path: archive contains meta.dispatch with source=manual and user", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		store = await createEventStore({ persistence: { backend }, logger });
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		const sandboxFactory = createSandboxFactory({ logger });
		// Pre-existing integration test predates the secrets feature; wire in
		// a dummy keyStore since sandbox-store now requires it (no manifest
		// secrets are declared here, so the store is never consulted).
		const integrationKp = generateKeypair();
		const integrationKeyStore = createKeyStore(
			`k1:${Buffer.from(integrationKp.secretKey).toString("base64")}`,
		);
		sandboxStore = createSandboxStore({
			sandboxFactory,
			logger,
			keyStore: integrationKeyStore,
			maxCount: 100,
		});
		const executor = createExecutor({ bus, sandboxStore });
		registry = createWorkflowRegistry({
			logger,
			executor,
			keyStore: integrationKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(OWNER_MANIFEST)],
				["demo.js", BUNDLE],
			]),
		);

		const entry = registry.list("acme")[0];
		const descriptor = entry?.triggers.find((t) => t.name === "ping");
		if (!(entry && descriptor)) {
			throw new Error("expected a ping trigger descriptor");
		}
		const result = await executor.invoke(
			"acme",
			"demo",
			entry.workflow,
			descriptor,
			{ body: { msg: "hi" } },
			{
				bundleSource: entry.bundleSource,
				dispatch: {
					source: "manual",
					user: { login: "Jane Doe", mail: "jane@example.com" },
				},
			},
		);
		expect(result.ok).toBe(true);

		await new Promise((r) => setImmediate(r));

		const rows = await store
			.query([{ owner: "acme", repo: "demo" }])
			.where("kind", "=", "trigger.request")
			.selectAll()
			.execute();
		expect(rows).toHaveLength(1);
		const id = rows[0]?.id as string;

		const archived = JSON.parse(
			await backend.read(`archive/${id}.json`),
		) as Array<{ kind: string; meta?: unknown }>;
		const req = archived.find((e) => e.kind === "trigger.request");
		expect(req?.meta).toEqual({
			dispatch: {
				source: "manual",
				user: { login: "Jane Doe", mail: "jane@example.com" },
			},
		});
		// Meta is stamped only on trigger.request; action/response events do not carry it.
		for (const e of archived) {
			if (e.kind !== "trigger.request") {
				expect(e.meta).toBeUndefined();
			}
		}
	});

	it("recovery synthesizes a trigger.error and archives orphaned events", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		// Pre-seed pending/ as if the process crashed mid-invocation.
		const orphan: InvocationEvent = makeEvent({
			kind: "trigger.request",
			id: "evt_crashed",
			seq: 0,
			ref: null,
			at: new Date().toISOString(),
			ts: 0,
			owner: "acme",
			repo: "demo",
			workflow: "demo",
			workflowSha: WORKFLOW.sha,
			name: "ping",
		});
		await backend.write(
			`pending/${orphan.id}/${orphan.seq.toString().padStart(6, "0")}.json`,
			JSON.stringify(orphan),
		);

		store = await createEventStore({ persistence: { backend }, logger });
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		await recover({ backend, eventStore: store, logger }, bus);

		// The synthesized trigger.error should be in the events table.
		const rows = await store
			.query([{ owner: "acme", repo: "demo" }])
			.where("id", "=", "evt_crashed")
			.selectAll()
			.execute();
		expect(rows.some((r) => r.kind === "trigger.error")).toBe(true);

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);
	});

	it("recovery is archive-authoritative: complete archive + partial pending → pending cleaned, archive preserved", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		// Seed a complete archive — simulates a successful terminal handling that
		// was followed by a crash during removePrefix.
		const id = "evt_a";
		const archived: InvocationEvent[] = [
			makeEvent({
				kind: "trigger.request",
				id,
				seq: 0,
				ref: null,
				at: "2026-04-16T10:00:00.000Z",
				ts: 100,
				workflow: "demo",
				workflowSha: WORKFLOW.sha,
				name: "ping",
				input: { hello: "world" },
			}),
			makeEvent({
				kind: "system.request",
				id,
				seq: 1,
				ref: 0,
				at: "2026-04-16T10:00:00.001Z",
				ts: 101,
				workflow: "demo",
				workflowSha: WORKFLOW.sha,
				name: "host.validate",
			}),
			makeEvent({
				kind: "system.response",
				id,
				seq: 2,
				ref: 1,
				at: "2026-04-16T10:00:00.002Z",
				ts: 102,
				workflow: "demo",
				workflowSha: WORKFLOW.sha,
				name: "host.validate",
				output: {},
			}),
			makeEvent({
				kind: "trigger.response",
				id,
				seq: 3,
				ref: 0,
				at: "2026-04-16T10:00:00.003Z",
				ts: 103,
				workflow: "demo",
				workflowSha: WORKFLOW.sha,
				name: "ping",
				output: { status: 200 },
			}),
		];
		const archiveContent = JSON.stringify(archived);
		await backend.write(`archive/${id}.json`, archiveContent);

		// Seed stale pending leftovers (some seqs already removed, others not).
		await backend.write(
			`pending/${id}/000001.json`,
			JSON.stringify(archived[1]),
		);
		await backend.write(
			`pending/${id}/000003.json`,
			JSON.stringify(archived[3]),
		);

		// Bootstrap event store from archive (this populates DuckDB before
		// recovery runs — matching main.ts startup order).
		store = await createEventStore({ persistence: { backend }, logger });
		await store.initialized;

		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		await recover({ backend, eventStore: store, logger }, bus);

		// Archive untouched (same byte content).
		const archiveAfter = await backend.read(`archive/${id}.json`);
		expect(archiveAfter).toBe(archiveContent);

		// Pending fully cleared.
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		// Event store still holds exactly the archive rows — no duplicates, no
		// synthetic trigger.error.
		const rows = await store
			.query([{ owner: "t0", repo: "r0" }])
			.where("id", "=", id)
			.selectAll()
			.orderBy("seq", "asc")
			.execute();
		expect(rows).toHaveLength(4);
		expect(rows.map((r) => r.kind)).toEqual([
			"trigger.request",
			"system.request",
			"system.response",
			"trigger.response",
		]);
		expect(
			rows.find(
				(r) =>
					r.kind === "trigger.error" &&
					typeof r.error === "object" &&
					r.error !== null &&
					"kind" in r.error &&
					(r.error as { kind?: string }).kind === "engine_crashed",
			),
		).toBeUndefined();
	});

	// Regression: the trigger plugin's onBeforeRunStarted / onRunFinished close
	// over the SandboxContext built at boot. After every run the sandbox swaps
	// VMs via snapshot-restore; if the bridge those hooks emit through is not
	// rebound, only the first run produces trigger.request / .response — every
	// later invocation lands in pending/ forever and is invisible to the
	// dashboard. Fire the same trigger twice and assert both invocations
	// archive end-to-end.
	it("re-firing the same trigger emits trigger.request/response on every invocation and archives both", async () => {
		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		store = await createEventStore({ persistence: { backend }, logger });
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		const sandboxFactory = createSandboxFactory({ logger });
		const stubKeyStore = {
			getPrimary: () => ({
				keyId: "0000000000000000",
				pk: new Uint8Array(32),
				sk: new Uint8Array(32),
			}),
			lookup: () => undefined,
			allKeyIds: () => ["0000000000000000"],
		};
		sandboxStore = createSandboxStore({
			sandboxFactory,
			logger,
			keyStore: stubKeyStore,
			maxCount: 100,
		});
		const executor = createExecutor({ bus, sandboxStore });
		registry = createWorkflowRegistry({
			logger,
			executor,
			keyStore: stubKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(OWNER_MANIFEST)],
				["demo.js", BUNDLE],
			]),
		);
		const entry = registry.list("acme")[0];
		const descriptor = entry?.triggers.find((t) => t.name === "ping");
		if (!(entry && descriptor)) {
			throw new Error("expected a ping trigger descriptor");
		}

		const r1 = await executor.invoke(
			"acme",
			"demo",
			entry.workflow,
			descriptor,
			{ body: { msg: "first" } },
			{ bundleSource: entry.bundleSource },
		);
		const r2 = await executor.invoke(
			"acme",
			"demo",
			entry.workflow,
			descriptor,
			{ body: { msg: "second" } },
			{ bundleSource: entry.bundleSource },
		);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);

		await new Promise((r) => setImmediate(r));

		const triggerRows = await store
			.query([{ owner: "acme", repo: "demo" }])
			.where("kind", "=", "trigger.request")
			.selectAll()
			.execute();
		expect(triggerRows).toHaveLength(2);
		const ids = triggerRows.map((r) => r.id as string).sort();

		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive.sort()).toEqual(
			ids.map((id) => `archive/${id}.json`).sort(),
		);

		const archives = (await Promise.all(
			ids.map(async (id) =>
				JSON.parse(await backend.read(`archive/${id}.json`)),
			),
		)) as Array<Array<{ kind: string }>>;
		for (const archived of archives) {
			expect(archived[0]?.kind).toBe("trigger.request");
			expect(archived.at(-1)?.kind).toBe("trigger.response");
		}
	});
});

// ---------------------------------------------------------------------------
// Cron-specific integration: registry -> cron source -> executor -> archive
// ---------------------------------------------------------------------------

const CRON_WORKFLOW = {
	name: "cron-demo",
	module: "cron-demo.js",
	sha: "c".repeat(64),
	env: {},
	actions: [
		{ name: "echo", input: { type: "object" }, output: { type: "object" } },
	],
	triggers: [
		{
			name: "every-minute",
			type: "cron",
			schedule: "* * * * *",
			tz: "UTC",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			outputSchema: {},
		},
	],
};
const CRON_OWNER_MANIFEST = { workflows: [CRON_WORKFLOW] };

// Hand-crafted IIFE bundle: a cron-style trigger is an empty-payload
// callable. The runtime dispatches by the trigger's export name, so
// `every-minute` must exist on the exports namespace.
const CRON_BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.echo = async (input) => globalThis.__sdk.dispatchAction(
    "echo",
    input,
    async (i) => i,
    (raw) => raw,
  );
  exports["every-minute"] = Object.assign(
    async () => {
      await exports.echo({ beat: true });
      return undefined;
    },
    { schedule: "* * * * *", tz: "UTC" },
  );
  return exports;
})({});
`;

// These integration tests mock the executor rather than going through the
// real sandbox. The executor + sandbox path is exercised by executor tests
// and by the top end-to-end test in this file; here we focus on the new
// wiring — registry → cron source reconfigure → fire → executor dispatch.

describe("cron trigger integration", () => {
	let registry: WorkflowRegistry;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		registry?.dispose();
		vi.useRealTimers();
	});

	it("scheduled tick fires executor with the cron descriptor and empty payload", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:30.000Z"));

		const logger = makeLogger();
		const quietLogger = createLogger("cron-integration", { level: "silent" });
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const cronSource = createCronTriggerSource({
			logger: quietLogger,
		});
		await cronSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [cronSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(CRON_OWNER_MANIFEST)],
				["cron-demo.js", CRON_BUNDLE],
			]),
		);

		// Advance to the next minute boundary.
		await vi.advanceTimersByTimeAsync(31_000);

		expect(invoke).toHaveBeenCalledTimes(1);
		const call = invoke.mock.calls[0];
		expect(call?.[0]).toBe("acme"); // owner
		expect(call?.[1]).toBe("demo"); // repo
		expect(call?.[2].name).toBe("cron-demo"); // workflow manifest
		expect(call?.[3].name).toBe("every-minute"); // descriptor
		expect(call?.[3].kind).toBe("cron");
		expect(call?.[4]).toEqual({}); // payload

		await cronSource.stop();
	});

	it("re-uploading the owner cancels in-flight cron timers and rearms from the new view", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:30.000Z"));

		const logger = makeLogger();
		const quietLogger = createLogger("cron-reconfigure", { level: "silent" });
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const cronSource = createCronTriggerSource({
			logger: quietLogger,
		});
		await cronSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [cronSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(CRON_OWNER_MANIFEST)],
				["cron-demo.js", CRON_BUNDLE],
			]),
		);

		// Before the scheduled fire, replace with an empty owner (removes the cron).
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([["manifest.json", JSON.stringify({ workflows: [] })]]),
		);

		await vi.advanceTimersByTimeAsync(120_000);
		expect(invoke).not.toHaveBeenCalled();

		await cronSource.stop();
	});
});

// ---------------------------------------------------------------------------
// Manual-specific integration: registry -> manual source -> getEntry -> fire
// ---------------------------------------------------------------------------

const MANUAL_WORKFLOW = {
	name: "manual-demo",
	module: "manual-demo.js",
	sha: "m".repeat(64),
	env: {},
	actions: [],
	triggers: [
		{
			name: "rerun",
			type: "manual",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			outputSchema: {},
		},
		{
			name: "reprocessOrder",
			type: "manual",
			inputSchema: {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
				additionalProperties: false,
			},
			outputSchema: {},
		},
	],
};
const MANUAL_OWNER_MANIFEST = { workflows: [MANUAL_WORKFLOW] };

const MANUAL_BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.rerun = async () => "rerun-ok";
  exports.reprocessOrder = async (input) => ({ processed: input.id });
  return exports;
})({});
`;

describe("manual trigger integration", () => {
	let registry: WorkflowRegistry;

	afterEach(() => {
		registry?.dispose();
	});

	it("registry.getEntry returns a manual entry whose fire dispatches through the executor", async () => {
		const logger = makeLogger();
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: "rerun-ok",
		}));
		const manualSource = createManualTriggerSource();
		await manualSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [manualSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(MANUAL_OWNER_MANIFEST)],
				["manual-demo.js", MANUAL_BUNDLE],
			]),
		);

		const entry = registry.getEntry("acme", "demo", "manual-demo", "rerun");
		expect(entry).toBeDefined();
		expect(entry?.descriptor.kind).toBe("manual");

		const result = await entry?.fire({});
		expect(result?.ok).toBe(true);
		if (result?.ok === true) {
			expect(result.output).toBe("rerun-ok");
		}
		expect(invoke).toHaveBeenCalledTimes(1);
		const call = invoke.mock.calls[0];
		expect(call?.[0]).toBe("acme"); // owner
		expect(call?.[1]).toBe("demo"); // repo
		expect(call?.[2].name).toBe("manual-demo"); // workflow manifest
		expect(call?.[3].name).toBe("rerun"); // descriptor
		expect(call?.[3].kind).toBe("manual");
		expect(call?.[4]).toEqual({}); // validated payload

		await manualSource.stop();
	});

	it("rejects a fire whose body fails inputSchema validation", async () => {
		const logger = makeLogger();
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const manualSource = createManualTriggerSource();
		await manualSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [manualSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(MANUAL_OWNER_MANIFEST)],
				["manual-demo.js", MANUAL_BUNDLE],
			]),
		);

		const entry = registry.getEntry(
			"acme",
			"demo",
			"manual-demo",
			"reprocessOrder",
		);
		expect(entry).toBeDefined();
		const result = await entry?.fire({ id: 42 });
		expect(result?.ok).toBe(false);
		if (result?.ok === false) {
			expect(result.error.issues).toBeDefined();
		}
		expect(invoke).not.toHaveBeenCalled();

		await manualSource.stop();
	});

	it("manual-only owner is not addressable via /webhooks/*", async () => {
		const logger = makeLogger();
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const httpSource = createHttpTriggerSource();
		const manualSource = createManualTriggerSource();
		await httpSource.start();
		await manualSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [httpSource, manualSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(MANUAL_OWNER_MANIFEST)],
				["manual-demo.js", MANUAL_BUNDLE],
			]),
		);

		// The HTTP source must have no installed entry for the manual trigger —
		// the registry partitions by kind and routes manual entries only to the
		// manual backend. Webhook ingress therefore 404s for manual names.
		expect(
			httpSource.getEntry("acme", "demo", "manual-demo", "rerun"),
		).toBeUndefined();
		expect(
			httpSource.getEntry("acme", "demo", "manual-demo", "reprocessOrder"),
		).toBeUndefined();

		await httpSource.stop();
		await manualSource.stop();
	});

	it("re-uploading the owner continues resolving manual entries from the new view", async () => {
		const logger = makeLogger();
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const manualSource = createManualTriggerSource();
		await manualSource.start();

		registry = createWorkflowRegistry({
			logger,
			executor: { invoke, fail: vi.fn(async () => undefined) },
			backends: [manualSource],
			keyStore: dummyKeyStore,
		});
		await registry.registerOwner(
			"acme",
			"demo",
			new Map([
				["manifest.json", JSON.stringify(MANUAL_OWNER_MANIFEST)],
				["manual-demo.js", MANUAL_BUNDLE],
			]),
		);
		expect(
			registry.getEntry("acme", "demo", "manual-demo", "rerun"),
		).toBeDefined();

		await registry.registerOwner(
			"acme",
			"demo",
			new Map([["manifest.json", JSON.stringify({ workflows: [] })]]),
		);
		expect(
			registry.getEntry("acme", "demo", "manual-demo", "rerun"),
		).toBeUndefined();

		await manualSource.stop();
	});
});

// ---------------------------------------------------------------------------
// Workflow-secrets end-to-end: the plaintext of a manifest-sealed secret must
// never leave the sandbox through any outbound `WorkerToMain` message. This
// exercises the full pipeline — sandbox-store decrypt → secrets plugin
// install of `globalThis.workflow.env.X` → guest reads the value and puts it
// into the trigger response → `onPost` scrubber → done payload → archive.
// A regression in any layer (scrubber not wired, wired but invoked after
// event stamping, wrong plugin order, decrypt skipped, env not merged) will
// leave the plaintext somewhere in the archived event list and fail this
// test.
// ---------------------------------------------------------------------------

const SECRET_WORKFLOW_SHA = "2".repeat(64);
const SECRET_PLAINTEXT = "super-secret-plaintext-value-do-not-leak";

const LEAK_BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.leak = Object.assign(
    async () => ({
      status: 200,
      body: { value: globalThis.workflow.env.MY_SECRET },
    }),
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

describe("workflow-secrets end-to-end scrubbing", () => {
	let dir: string;
	let registry: WorkflowRegistry;
	let store: EventStore;
	let sandboxStore: SandboxStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "integration-secrets-"));
		await readyCrypto();
	});

	afterEach(async () => {
		registry?.dispose();
		sandboxStore?.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	it("plaintext of a sealed secret is never emitted in archived events", async () => {
		// Generate a real keypair and seal the plaintext with sealCiphertext.
		const kp = generateKeypair();
		const keyId = await computeKeyId(kp.publicKey);
		const ciphertext = sealCiphertext(SECRET_PLAINTEXT, kp.publicKey);
		const ciphertextB64 = Buffer.from(ciphertext).toString("base64");
		const skB64 = Buffer.from(kp.secretKey).toString("base64");

		const manifest = {
			workflows: [
				{
					name: "leak",
					module: "leak.js",
					sha: SECRET_WORKFLOW_SHA,
					env: {},
					secrets: { MY_SECRET: ciphertextB64 },
					secretsKeyId: keyId,
					actions: [],
					triggers: [
						{
							name: "leak",
							type: "http",
							path: "leak",
							method: "POST",
							body: { type: "object" },
							params: [],
							inputSchema: { type: "object" },
							outputSchema: { type: "object" },
						},
					],
				},
			],
		};

		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		store = await createEventStore({
			persistence: { backend },
			logger,
		});
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		const sandboxFactory = createSandboxFactory({ logger });
		const keyStore = createKeyStore(`primary:${skB64}`);
		sandboxStore = createSandboxStore({
			sandboxFactory,
			logger,
			keyStore,
			maxCount: 100,
		});
		const executor = createExecutor({ bus, sandboxStore });
		registry = createWorkflowRegistry({
			logger,
			executor,
			keyStore,
		});
		await registry.registerOwner(
			"acme",
			"r0",
			new Map([
				["manifest.json", JSON.stringify(manifest)],
				["leak.js", LEAK_BUNDLE],
			]),
		);

		const entry = registry.list("acme", "r0")[0];
		const descriptor = entry?.triggers.find((t) => t.name === "leak");
		if (!(entry && descriptor)) {
			throw new Error("expected a leak trigger descriptor");
		}

		const result = await executor.invoke(
			"acme",
			"r0",
			entry.workflow,
			descriptor,
			{ body: {} },
			{ bundleSource: entry.bundleSource },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("invoke failed");
		}

		// The `done` payload crosses worker→main via `post()`, which runs
		// `onPost`. The scrubber must have replaced the plaintext returned
		// from the guest with `[secret]` before we see it here.
		const output = result.output as { status: number; body: { value: string } };
		expect(output.body.value).toBe("[secret]");

		// Settle any onEvent forwarding.
		await new Promise((r) => setImmediate(r));

		// Read the archive and verify: plaintext appears nowhere; `[secret]`
		// appears at least once. Serializing the whole archive as a string
		// is the tightest assertion — any plaintext in any field of any
		// event (output, input, meta, error, whatever) would show up.
		const archiveFiles: string[] = [];
		for await (const p of backend.list("archive/")) {
			archiveFiles.push(p);
		}
		expect(archiveFiles.length).toBeGreaterThan(0);
		const archiveBlobs = await Promise.all(
			archiveFiles.map((f) => backend.read(f)),
		);
		const allArchived = archiveBlobs.join("\n");
		expect(allArchived).not.toContain(SECRET_PLAINTEXT);
		expect(allArchived).toContain("[secret]");
	});

	// Exercises the runtime `$secrets.addSecret` path (SDK's `secret()` escape
	// hatch) end-to-end through a real sandbox. Two regressions this guards:
	//
	//  1. Phase-3 delete of the private `$secrets/addSecret` global vs.
	//     dynamic-vs-closure-capture in the Phase-2 wrapper: if the wrapper
	//     loses the binding, `addSecret` silently no-ops and
	//     `activePlaintexts` never grows, so the plaintext crosses the
	//     boundary unredacted.
	//
	//  2. `.request` event fires BEFORE the handler appends to
	//     `activePlaintexts`, so the input of `$secrets/addSecret.request`
	//     would itself carry the plaintext unless the descriptor redacts
	//     input via `logInput`.
	const RUNTIME_SECRET_SHA = "3".repeat(64);
	const RUNTIME_SECRET_PLAINTEXT = "runtime-minted-plaintext-do-not-leak";
	const RUNTIME_SECRET_BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.leak = Object.assign(
    async () => {
      const v = ${JSON.stringify(RUNTIME_SECRET_PLAINTEXT)};
      globalThis.$secrets.addSecret(v);
      console.log("minted", v);
      return { status: 200, body: { value: v } };
    },
    { body: { parse: (x) => x }, schema: { parse: (x) => x } },
  );
  return exports;
})({});
`;

	it("plaintext registered via $secrets.addSecret is never emitted in archived events", async () => {
		const manifest = {
			workflows: [
				{
					name: "leak",
					module: "leak.js",
					sha: RUNTIME_SECRET_SHA,
					env: {},
					actions: [],
					triggers: [
						{
							name: "leak",
							type: "http",
							path: "leak",
							method: "POST",
							body: { type: "object" },
							params: [],
							inputSchema: { type: "object" },
							outputSchema: { type: "object" },
						},
					],
				},
			],
		};

		const logger = makeLogger();
		const backend = createFsStorage(dir);
		await backend.init();

		store = await createEventStore({
			persistence: { backend },
			logger,
		});
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		const sandboxFactory = createSandboxFactory({ logger });
		// No sealed-secret manifest → any non-empty CSV satisfies config;
		// generate one fresh keypair for the keyStore.
		const kp = generateKeypair();
		const skB64 = Buffer.from(kp.secretKey).toString("base64");
		const keyStore = createKeyStore(`primary:${skB64}`);
		sandboxStore = createSandboxStore({
			sandboxFactory,
			logger,
			keyStore,
			maxCount: 100,
		});
		const executor = createExecutor({ bus, sandboxStore });
		registry = createWorkflowRegistry({
			logger,
			executor,
			keyStore,
		});
		await registry.registerOwner(
			"acme",
			"r0",
			new Map([
				["manifest.json", JSON.stringify(manifest)],
				["leak.js", RUNTIME_SECRET_BUNDLE],
			]),
		);

		const entry = registry.list("acme", "r0")[0];
		const descriptor = entry?.triggers.find((t) => t.name === "leak");
		if (!(entry && descriptor)) {
			throw new Error("expected a leak trigger descriptor");
		}

		const result = await executor.invoke(
			"acme",
			"r0",
			entry.workflow,
			descriptor,
			{ body: {} },
			{ bundleSource: entry.bundleSource },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("invoke failed");
		}

		const output = result.output as { status: number; body: { value: string } };
		expect(output.body.value).toBe("[secret]");

		await new Promise((r) => setImmediate(r));

		const archiveFiles: string[] = [];
		for await (const p of backend.list("archive/")) {
			archiveFiles.push(p);
		}
		expect(archiveFiles.length).toBeGreaterThan(0);
		const archiveBlobs = await Promise.all(
			archiveFiles.map((f) => backend.read(f)),
		);
		const allArchived = archiveBlobs.join("\n");
		expect(allArchived).not.toContain(RUNTIME_SECRET_PLAINTEXT);
		expect(allArchived).toContain("[secret]");
	});
});
