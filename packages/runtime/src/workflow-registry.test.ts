import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsStorage } from "./storage/fs.js";
import type { StorageBackend } from "./storage/index.js";
import {
	createWorkflowRegistry,
	parseWorkflowNames,
} from "./workflow-registry.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(),
};

const MANIFEST = {
	name: "test",
	module: "actions.js",
	events: [
		{
			name: "test.event",
			schema: { type: "object", properties: {}, required: [] },
		},
	],
	triggers: [],
	actions: [
		{
			name: "handle",
			export: "handle",
			on: "test.event",
			emits: [],
			env: {},
		},
	],
};

const ACTION_SOURCE = "export default async (ctx) => {}";

function makeFiles(overrides?: {
	manifest?: object;
	actionFiles?: Map<string, string>;
}): Map<string, string> {
	const files = new Map<string, string>();
	files.set("manifest.json", JSON.stringify(overrides?.manifest ?? MANIFEST));
	const actionFiles =
		overrides?.actionFiles ?? new Map([["actions.js", ACTION_SOURCE]]);
	for (const [name, content] of actionFiles) {
		files.set(name, content);
	}
	return files;
}

describe("parseWorkflowNames", () => {
	it("extracts unique workflow names from paths", () => {
		const paths = [
			"workflows/foo/manifest.json",
			"workflows/foo/actions/handle.js",
			"workflows/bar/manifest.json",
		];
		expect(parseWorkflowNames(paths)).toEqual(["foo", "bar"]);
	});

	it("ignores non-workflow paths", () => {
		const paths = ["events/pending/001.json", "workflows/foo/manifest.json"];
		expect(parseWorkflowNames(paths)).toEqual(["foo"]);
	});

	it("returns empty for no workflows", () => {
		expect(parseWorkflowNames([])).toEqual([]);
	});
});

describe("WorkflowRegistry", () => {
	it("starts empty", () => {
		const registry = createWorkflowRegistry({ logger });
		expect(registry.actions).toEqual([]);
		expect(registry.events).toEqual({});
		expect(registry.jsonSchemas).toEqual({});
		expect(registry.triggerRegistry.size).toBe(0);
	});

	it("register returns the workflow name", async () => {
		const registry = createWorkflowRegistry({ logger });
		const name = await registry.register(makeFiles());
		expect(name).toBe("test");
	});

	it("register adds actions and events", async () => {
		const registry = createWorkflowRegistry({ logger });
		await registry.register(makeFiles());

		expect(registry.actions).toHaveLength(1);
		expect(registry.actions[0]?.name).toBe("handle");
		expect(registry.events).toHaveProperty("test.event");
		expect(registry.jsonSchemas).toHaveProperty("test.event");
	});

	it("register replaces existing workflow with same name", async () => {
		const registry = createWorkflowRegistry({ logger });
		await registry.register(makeFiles());

		const newManifest = {
			...MANIFEST,
			actions: [
				{
					...MANIFEST.actions[0],
					name: "handleNew",
					export: "handleNew",
				},
			],
		};
		await registry.register(
			makeFiles({
				manifest: newManifest,
				actionFiles: new Map([["actions.js", "new code"]]),
			}),
		);

		expect(registry.actions).toHaveLength(1);
		expect(registry.actions[0]?.name).toBe("handleNew");
	});

	it("register returns undefined for invalid manifest", async () => {
		const registry = createWorkflowRegistry({ logger });
		const files = new Map([["manifest.json", '{"invalid": true}']]);
		const name = await registry.register(files);
		expect(name).toBeUndefined();
		expect(registry.actions).toEqual([]);
	});

	it("register returns undefined when manifest.json is missing", async () => {
		const registry = createWorkflowRegistry({ logger });
		const files = new Map([["actions.js", ACTION_SOURCE]]);
		const name = await registry.register(files);
		expect(name).toBeUndefined();
	});

	it("register returns undefined when action source is missing", async () => {
		const registry = createWorkflowRegistry({ logger });
		const files = new Map([["manifest.json", JSON.stringify(MANIFEST)]]);
		const name = await registry.register(files);
		expect(name).toBeUndefined();
	});

	it("remove deletes a workflow", async () => {
		const registry = createWorkflowRegistry({ logger });
		await registry.register(makeFiles());
		registry.remove("test");
		expect(registry.actions).toEqual([]);
	});

	it("merges actions from multiple workflows", async () => {
		const registry = createWorkflowRegistry({ logger });
		await registry.register(makeFiles());

		const manifest2 = {
			...MANIFEST,
			name: "other",
			actions: [{ ...MANIFEST.actions[0], name: "handleOther" }],
		};
		await registry.register(makeFiles({ manifest: manifest2 }));

		expect(registry.actions).toHaveLength(2);
	});

	it("trigger override: last-write-wins", async () => {
		const registry = createWorkflowRegistry({ logger });
		const manifest1 = {
			...MANIFEST,
			name: "foo",
			triggers: [{ name: "foo.webhook", type: "http", path: "orders" }],
		};
		const manifest2 = {
			...MANIFEST,
			name: "bar",
			triggers: [{ name: "bar.webhook", type: "http", path: "orders" }],
		};
		await registry.register(makeFiles({ manifest: manifest1 }));
		await registry.register(makeFiles({ manifest: manifest2 }));

		const trigger = registry.triggerRegistry.lookup("orders", "POST");
		expect(trigger?.name).toBe("bar.webhook");
	});

	it("replacing a workflow clears its old triggers", async () => {
		const registry = createWorkflowRegistry({ logger });
		const manifest1 = {
			...MANIFEST,
			triggers: [
				{ name: "webhook.a", type: "http", path: "a" },
				{ name: "webhook.b", type: "http", path: "b" },
			],
		};
		await registry.register(makeFiles({ manifest: manifest1 }));

		const manifest2 = {
			...MANIFEST,
			triggers: [{ name: "webhook.c", type: "http", path: "c" }],
		};
		await registry.register(makeFiles({ manifest: manifest2 }));

		expect(registry.triggerRegistry.lookup("a", "POST")).toBeNull();
		expect(registry.triggerRegistry.lookup("b", "POST")).toBeNull();
		expect(registry.triggerRegistry.lookup("c", "POST")).not.toBeNull();
	});
});

