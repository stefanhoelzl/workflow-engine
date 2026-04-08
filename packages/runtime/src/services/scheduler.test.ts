import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { type RuntimeEvent, createEventBus } from "../event-bus/index.js";
import { createWorkQueue } from "../event-bus/work-queue.js";
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

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "order.received",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	};
}

function stubContextFactory(event: RuntimeEvent): ActionContext {
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
	it("executes matching action and emits done", async () => {
		const { bus, workQueue, emitted } = createTestBus();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

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
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler: async () => {
				throw new Error("boom");
			},
		};
		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

		await bus.emit(makeEvent({ targetAction: "parseOrder" }));

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		await scheduler.stop();
		await started;

		const failed = emitted.find((e) => e.state === "failed");
		expect(failed).toBeDefined();
		expect(failed?.error).toBe("boom");
	});

	it("emits skipped when no action matches", async () => {
		const { bus, workQueue, emitted } = createTestBus();
		const action: Action = {
			name: "parseOrder",
			match: () => false,
			handler: vi.fn(),
		};
		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

		await bus.emit(makeEvent());

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		await scheduler.stop();
		await started;

		expect(action.handler).not.toHaveBeenCalled();

		const skipped = emitted.find((e) => e.state === "skipped");
		expect(skipped).toBeDefined();
	});

	it("emits failed when multiple actions match", async () => {
		const { bus, workQueue, emitted } = createTestBus();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		const action1: Action = {
			name: "action1",
			match: () => true,
			handler: handler1,
		};
		const action2: Action = {
			name: "action2",
			match: () => true,
			handler: handler2,
		};
		const scheduler = createScheduler(
			workQueue,
			bus,
			[action1, action2],
			stubContextFactory,
			silentLogger,
		);

		await bus.emit(makeEvent());

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		await scheduler.stop();
		await started;

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();

		const failed = emitted.find((e) => e.state === "failed");
		expect(failed).toBeDefined();
		expect(failed?.error).toBe("ambiguous match");
	});

	it("start and stop control the loop", async () => {
		const { bus, workQueue } = createTestBus();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) => e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

		const started = scheduler.start();
		await scheduler.stop();
		await started;

		await bus.emit(makeEvent({ targetAction: "parseOrder" }));
		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});

	it("actions receive RuntimeEvent with event data", async () => {
		const { bus, workQueue } = createTestBus();
		let receivedEvent: RuntimeEvent | undefined;
		const action: Action = {
			name: "parseOrder",
			match: (e) => e.targetAction === "parseOrder",
			handler: async (ctx) => {
				receivedEvent = ctx.event;
			},
		};
		const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, silentLogger);

		const event = makeEvent({ targetAction: "parseOrder", correlationId: "corr_xyz" });
		await bus.emit(event);

		const started = scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		await scheduler.stop();
		await started;

		expect(receivedEvent).toBeDefined();
		expect(receivedEvent?.correlationId).toBe("corr_xyz");
	});

	describe("logging", () => {
		it("logs action.started and action.completed on success", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				match: (e) => e.targetAction === "parseOrder",
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, logger);

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
				match: (e) => e.targetAction === "parseOrder",
				handler: async () => {
					throw new Error("boom");
				},
			};
			const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, logger);

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

		it("logs event.no-match when no action matches", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				match: () => false,
				handler: vi.fn(),
			};
			const scheduler = createScheduler(workQueue, bus, [action], stubContextFactory, logger);

			const event = makeEvent({ type: "unknown.event" });
			await bus.emit(event);

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const noMatch = output.find((l) => l.msg === "event.no-match");
			expect(noMatch).toBeDefined();
			expect(noMatch?.type).toBe("unknown.event");
			expect(noMatch?.correlationId).toBe("corr_test");
			expect(noMatch?.level).toBe(40);
		});

		it("logs event.ambiguous-match when multiple actions match", async () => {
			const { bus, workQueue } = createTestBus();
			const { logger, lines } = createTestLogger();
			const action1: Action = { name: "a", match: () => true, handler: vi.fn() };
			const action2: Action = { name: "b", match: () => true, handler: vi.fn() };
			const scheduler = createScheduler(workQueue, bus, [action1, action2], stubContextFactory, logger);

			await bus.emit(makeEvent());

			const started = scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			await scheduler.stop();
			await started;

			const output = lines();
			const ambiguous = output.find((l) => l.msg === "event.ambiguous-match");
			expect(ambiguous).toBeDefined();
			expect(ambiguous?.actions).toEqual(["a", "b"]);
			expect(ambiguous?.level).toBe(50);
		});
	});
});
