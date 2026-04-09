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
	actions: [{ name: "handle", handler: "handle", on: "test.event", emits: [], env: {} }],
	module: "./actions.js",
};

async function createWorkflowDir(name: string, manifest: object, actionsCode: string) {
	const wfDir = join(dir, name);
	await mkdir(wfDir, { recursive: true });
	await writeFile(join(wfDir, "manifest.json"), JSON.stringify(manifest));
	await writeFile(join(wfDir, "actions.js"), actionsCode);
}

describe("loadWorkflows", () => {
	it("returns empty array for empty directory", async () => {
		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
	});

	it("loads a valid workflow from manifest.json + actions.js", async () => {
		await createWorkflowDir("test", MINIMAL_MANIFEST, "export async function handle() {}");

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
		expect(result[0]?.actions).toHaveLength(1);
		expect(result[0]?.actions[0]?.name).toBe("handle");
		expect(result[0]?.actions[0]?.on).toBe("test.event");
		expect(logger.info).toHaveBeenCalledWith("workflow.loaded", { dir: "test" });
	});

	it("skips non-directory entries", async () => {
		await writeFile(join(dir, "readme.md"), "# hello");
		await createWorkflowDir("test", MINIMAL_MANIFEST, "export async function handle() {}");

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
	});

	it("warns and skips directories without manifest.json", async () => {
		const wfDir = join(dir, "nomanifest");
		await mkdir(wfDir);
		await writeFile(join(wfDir, "actions.js"), "export async function handle() {}");

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

	it("warns and skips when actions module cannot be imported", async () => {
		const wfDir = join(dir, "broken");
		await mkdir(wfDir);
		await writeFile(join(wfDir, "manifest.json"), JSON.stringify(MINIMAL_MANIFEST));
		await writeFile(join(wfDir, "actions.js"), "throw new Error('broken');");

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.actions-import-failed",
			expect.objectContaining({ dir: expect.stringContaining("broken") }),
		);
	});

	it("warns and skips when handler export is missing", async () => {
		await createWorkflowDir("missing", MINIMAL_MANIFEST, "export async function other() {}");

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.handler-missing",
			expect.objectContaining({ handler: "handle" }),
		);
	});

	it("loads multiple workflows", async () => {
		await createWorkflowDir("a", MINIMAL_MANIFEST, "export async function handle() {}");
		await createWorkflowDir("b", MINIMAL_MANIFEST, "export async function handle() {}");

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
		await createWorkflowDir("schema", manifest, "export async function handle() {}");

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
		const schema = result[0]?.events["test.event"];
		expect(schema).toBeDefined();
		expect(() => schema?.parse({ id: "123" })).not.toThrow();
	});
});
