import { describe, expect, it, vi } from "vitest";
import { createSandboxFactory, type Logger } from "./factory.js";

const HASH_RE = /^[0-9a-f]{12}$/;

const SRC_RETURN_42 = "export default async (ctx) => 42;";
const SRC_RETURN_7 = "export default async (ctx) => 7;";
const SRC_TOP_LEVEL_THROW = "throw new Error('load-fail');";

type LogFn = (message: string, meta?: Record<string, unknown>) => void;
interface SpyLogger {
	info: ReturnType<typeof vi.fn<LogFn>>;
	warn: ReturnType<typeof vi.fn<LogFn>>;
	error: ReturnType<typeof vi.fn<LogFn>>;
}

function createSpyLogger(): SpyLogger & Logger {
	return {
		info: vi.fn<LogFn>(),
		warn: vi.fn<LogFn>(),
		error: vi.fn<LogFn>(),
	};
}

describe("createSandboxFactory", () => {
	it("creates a sandbox on first create(source)", async () => {
		const logger = createSpyLogger();
		const factory = createSandboxFactory({ logger });
		try {
			const sb = await factory.create(SRC_RETURN_42);
			const result = await sb.run("default", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toBe(42);
			}
			expect(logger.info).toHaveBeenCalledWith(
				"sandbox created",
				expect.objectContaining({
					sourceHash: expect.stringMatching(HASH_RE),
					durationMs: expect.any(Number),
				}),
			);
		} finally {
			await factory.dispose();
		}
	});

	it("reuses cached sandbox for the same source", async () => {
		const logger = createSpyLogger();
		const factory = createSandboxFactory({ logger });
		try {
			const a = await factory.create(SRC_RETURN_42);
			const b = await factory.create(SRC_RETURN_42);
			expect(a).toBe(b);
			// only one "sandbox created" info log across both calls
			const createLogs = logger.info.mock.calls.filter(
				(c) => c[0] === "sandbox created",
			);
			expect(createLogs).toHaveLength(1);
		} finally {
			await factory.dispose();
		}
	});

	it("creates distinct sandboxes for different sources", async () => {
		const logger = createSpyLogger();
		const factory = createSandboxFactory({ logger });
		try {
			const a = await factory.create(SRC_RETURN_42);
			const b = await factory.create(SRC_RETURN_7);
			expect(a).not.toBe(b);
			const r1 = await a.run("default", {});
			const r2 = await b.run("default", {});
			if (r1.ok && r2.ok) {
				expect(r1.result).toBe(42);
				expect(r2.result).toBe(7);
			}
		} finally {
			await factory.dispose();
		}
	});

	it("propagates eval failures without caching them", async () => {
		const logger = createSpyLogger();
		const factory = createSandboxFactory({ logger });
		try {
			await expect(factory.create(SRC_TOP_LEVEL_THROW)).rejects.toThrow();
			// a second call retries (factory.create again rejects — no cached failure)
			await expect(factory.create(SRC_TOP_LEVEL_THROW)).rejects.toThrow();
		} finally {
			await factory.dispose();
		}
	});

	it("disposes all cached sandboxes on factory.dispose()", async () => {
		const logger = createSpyLogger();
		const factory = createSandboxFactory({ logger });
		await factory.create(SRC_RETURN_42);
		await factory.create(SRC_RETURN_7);
		await factory.dispose();
		const disposeLogs = logger.info.mock.calls.filter(
			(c) => c[0] === "sandbox disposed",
		);
		expect(disposeLogs).toHaveLength(2);
		// create again after dispose should spawn fresh (not throw)
		const sb = await factory.create(SRC_RETURN_42);
		expect(sb).toBeDefined();
		await factory.dispose();
	});
});
