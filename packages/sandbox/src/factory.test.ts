import { describe, expect, it, vi } from "vitest";
import { createSandboxFactory } from "./factory.js";
import type { Logger } from "./index.js";

const RUN_OPTS = {
	invocationId: "evt_test",
	tenant: "t0",
	workflow: "wf",
	workflowSha: "sha",
};

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("sandbox factory", () => {
	it("every create constructs a new Sandbox", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const src = iife("exports.default = async () => 42;");
		const a = await factory.create(src);
		const b = await factory.create(src);
		expect(a).not.toBe(b);
		expect(logger.info).toHaveBeenCalled();
		const res = await a.run("default", null, RUN_OPTS);
		expect(res.ok).toBe(true);
		await factory.dispose();
	});

	it("disposes all created sandboxes on factory.dispose", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const sb1 = await factory.create(iife("exports.default = async () => 1;"));
		const sb2 = await factory.create(iife("exports.default = async () => 2;"));
		await factory.dispose();
		await expect(sb1.run("default", null, RUN_OPTS)).rejects.toThrow();
		await expect(sb2.run("default", null, RUN_OPTS)).rejects.toThrow();
	});

	it("create after dispose spawns fresh sandboxes", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const src = iife("exports.default = async () => 7;");
		const first = await factory.create(src);
		await factory.dispose();
		const second = await factory.create(src);
		expect(second).not.toBe(first);
		const res = await second.run("default", null, RUN_OPTS);
		expect(res.ok).toBe(true);
		await factory.dispose();
	});
});
