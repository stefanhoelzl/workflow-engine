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

		// All pending files were moved to archive on trigger.response.
		const pending: string[] = [];
		for await (const p of backend.list("pending/")) {
			pending.push(p);
		}
		expect(pending).toEqual([]);

		const archive: string[] = [];
		for await (const p of backend.list("archive/")) {
			archive.push(p);
		}
		expect(archive.length).toBeGreaterThan(0);
		expect(archive.every((p) => p.startsWith(`archive/${id}/`))).toBe(true);
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
			`pending/${orphan.id}_${orphan.seq}.json`,
			JSON.stringify(orphan),
		);

		store = await createEventStore({ persistence: { backend }, logger });
		await store.initialized;
		const persistence = createPersistence(backend, { logger });
		const bus = createEventBus([persistence, store]);

		await recover({ backend }, bus);

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
});
