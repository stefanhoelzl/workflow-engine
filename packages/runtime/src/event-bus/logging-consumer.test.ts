import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import type { RuntimeEvent } from "./index.js";
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
		logger: createLogger("events", { level: level as "trace", destination: stream }),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: "evt_001",
		type: "order.received",
		payload: {},
		correlationId: "corr_abc",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		...overrides,
	} as RuntimeEvent;
}

describe("LoggingConsumer", () => {
	describe("handle", () => {
		it("logs pending events at info level with event.created", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle(makeEvent({ state: "pending" }));

			const output = lines();
			const log = output.find((l) => l.msg === "event.created");
			expect(log).toBeDefined();
			expect(log?.correlationId).toBe("corr_abc");
			expect(log?.eventId).toBe("evt_001");
			expect(log?.type).toBe("order.received");
			expect(log?.level).toBe(30); // info
		});

		it("logs processing events at trace level", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle(makeEvent({ state: "processing" }));

			const output = lines();
			const log = output.find((l) => l.msg === "event.processing");
			expect(log).toBeDefined();
			expect(log?.level).toBe(10); // trace
		});

		it("logs done/succeeded events at trace level", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle({ ...makeEvent(), state: "done", result: "succeeded" } as RuntimeEvent);

			const output = lines();
			const log = output.find((l) => l.msg === "event.done");
			expect(log).toBeDefined();
			expect(log?.result).toBe("succeeded");
			expect(log?.level).toBe(10); // trace
		});

		it("logs done/failed events at error level with error field", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle({ ...makeEvent(), state: "done", result: "failed", error: { message: "timeout", stack: "" } } as RuntimeEvent);

			const output = lines();
			const log = output.find((l) => l.msg === "event.failed");
			expect(log).toBeDefined();
			expect(log?.result).toBe("failed");
			expect(log?.error).toEqual({ message: "timeout", stack: "" });
			expect(log?.level).toBe(50); // error
		});

		it("includes targetAction when present", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle(makeEvent({ targetAction: "sendEmail" }));

			const output = lines();
			const log = output.find((l) => l.msg === "event.created");
			expect(log?.targetAction).toBe("sendEmail");
		});

		it("omits targetAction when absent", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.handle(makeEvent());

			const output = lines();
			const log = output.find((l) => l.msg === "event.created");
			expect(log?.targetAction).toBeUndefined();
		});
	});

	describe("bootstrap", () => {
		it("logs events.recovered only when finished signal is sent with total", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.bootstrap([makeEvent(), makeEvent()]);
			expect(lines().find((l) => l.msg === "events.recovered")).toBeUndefined();

			await consumer.bootstrap([makeEvent()]);
			expect(lines().find((l) => l.msg === "events.recovered")).toBeUndefined();

			await consumer.bootstrap([], { finished: true, total: 3 });

			const output = lines();
			const log = output.find((l) => l.msg === "events.recovered");
			expect(log).toBeDefined();
			expect(log?.count).toBe(3);
			expect(log?.level).toBe(30); // info
		});

		it("logs count 0 when no events recovered", async () => {
			const { logger, lines } = createTestLogger();
			const consumer = createLoggingConsumer(logger);

			await consumer.bootstrap([], { finished: true, total: 0 });

			const output = lines();
			const log = output.find((l) => l.msg === "events.recovered");
			expect(log?.count).toBe(0);
		});
	});
});
