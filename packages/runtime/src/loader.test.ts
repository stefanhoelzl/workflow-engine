import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("loadWorkflows", () => {
	it("returns empty array for empty directory", async () => {
		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
	});

	it("loads a valid workflow from a .js file", async () => {
		const workflow = { triggers: [], actions: [], events: {} };
		await writeFile(
			join(dir, "test.js"),
			`export default ${JSON.stringify(workflow)};`,
		);

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(workflow);
		expect(logger.info).toHaveBeenCalledWith("workflow.loaded", { file: "test.js" });
	});

	it("skips non-.js files", async () => {
		await writeFile(join(dir, "readme.md"), "# hello");
		await writeFile(
			join(dir, "test.js"),
			"export default { triggers: [], actions: [], events: {} };",
		);

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(1);
	});

	it("warns and skips files that fail to import", async () => {
		await writeFile(join(dir, "bad.js"), "throw new Error('broken');");

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"workflow.load-failed",
			expect.objectContaining({ file: "bad.js" }),
		);
	});

	it("warns and skips files with no default export", async () => {
		await writeFile(join(dir, "nodefault.js"), "export const x = 1;");

		const result = await loadWorkflows(dir, logger);
		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith("workflow.skip", {
			file: "nodefault.js",
			reason: "no default export",
		});
	});

	it("loads multiple workflows", async () => {
		await writeFile(
			join(dir, "a.js"),
			"export default { triggers: [], actions: [], events: {} };",
		);
		await writeFile(
			join(dir, "b.js"),
			"export default { triggers: [], actions: [], events: {} };",
		);

		const result = await loadWorkflows(dir, logger);
		expect(result).toHaveLength(2);
	});
});
