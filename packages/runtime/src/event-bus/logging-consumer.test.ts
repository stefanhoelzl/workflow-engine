import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { createLoggingConsumer } from "./logging-consumer.js";

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

function event(
	overrides: Partial<InvocationEvent> & Pick<InvocationEvent, "kind">,
): InvocationEvent {
	return {
		id: "evt_a",
		seq: 0,
		ref: null,
		ts: 100,
		workflow: "wf",
		workflowSha: "sha",
		name: overrides.name ?? "test",
		...overrides,
	} as InvocationEvent;
}

describe("logging consumer", () => {
	it("logs trigger.request at info", async () => {
		const logger = makeLogger();
		const c = createLoggingConsumer(logger);
		await c.handle(event({ kind: "trigger.request", name: "on-push" }));
		expect(logger.info).toHaveBeenCalledWith(
			"invocation.started",
			expect.objectContaining({
				id: "evt_a",
				workflow: "wf",
				trigger: "on-push",
			}),
		);
	});

	it("logs trigger.response at info", async () => {
		const logger = makeLogger();
		const c = createLoggingConsumer(logger);
		await c.handle(event({ kind: "trigger.response", name: "on-push" }));
		expect(logger.info).toHaveBeenCalledWith(
			"invocation.completed",
			expect.objectContaining({ id: "evt_a", trigger: "on-push" }),
		);
	});

	it("logs trigger.error at error with the serialized error", async () => {
		const logger = makeLogger();
		const c = createLoggingConsumer(logger);
		await c.handle(
			event({
				kind: "trigger.error",
				name: "on-push",
				error: { message: "boom", stack: "" },
			}),
		);
		expect(logger.error).toHaveBeenCalledWith(
			"invocation.failed",
			expect.objectContaining({
				trigger: "on-push",
				error: expect.objectContaining({ message: "boom" }),
			}),
		);
	});

	it("does not log action.* or system.* events", async () => {
		const logger = makeLogger();
		const c = createLoggingConsumer(logger);
		await c.handle(event({ kind: "action.request", name: "notify" }));
		await c.handle(event({ kind: "action.response", name: "notify" }));
		await c.handle(event({ kind: "system.request", name: "host.fetch" }));
		await c.handle(event({ kind: "system.response", name: "host.fetch" }));
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("swallows logger backend failures", async () => {
		const logger = makeLogger();
		(logger.info as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			() => {
				throw new Error("logger blew up");
			},
		);
		const c = createLoggingConsumer(logger);
		await expect(
			c.handle(event({ kind: "trigger.request", name: "x" })),
		).resolves.toBeUndefined();
	});
});
