import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore } from "./event-bus/event-store.js";
import { createEventBus } from "./event-bus/index.js";
import { createPersistence } from "./event-bus/persistence.js";
import { createExecutor } from "./executor/index.js";
import type { Logger } from "./logger.js";
import { recover } from "./recovery.js";
import { createFsStorage } from "./storage/fs.js";
import {
	createWorkflowRegistry,
	loadWorkflows,
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

const MANIFEST = {
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

// IIFE bundle: the vite-plugin emits `format: "iife"` and assigns exports to
// `globalThis.__wfe_exports__` (see IIFE_NAMESPACE in @workflow-engine/core).
const BUNDLE = `
var __wfe_exports__ = (function(exports) {
  exports.echo = Object.assign(
    async (input) => globalThis.__dispatchAction(
      "echo",
      input,
      async (i) => i,
      { parse: (x) => x },
    ),
    { __setActionName: () => {} },
  );
  exports.ping = {
    handler: async (payload) => {
      const e = await exports.echo({ msg: payload.body?.msg ?? "hi" });
      return { status: 200, body: { echoed: e.msg } };
    },
    body: { parse: (x) => x },
    schema: { parse: (x) => x },
  };
  return exports;
})({});
`;

describe("end-to-end event flow", () => {
	let dir: string;
	let registry: WorkflowRegistry;
	let store: EventStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "integration-test-"));
	});

	afterEach(async () => {
		registry?.dispose();
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
		const manifestPath = join(dir, "manifest.json");
		await writeFile(manifestPath, JSON.stringify(MANIFEST), "utf8");
		await writeFile(join(dir, "demo.js"), BUNDLE, "utf8");
		await loadWorkflows(registry, [manifestPath], { logger });
		const runner = registry.runners[0];
		if (!runner) {
			throw new Error("expected at least one runner");
		}

		const executor = createExecutor({ bus });
		const result = await executor.invoke(runner, "ping", {
			body: { msg: "hello" },
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ echoed: "hello" });

		// Allow any onEvent forwarding to settle (executor wires fire-and-forget).
		await new Promise((r) => setImmediate(r));

		// The events table should contain the full trace.
		const rows = await store.query.selectAll().orderBy("seq", "asc").execute();
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
		const orphan: InvocationEvent = {
			kind: "trigger.request",
			id: "evt_crashed",
			seq: 0,
			ref: null,
			ts: Date.now(),
			workflow: "demo",
			workflowSha: MANIFEST.sha,
			name: "ping",
		};
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
		const rows = await store.query
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
			{
				kind: "trigger.request",
				id,
				seq: 0,
				ref: null,
				ts: 100,
				workflow: "demo",
				workflowSha: MANIFEST.sha,
				name: "ping",
				input: { hello: "world" },
			} as InvocationEvent,
			{
				kind: "system.request",
				id,
				seq: 1,
				ref: 0,
				ts: 101,
				workflow: "demo",
				workflowSha: MANIFEST.sha,
				name: "host.validate",
			} as InvocationEvent,
			{
				kind: "system.response",
				id,
				seq: 2,
				ref: 1,
				ts: 102,
				workflow: "demo",
				workflowSha: MANIFEST.sha,
				name: "host.validate",
				output: {},
			} as InvocationEvent,
			{
				kind: "trigger.response",
				id,
				seq: 3,
				ref: 0,
				ts: 103,
				workflow: "demo",
				workflowSha: MANIFEST.sha,
				name: "ping",
				output: { status: 200 },
			} as InvocationEvent,
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
		const rows = await store.query
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
