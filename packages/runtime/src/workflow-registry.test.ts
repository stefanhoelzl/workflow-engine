import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationEvent } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.js";
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

const VALID_MANIFEST = {
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

// IIFE bundle: the vite-plugin outputs `format: "iife"` with `extend: true`,
// assigning exports to `globalThis.__wf_<name>`. The runtime's
// `toIifeNamespace("demo")` returns "__wf_demo".
const BUNDLE_SOURCE = `
var __wf_demo = (function(exports) {
  exports.doIt = Object.assign(
    async (input) => globalThis.__dispatchAction(
      "doIt",
      input,
      async (i) => ({ echoed: i }),
      { parse: (x) => x },
    ),
    { __setActionName: () => {} },
  );
  exports.onPing = {
    handler: async (payload) => ({ status: 200, body: { received: payload.body, action: await exports.doIt({ x: 1 }) } }),
    body: { parse: (x) => x },
    schema: { parse: (x) => x },
  };
  return exports;
})({});
`;

describe("workflow registry", () => {
	let dir: string;
	let registry: WorkflowRegistry;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "wf-registry-test-"));
	});

	afterEach(async () => {
		registry?.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	async function writeManifest(): Promise<string> {
		const manifestPath = join(dir, "manifest.json");
		await writeFile(manifestPath, JSON.stringify(VALID_MANIFEST), "utf8");
		await writeFile(join(dir, "demo.js"), BUNDLE_SOURCE, "utf8");
		return manifestPath;
	}

	it("loads a workflow and exposes its runner", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const manifestPath = await writeManifest();
		await loadWorkflows(registry, [manifestPath], { logger });
		expect(registry.runners).toHaveLength(1);
		expect(registry.runners[0]?.name).toBe("demo");
	});

	it("invokeHandler passes invocationId/workflow/workflowSha into the sandbox", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const manifestPath = await writeManifest();
		await loadWorkflows(registry, [manifestPath], { logger });
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

		// Every event should be stamped with the supplied metadata.
		for (const e of events) {
			expect(e.id).toBe("evt_x");
			expect(e.workflow).toBe("demo");
			expect(e.workflowSha).toBe(VALID_MANIFEST.sha);
		}
		// The trigger event reflects the trigger name.
		expect(events[0]?.kind).toBe("trigger.request");
		expect(events.at(-1)?.kind).toBe("trigger.response");
	});

	it("emits action.* events for in-sandbox action calls and host.validateAction host RPC", async () => {
		const logger = makeLogger();
		registry = createWorkflowRegistry({ logger });
		const manifestPath = await writeManifest();
		await loadWorkflows(registry, [manifestPath], { logger });
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

		// __hostCallAction is registered as host.validateAction in the event stream.
		const validateReq = events.find(
			(e) => e.kind === "system.request" && e.name === "host.validateAction",
		);
		expect(validateReq).toBeDefined();
		expect(actionResponse?.ref).toBe(actionRequest?.seq);
	});
});
