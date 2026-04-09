import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { type RuntimeEvent, createEventBus } from "../event-bus/index.js";
import { createWorkQueue } from "../event-bus/work-queue.js";
import { createEventFactory } from "../event-factory.js";
import { type Logger, createLogger } from "../logger.js";
import { createScheduler } from "./scheduler.js";

function createTestLogger(): {
	logger: Logger;
	lines: () => Record<string, unknown>[];
} {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});
	return {
		logger: createLogger("scheduler", { level: "trace", destination: stream }),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

const silentLogger = createLogger("scheduler", { level: "silent" });
const passthroughSchema = { parse: (d: unknown) => d };
const defaultEventFactory = createEventFactory({
	"order.received": passthroughSchema,
	"order.validated": passthroughSchema,
});

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "order.received",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "test-trigger",
		...overrides,
	} as RuntimeEvent;
}

function stubContextFactory(event: RuntimeEvent, _actionName: string): ActionContext {
	return new ActionContext(event, vi.fn(), vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
}

function createTestBus() {
	const emitted: RuntimeEvent[] = [];
	const workQueue = createWorkQueue();
	const collector = {
		async handle(event: RuntimeEvent) {
			emitted.push(event);
		},
		async bootstrap() { /* no-op */ },
	};
	const bus = createEventBus([workQueue, collector]);
	return { bus, workQueue, emitted };
}

describe("createScheduler", () => {
	describe("directed events", () => {
		it("executes matching action and emits done", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const handler = vi.fn();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler,
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			const event = makeEvent({ targetAction: "parseOrder" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler.mock.calls.at(0)?.at(0)).toBeInstanceOf(ActionContext);

			const states = emitted.map((e) => e.state);
			expect(states).toContain("processing");
			expect(states).toContain("done");
		});

		it("emits failed when action throws", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: async () => {
					throw new Error("boom");
				},
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const failed = emitted.find((e) => e.state === "done" && e.result === "failed");
			expect(failed).toBeDefined();
			expect(failed?.state === "done" && failed.result === "failed" ? failed.error : undefined).toBe("boom");
		});

		it("emits skipped when no action matches directed event", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			await bus.emit(makeEvent({ targetAction: "nonexistent" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(action.handler).not.toHaveBeenCalled();
			const skipped = emitted.find((e) => e.state === "done" && e.result === "skipped");
			expect(skipped).toBeDefined();
		});

		it("actions receive RuntimeEvent with event data", async () => {
			const { bus, workQueue } = createTestBus();
			let receivedEvent: RuntimeEvent | undefined;
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: async (ctx) => {
					receivedEvent = ctx.event;
				},
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			const event = makeEvent({ targetAction: "parseOrder", correlationId: "corr_xyz" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(receivedEvent).toBeDefined();
			expect(receivedEvent?.correlationId).toBe("corr_xyz");
		});
	});

	describe("fan-out", () => {
		it("creates targeted copies for each matching action", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			const actions: Action[] = [
				{ name: "parseOrder", on: "order.received", handler: handler1 },
				{ name: "sendEmail", on: "order.received", handler: handler2 },
			];
			const scheduler = createScheduler(workQueue, bus, actions, defaultEventFactory, stubContextFactory, silentLogger);

			const event = makeEvent();
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 50));
			await scheduler.stop();
			await started;

			expect(handler1).toHaveBeenCalledTimes(1);
			expect(handler2).toHaveBeenCalledTimes(1);

			// Original goes through processing → done
			const originalStates = emitted
				.filter((e) => e.id === event.id)
				.map((e) => e.state);
			expect(originalStates).toContain("processing");
			expect(originalStates).toContain("done");

			// Forked events have parentEventId pointing to original
			const forked = emitted.filter(
				(e) => e.state === "pending" && e.parentEventId === event.id,
			);
			expect(forked).toHaveLength(2);
			const targets = forked.map((e) => e.targetAction).sort();
			expect(targets).toEqual(["parseOrder", "sendEmail"]);
		});

		it("emits skipped when no actions match the event type", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const action: Action = {
				name: "parseOrder",
				on: "order.validated",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			const event = makeEvent({ type: "unknown.event" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(action.handler).not.toHaveBeenCalled();
			const skipped = emitted.find((e) => e.id === event.id && e.state === "done" && e.result === "skipped");
			expect(skipped).toBeDefined();
		});

		it("preserves correlationId in forked events", async () => {
			const { bus, workQueue, emitted } = createTestBus();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			const event = makeEvent({ correlationId: "corr_preserved" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const forked = emitted.find(
				(e) => e.state === "pending" && e.parentEventId === event.id,
			);
			expect(forked?.correlationId).toBe("corr_preserved");
		});

		it("only fans out to actions matching the event type", async () => {
			const { bus, workQueue } = createTestBus();
			const matchingHandler = vi.fn();
			const nonMatchingHandler = vi.fn();
			const actions: Action[] = [
				{ name: "parseOrder", on: "order.received", handler: matchingHandler },
				{ name: "updateInventory", on: "order.shipped", handler: nonMatchingHandler },
			];
			const scheduler = createScheduler(workQueue, bus, actions, defaultEventFactory, stubContextFactory, silentLogger);

			await bus.emit(makeEvent());

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			expect(matchingHandler).toHaveBeenCalledTimes(1);
			expect(nonMatchingHandler).not.toHaveBeenCalled();
		});
	});

	describe("start and stop", () => {
		it("start and stop control the loop", async () => {
			const { bus, workQueue } = createTestBus();
			const handler = vi.fn();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler,
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, silentLogger);

			const started = scheduler.start();
			await scheduler.stop();
			await started;

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));
			await new Promise((r) => setTimeout(r, 10));

			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe("logging", () => {
		it("logs action.started and action.completed on success", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, logger);

			const event = makeEvent({ targetAction: "parseOrder" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const startedLog = output.find((l) => l.msg === "action.started");
			const completed = output.find((l) => l.msg === "action.completed");

			expect(startedLog).toBeDefined();
			expect(startedLog?.action).toBe("parseOrder");
			expect(startedLog?.correlationId).toBe("corr_test");
			expect(startedLog?.eventId).toBe(event.id);

			expect(completed).toBeDefined();
			expect(completed?.action).toBe("parseOrder");
			expect(completed?.durationMs).toBeTypeOf("number");
		});

		it("logs action.failed when action throws", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: async () => {
					throw new Error("boom");
				},
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, logger);

			await bus.emit(makeEvent({ targetAction: "parseOrder" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const failed = output.find((l) => l.msg === "action.failed");
			expect(failed).toBeDefined();
			expect(failed?.action).toBe("parseOrder");
			expect(failed?.error).toBe("boom");
			expect(failed?.durationMs).toBeTypeOf("number");
			expect(failed?.level).toBe(50);
		});

		it("logs event.no-match for unmatched directed event", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				on: "order.received",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, logger);

			const event = makeEvent({ targetAction: "nonexistent" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const noMatch = output.find((l) => l.msg === "event.no-match");
			expect(noMatch).toBeDefined();
			expect(noMatch?.type).toBe("order.received");
			expect(noMatch?.correlationId).toBe("corr_test");
			expect(noMatch?.level).toBe(40);
		});

		it("logs event.fanout with target count", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const actions: Action[] = [
				{ name: "a", on: "order.received", handler: vi.fn() },
				{ name: "b", on: "order.received", handler: vi.fn() },
			];
			const scheduler = createScheduler(workQueue, bus, actions, defaultEventFactory, stubContextFactory, logger);

			await bus.emit(makeEvent());

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 50));
			await scheduler.stop();
			await started;

			const output = lines();
			const fanout = output.find((l) => l.msg === "event.fanout");
			expect(fanout).toBeDefined();
			expect(fanout?.targets).toBe(2);
			expect(fanout?.type).toBe("order.received");
		});

		it("logs event.fanout.skipped when no actions match", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				on: "order.validated",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], defaultEventFactory, stubContextFactory, logger);

			await bus.emit(makeEvent({ type: "unknown.event" }));

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const skipped = output.find((l) => l.msg === "event.fanout.skipped");
			expect(skipped).toBeDefined();
			expect(skipped?.type).toBe("unknown.event");
			expect(skipped?.level).toBe(40);
		});
	});
});
