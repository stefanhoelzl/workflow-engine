import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "./logger.js";

function createTestLogger(
	name: string,
	level = "info",
): { logger: Logger; lines: () => Record<string, unknown>[] } {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});

	const logger = createLogger(name, {
		level: level as "info",
		destination: stream,
	});

	return {
		logger,
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

describe("createLogger", () => {
	it("includes name in every log entry", () => {
		const { logger, lines } = createTestLogger("scheduler");
		logger.info("started");
		const output = lines();
		expect(output).toHaveLength(1);
		expect(output[0]?.name).toBe("scheduler");
		expect(output[0]?.msg).toBe("started");
	});

	it("uses (msg, data?) argument order — data appears as top-level fields", () => {
		const { logger, lines } = createTestLogger("test");
		logger.info("event.emitted", {
			eventId: "evt_001",
			type: "order.received",
		});
		const output = lines();
		expect(output[0]?.msg).toBe("event.emitted");
		expect(output[0]?.eventId).toBe("evt_001");
		expect(output[0]?.type).toBe("order.received");
	});

	it("works with message only (no data)", () => {
		const { logger, lines } = createTestLogger("test");
		logger.info("scheduler.started");
		const output = lines();
		expect(output[0]?.msg).toBe("scheduler.started");
	});

	it("filters messages below the configured level", () => {
		const { logger, lines } = createTestLogger("test", "info");
		logger.debug("should.not.appear", { key: "value" });
		expect(lines()).toHaveLength(0);
	});

	it("includes trace-level messages when level is trace", () => {
		const { logger, lines } = createTestLogger("test", "trace");
		logger.trace("event.payload", { payload: { orderId: "123" } });
		const output = lines();
		expect(output).toHaveLength(1);
		expect(output[0]?.msg).toBe("event.payload");
		expect(output[0]?.payload).toEqual({ orderId: "123" });
	});

	it("silent level produces no output", () => {
		const { logger, lines } = createTestLogger("test", "silent");
		logger.info("should.not.appear");
		logger.error("should.not.appear");
		logger.trace("should.not.appear");
		expect(lines()).toHaveLength(0);
	});

	it("defaults to info level", () => {
		const { logger, lines } = createTestLogger("test");
		logger.info("visible");
		logger.debug("invisible");
		expect(lines()).toHaveLength(1);
		expect(lines()[0]?.msg).toBe("visible");
	});

	it("child logger inherits bindings", () => {
		const { logger, lines } = createTestLogger("test", "info");
		const child = logger.child({ module: "scheduler" });
		child.info("child.msg");
		const output = lines();
		expect(output).toHaveLength(1);
		expect(output[0]?.module).toBe("scheduler");
		expect(output[0]?.msg).toBe("child.msg");
	});

	it("child logger does not affect parent", () => {
		const { logger, lines } = createTestLogger("test", "info");
		logger.child({ module: "scheduler" });
		logger.info("parent.msg");
		const output = lines();
		expect(output).toHaveLength(1);
		expect(output[0]).not.toHaveProperty("module");
	});

	it("all log level methods exist", () => {
		const logger = createLogger("test", { level: "silent" });
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.trace).toBe("function");
		expect(typeof logger.child).toBe("function");
	});

	it("each level method writes at the correct level", () => {
		const { logger, lines } = createTestLogger("test", "trace");
		logger.trace("t");
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		const output = lines();
		expect(output).toHaveLength(5);
		// pino level numbers: trace=10, debug=20, info=30, warn=40, error=50
		expect(output[0]?.level).toBe(10);
		expect(output[1]?.level).toBe(20);
		expect(output[2]?.level).toBe(30);
		expect(output[3]?.level).toBe(40);
		expect(output[4]?.level).toBe(50);
	});
});
