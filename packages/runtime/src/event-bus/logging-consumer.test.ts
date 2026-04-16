import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../logger.js";
import type { InvocationLifecycleEvent } from "./index.js";
import { createLoggingConsumer } from "./logging-consumer.js";

function createTestLogger(level = "trace") {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});
	return {
		logger: createLogger("events", {
			level: level as "trace",
			destination: stream,
		}),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

function startedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "started" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "started",
		id: "evt_001",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:00.000Z"),
		input: {},
		...overrides,
	};
}

function completedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "completed" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "completed",
		id: "evt_001",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:01.000Z"),
		result: { status: 200, body: "", headers: {} },
		...overrides,
	};
}

function failedEvent(
	overrides: Partial<
		Extract<InvocationLifecycleEvent, { kind: "failed" }>
	> = {},
): InvocationLifecycleEvent {
	return {
		kind: "failed",
		id: "evt_001",
		workflow: "w1",
		trigger: "t1",
		ts: new Date("2026-01-01T00:00:01.000Z"),
		error: { message: "boom", stack: "at ..." },
		...overrides,
	};
}

describe("logging consumer", () => {
	it("logs started at info with required fields", async () => {
		const { logger, lines } = createTestLogger();
		const consumer = createLoggingConsumer(logger);

		await consumer.handle(startedEvent({ id: "evt_a" }));

		const output = lines();
		const log = output.find((l) => l.msg === "invocation.started");
		expect(log).toBeDefined();
		expect(log?.id).toBe("evt_a");
		expect(log?.workflow).toBe("w1");
		expect(log?.trigger).toBe("t1");
		expect(log?.kind).toBe("started");
		expect(log?.ts).toBe("2026-01-01T00:00:00.000Z");
		expect(log?.level).toBe(30); // info
	});

	it("logs completed at info with result", async () => {
		const { logger, lines } = createTestLogger();
		const consumer = createLoggingConsumer(logger);

		await consumer.handle(
			completedEvent({ result: { status: 201, body: "ok", headers: {} } }),
		);

		const output = lines();
		const log = output.find((l) => l.msg === "invocation.completed");
		expect(log).toBeDefined();
		expect(log?.kind).toBe("completed");
		expect(log?.result).toEqual({ status: 201, body: "ok", headers: {} });
		expect(log?.level).toBe(30); // info
	});

	it("logs failed at error with serialized error", async () => {
		const { logger, lines } = createTestLogger();
		const consumer = createLoggingConsumer(logger);

		await consumer.handle(
			failedEvent({
				error: { message: "timeout", stack: "", kind: "user_code" },
			}),
		);

		const output = lines();
		const log = output.find((l) => l.msg === "invocation.failed");
		expect(log).toBeDefined();
		expect(log?.kind).toBe("failed");
		expect(log?.error).toEqual({
			message: "timeout",
			stack: "",
			kind: "user_code",
		});
		expect(log?.level).toBe(50); // error
	});
});

describe("logging consumer resilience", () => {
	it("does not propagate logger backend failures", async () => {
		const throwingLogger: Logger = {
			info: () => {
				throw new Error("logger dead");
			},
			warn: () => undefined,
			error: () => undefined,
			debug: () => undefined,
			trace: () => undefined,
			child: () => throwingLogger,
		};
		const consoleSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const consumer = createLoggingConsumer(throwingLogger);
		await expect(consumer.handle(startedEvent())).resolves.toBeUndefined();
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});
