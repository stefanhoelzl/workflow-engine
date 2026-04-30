import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { createTestLogger } from "../test-utils/logger.js";
import { logInvocationLifecycle } from "./log-lifecycle.js";

function event(overrides: Partial<InvocationEvent>): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		at: "2026-05-01T10:00:00.000Z",
		ts: 0,
		owner: "acme",
		repo: "foo",
		workflow: "demo",
		workflowSha: "0".repeat(64),
		name: "webhook",
		kind: "trigger.request",
		...overrides,
	} as InvocationEvent;
}

describe("logInvocationLifecycle", () => {
	it("emits invocation.started at info on trigger.request", () => {
		const logger = createTestLogger();
		logInvocationLifecycle(event({ kind: "trigger.request" }), logger);
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith("invocation.started", {
			id: "evt_a",
			workflow: "demo",
			trigger: "webhook",
			ts: "2026-05-01T10:00:00.000Z",
		});
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("emits invocation.completed at info on trigger.response", () => {
		const logger = createTestLogger();
		logInvocationLifecycle(event({ kind: "trigger.response", seq: 1 }), logger);
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith("invocation.completed", {
			id: "evt_a",
			workflow: "demo",
			trigger: "webhook",
			ts: "2026-05-01T10:00:00.000Z",
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("emits invocation.failed at error on trigger.error and includes error payload", () => {
		const logger = createTestLogger();
		const errorPayload = { message: "boom", kind: "shutdown" } as const;
		logInvocationLifecycle(
			event({ kind: "trigger.error", seq: 2, error: errorPayload }),
			logger,
		);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith("invocation.failed", {
			id: "evt_a",
			workflow: "demo",
			trigger: "webhook",
			ts: "2026-05-01T10:00:00.000Z",
			error: errorPayload,
		});
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("does not emit a lifecycle line for action.* events", () => {
		const logger = createTestLogger();
		logInvocationLifecycle(event({ kind: "action.request", seq: 1 }), logger);
		logInvocationLifecycle(event({ kind: "action.response", seq: 2 }), logger);
		logInvocationLifecycle(event({ kind: "action.error", seq: 3 }), logger);
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("does not emit a lifecycle line for system.* events", () => {
		const logger = createTestLogger();
		logInvocationLifecycle(event({ kind: "system.upload", seq: 0 }), logger);
		logInvocationLifecycle(
			event({ kind: "system.exhaustion", seq: 1 }),
			logger,
		);
		logInvocationLifecycle(event({ kind: "system.request", seq: 2 }), logger);
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("swallows logger.info exceptions and does not propagate", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const logger = {
				info: vi.fn().mockImplementation(() => {
					throw new Error("logger broken");
				}),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				trace: vi.fn(),
				child: vi.fn(),
			} as unknown as Logger;
			expect(() =>
				logInvocationLifecycle(event({ kind: "trigger.request" }), logger),
			).not.toThrow();
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("swallows logger.error exceptions on trigger.error", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn().mockImplementation(() => {
					throw new Error("logger broken");
				}),
				debug: vi.fn(),
				trace: vi.fn(),
				child: vi.fn(),
			} as unknown as Logger;
			expect(() =>
				logInvocationLifecycle(
					event({ kind: "trigger.error", seq: 2, error: { message: "x" } }),
					logger,
				),
			).not.toThrow();
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
