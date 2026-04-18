import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { createSandboxFactory } from "@workflow-engine/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore } from "./event-bus/event-store.js";
import { createEventBus } from "./event-bus/index.js";
import { createPersistence } from "./event-bus/persistence.js";
import { createExecutor } from "./executor/index.js";
import type { Logger } from "./logger.js";
import { recover } from "./recovery.js";
import { createSandboxStore, type SandboxStore } from "./sandbox-store.js";
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
			schema: { type: "object" },
		},
	],
};
const TENANT_MANIFEST = { workflows: [WORKFLOW] };

// IIFE bundle: the vite-plugin emits `format: "iife"` and assigns exports to
// `globalThis.__wfe_exports__` (see IIFE_NAMESPACE in @workflow-engine/core).
const BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.echo = async (input) => globalThis.__dispatchAction(
    "echo",
    input,
    async (i) => i,
    { parse: (x) => x },
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

		registry = createWorkflowRegistry({ logger });
		await registry.registerTenant(
			"acme",
			new Map([
				["manifest.json", JSON.stringify(TENANT_MANIFEST)],
				["demo.js", BUNDLE],
			]),
		);
		const lookup = registry.lookup("acme", "demo", "ping", "POST");
		if (!lookup) {
			throw new Error("expected lookup to succeed");
		}

		const sandboxFactory = createSandboxFactory({ logger });
		sandboxStore = createSandboxStore({ sandboxFactory, logger });
		const executor = createExecutor({ bus, sandboxStore });
		const result = await executor.invoke(
			"acme",
			lookup.workflow,
			lookup.triggerName,
			{ body: { msg: "hello" } },
			lookup.bundleSource,
		);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ echoed: "hello" });

		// Allow any onEvent forwarding to settle (executor wires fire-and-forget).
		await new Promise((r) => setImmediate(r));

		// The events table should contain the full trace.
		const rows = await store
			.query("acme")
			.selectAll()
			.orderBy("seq", "asc")
			.execute();
		const kinds = rows.map((r) => r.kind);
		expect(kinds[0]).toBe("trigger.request");
		expect(kinds.at(-1)).toBe("trigger.response");
		expect(kinds).toContain("action.request");
		expect(kinds).toContain("action.response");
		expect(kinds).toContain("system.request");
		expect(kinds).toContain("system.response");

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
			tenant: "acme",
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
			.query("acme")
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
			.query("t0")
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
});
