import { describe, expect, it, vi } from "vitest";
import { createSandboxFactory, type Logger } from "./factory.js";

const RUN_OPTS = {
	invocationId: "evt_test",
	workflow: "wf",
	workflowSha: "sha",
};

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("sandbox factory", () => {
	it("creates a sandbox lazily and caches by source", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const src = iife("exports.default = async () => 42;");
		const a = await factory.create(src);
		const b = await factory.create(src);
		expect(a).toBe(b);
		expect(logger.info).toHaveBeenCalled();
		const res = await a.run("default", null, RUN_OPTS);
		expect(res.ok).toBe(true);
		await factory.dispose();
	});

	it("disposes all cached sandboxes on factory.dispose", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const sb = await factory.create(iife("exports.default = async () => 1;"));
		await factory.dispose();
		await expect(sb.run("default", null, RUN_OPTS)).rejects.toThrow();
	});
});
