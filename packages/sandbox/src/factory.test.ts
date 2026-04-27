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

const TEST_FACTORY_LIMITS = {
	memoryBytes: 67_108_864,
	stackBytes: 524_288,
	cpuMs: 30_000,
	outputBytes: 33_554_432,
	pendingCallables: 256,
} as const;

describe("sandbox factory", () => {
	it("every create constructs a new Sandbox", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({
			logger,
			...TEST_FACTORY_LIMITS,
		});
		const src = iife("exports.default = async () => 42;");
		const a = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		const b = await factory.create({ source: src, plugins: NOOP_PLUGINS });
		try {
			expect(a).not.toBe(b);
			expect(logger.info).toHaveBeenCalled();
			const res = await a.run("default", null);
			expect(res.ok).toBe(true);
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	it("factory has no dispose method (pure builder)", () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({
			logger,
			...TEST_FACTORY_LIMITS,
		});
		expect((factory as { dispose?: unknown }).dispose).toBeUndefined();
	});

	it("caller-owned disposal invalidates the sandbox", async () => {
		const logger = makeLogger();
		const factory = createSandboxFactory({
			logger,
			...TEST_FACTORY_LIMITS,
		});
		const sb = await factory.create({
			source: iife("exports.default = async () => 1;"),
			plugins: NOOP_PLUGINS,
		});
		sb.dispose();
		await expect(sb.run("default", null)).rejects.toThrow();
	});
});
