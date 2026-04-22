import { describe, expect, it, vi } from "vitest";
import { createSandboxFactory } from "./factory.js";
import type { Logger } from "./index.js";
import { NOOP_PLUGINS } from "./test-plugins.js";

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
		const a = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		const b = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		expect(a).not.toBe(b);
		expect(logger.info).toHaveBeenCalled();
		const res = await a.run("default", null);
		expect(res.ok).toBe(true);
		await factory.dispose();
	});

	it("disposes all created sandboxes on factory.dispose", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const sb1 = await factory.create({
			source: iife("exports.default = async () => 1;"),
			plugins: NOOP_PLUGINS,
		});
		const sb2 = await factory.create({
			source: iife("exports.default = async () => 2;"),
			plugins: NOOP_PLUGINS,
		});
		await factory.dispose();
		await expect(sb1.run("default", null)).rejects.toThrow();
		await expect(sb2.run("default", null)).rejects.toThrow();
	});

	it("create after dispose spawns fresh sandboxes", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({ logger });
		const src = iife("exports.default = async () => 7;");
		const first = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		await factory.dispose();
		const second = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		expect(second).not.toBe(first);
		const res = await second.run("default", null);
		expect(res.ok).toBe(true);
		await factory.dispose();
	});
});
