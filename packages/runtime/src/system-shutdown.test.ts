import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setExitFnForTests, systemShutdown } from "./system-shutdown.js";
import { createTestLogger as makeLogger } from "./test-utils/logger.js";

describe("systemShutdown", () => {
	let exitSpy: ReturnType<typeof vi.fn<() => void>>;

	beforeEach(() => {
		exitSpy = vi.fn<() => void>();
		setExitFnForTests(exitSpy);
	});

	afterEach(async () => {
		// Reset to a no-op so any setImmediate queued by this test that is
		// still pending fires against the noop, not the next test's spy.
		setExitFnForTests(() => {});
		// Drain any pending setImmediates so they fire NOW (with the noop)
		// rather than crossing into the next test's beforeEach.
		await new Promise((resolve) => setImmediate(resolve));
	});

	it("logs runtime.fatal with the reason and context", async () => {
		const logger = makeLogger();
		// biome-ignore lint/complexity/noVoid: systemShutdown returns Promise<never>; we intentionally start it and assert on side effects rather than awaiting (the await would never resolve)
		void systemShutdown(logger, "test-reason", {
			id: "evt_a",
			seq: 3,
		});
		// Microtask-flush so the logger.error call lands before we assert.
		await Promise.resolve();
		expect(logger.error).toHaveBeenCalledWith("runtime.fatal", {
			reason: "test-reason",
			id: "evt_a",
			seq: 3,
		});
	});

	it("schedules the exit hook exactly once via setImmediate", async () => {
		const logger = makeLogger();
		// biome-ignore lint/complexity/noVoid: same rationale as above — systemShutdown's Promise<never> never resolves
		void systemShutdown(logger, "test-reason", {});
		expect(exitSpy).not.toHaveBeenCalled();
		// Flush setImmediate.
		await new Promise((resolve) => setImmediate(resolve));
		expect(exitSpy).toHaveBeenCalledTimes(1);
	});

	it("never resolves the returned promise", async () => {
		const logger = makeLogger();
		const shutdown = systemShutdown(logger, "test-reason", {});
		// Race against a short timer: if shutdown ever resolves, the race
		// resolves to "shutdown"; otherwise the timer wins.
		const winner = await Promise.race([
			shutdown.then(() => "shutdown" as const),
			new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 20)),
		]);
		expect(winner).toBe("timer");
	});
});
