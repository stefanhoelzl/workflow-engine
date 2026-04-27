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
	it("declares best-effort tier and logging name", () => {
		const c = createLoggingConsumer(makeLogger());
		expect(c.name).toBe("logging");
		expect(c.strict).toBe(false);
	});

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

	it("does not log trigger.exception (author-failure events stay out of operator pino)", async () => {
		// Per `logging-consumer` spec MODIFIED requirement: trigger.exception
		// represents an author-fixable trigger setup failure (e.g. IMAP
		// misconfig). Pino logs are operator-facing; surfacing every misconfig
		// across a fleet of tenants would re-introduce the noise the consumer
		// was designed to remove. Operator-relevant pre-dispatch failures
		// (engine bugs like cron.fire-threw / imap.fire-threw) log at their
		// call sites, not via this consumer.
		const logger = makeLogger();
		const c = createLoggingConsumer(logger);
		await c.handle(
			event({
				kind: "trigger.exception",
				name: "imap.poll-failed",
				error: { message: "ECONNREFUSED" },
			}),
		);
		await c.handle(
			event({
				kind: "trigger.exception",
				name: "some.other.future-name",
				error: { message: "x" },
			}),
		);
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.debug).not.toHaveBeenCalled();
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
