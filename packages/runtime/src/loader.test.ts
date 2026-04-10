import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkflows } from "./loader.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(),
};

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "loader-test-"));
	vi.clearAllMocks();
});

afterEach(async () => {
	await rm(dir, { recursive: true });
});

const MINIMAL_MANIFEST = {
	events: [{ name: "test.event", schema: { type: "object", properties: {}, required: [] } }],
	triggers: [],
	actions: [{ name: "handle", module: "./handle.js", on: "test.event", emits: [], env: {} }],
};

const ACTION_SOURCE = "export default async (ctx) => {}";

async function createWorkflowDir(name: string, manifest: object, actionFiles?: Record<string, string>) {
	const wfDir = join(dir, name);
	await mkdir(wfDir, { recursive: true });
	await writeFile(join(wfDir, "manifest.json"), JSON.stringify(manifest));
	if (actionFiles) {
		for (const [filename, code] of Object.entries(actionFiles)) {
			// biome-ignore lint/performance/noAwaitInLoops: test setup writes files sequentially
			await writeFile(join(wfDir, filename), code);
		}
	}
}

describe("loadWorkflows", () => {
	it("returns empty array for empty directory", async () => {
		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
	});

	it("loads a valid workflow from manifest.json + action source files", async () => {
		await createWorkflowDir("test", MINIMAL_MANIFEST, { "handle.js": ACTION_SOURCE });

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
		expect(result[0]?.actions).toHaveLength(1);
		expect(result[0]?.actions[0]?.name).toBe("handle");
		expect(result[0]?.actions[0]?.on).toBe("test.event");
		expect(result[0]?.actions[0]?.source).toBe(ACTION_SOURCE);
		expect(logger.info).toHaveBeenCalledWith("workflow.loaded", { dir: "test" });
	});

	it("skips non-directory entries", async () => {
		await writeFile(join(dir, "readme.md"), "# hello");
		await createWorkflowDir("test", MINIMAL_MANIFEST, { "handle.js": ACTION_SOURCE });

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
	});

	it("warns and skips directories without manifest.json", async () => {
		const wfDir = join(dir, "nomanifest");
		await mkdir(wfDir);
		await writeFile(join(wfDir, "handle.js"), ACTION_SOURCE);

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith("workflow.skip", expect.objectContaining({
			reason: "no manifest.json",
		}));
	});

	it("warns and skips directories with invalid manifest", async () => {
		const wfDir = join(dir, "bad");
		await mkdir(wfDir);
		await writeFile(join(wfDir, "manifest.json"), '{"invalid": true}');

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.manifest-invalid",
			expect.objectContaining({ dir: expect.stringContaining("bad") }),
		);
	});

	it("warns and skips when action source file is missing", async () => {
		await createWorkflowDir("broken", MINIMAL_MANIFEST);

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.action-source-missing",
			expect.objectContaining({ module: "./handle.js" }),
		);
	});

	it("loads multiple workflows", async () => {
		await createWorkflowDir("a", MINIMAL_MANIFEST, { "handle.js": ACTION_SOURCE });
		await createWorkflowDir("b", MINIMAL_MANIFEST, { "handle.js": ACTION_SOURCE });

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(2);
	});

	it("reconstructs event schemas from JSON Schema", async () => {
		const manifest = {
			...MINIMAL_MANIFEST,
			events: [{
				name: "test.event",
				schema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
			}],
		};
		await createWorkflowDir("schema", manifest, { "handle.js": ACTION_SOURCE });

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
		const schema = result[0]?.events["test.event"];
		expect(schema).toBeDefined();
		expect(() => schema?.parse({ id: "123" })).not.toThrow();
	});
});