describe("WorkflowRegistry with storage backend", () => {
	let dir: string;
	let backend: StorageBackend;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "registry-test-"));
		backend = createFsStorage(dir);
		await backend.init();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true });
	});

	it("persists workflow to storage backend on register", async () => {
		const registry = createWorkflowRegistry({ backend, logger });
		await registry.register(makeFiles());

		const manifest = await backend.read("workflows/test/manifest.json");
		expect(JSON.parse(manifest).name).toBe("test");

		const source = await backend.read("workflows/test/actions.js");
		expect(source).toBe(ACTION_SOURCE);
	});

	it("recover loads workflows from storage backend", async () => {
		await backend.write(
			"workflows/test/manifest.json",
			JSON.stringify(MANIFEST),
		);
		await backend.write("workflows/test/actions.js", ACTION_SOURCE);

		const registry = createWorkflowRegistry({ backend, logger });
		await registry.recover();

		expect(registry.actions).toHaveLength(1);
		expect(registry.actions[0]?.name).toBe("handle");
		expect(registry.actions[0]?.source).toBe(ACTION_SOURCE);
		expect(logger.info).toHaveBeenCalledWith("workflow.loaded", {
			name: "test",
		});
	});

	it("recover with empty storage starts empty", async () => {
		const registry = createWorkflowRegistry({ backend, logger });
		await registry.recover();
		expect(registry.actions).toEqual([]);
	});

	it("recover without backend is a no-op", async () => {
		const registry = createWorkflowRegistry({ logger });
		await registry.recover();
		expect(registry.actions).toEqual([]);
	});

	it("recover skips workflows with invalid manifest", async () => {
		await backend.write("workflows/bad/manifest.json", '{"invalid": true}');

		const registry = createWorkflowRegistry({ backend, logger });
		await registry.recover();

		expect(registry.actions).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.load-failed",
			expect.objectContaining({
				name: "bad",
				error: expect.stringContaining("invalid manifest"),
			}),
		);
	});

	it("recover skips workflows with missing action source", async () => {
		await backend.write(
			"workflows/broken/manifest.json",
			JSON.stringify({ ...MANIFEST, name: "broken" }),
		);

		const registry = createWorkflowRegistry({ backend, logger });
		await registry.recover();

		expect(registry.actions).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.load-failed",
			expect.objectContaining({
				name: "broken",
				error: expect.stringContaining("missing action module"),
			}),
		);
	});

	it("reconstructs event schemas from JSON Schema", async () => {
		const manifest = {
			...MANIFEST,
			events: [
				{
					name: "test.event",
					schema: {
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
					},
				},
			],
		};
		await backend.write(
			"workflows/schema/manifest.json",
			JSON.stringify(manifest),
		);
		await backend.write("workflows/schema/actions.js", ACTION_SOURCE);

		const registry = createWorkflowRegistry({ backend, logger });
		await registry.recover();

		const schema = registry.events["test.event"];
		expect(schema).toBeDefined();
		expect(() => schema?.parse({ id: "123" })).not.toThrow();
	});
});
