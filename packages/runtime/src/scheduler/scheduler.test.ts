import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/index.js";
import { ActionContext } from "../context/index.js";
import { InMemoryEventQueue } from "../event-queue/in-memory.js";
import type { Event } from "../event-queue/index.js";
import { type Logger, createLogger } from "../logger.js";
import { Scheduler } from "./index.js";

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

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		id: `evt_${crypto.randomUUID()}`,
		type: "order.received",
		payload: {},
		correlationId: "corr_test",
		createdAt: new Date(),
		...overrides,
	};
}

function stubContextFactory(event: Event): ActionContext {
	return new ActionContext(event, vi.fn(), vi.fn() as unknown as typeof globalThis.fetch, {}, silentLogger);
}

describe("Scheduler", () => {
	it("executes matching action and acks event", async () => {
		const queue = new InMemoryEventQueue();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory, silentLogger);

		const event = makeEvent({ targetAction: "parseOrder" });
		await queue.enqueue(event);

		scheduler.start();

		// Give the loop a tick to process
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		// Enqueue a dummy event to unblock dequeue so the loop exits
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls.at(0)?.at(0)).toBeInstanceOf(ActionContext);
		expect(handler.mock.calls.at(0)?.at(0).event).toBe(event);
	});

	it("fails event when action throws", async () => {
		const queue = new InMemoryEventQueue();
		const action: Action = {
			name: "parseOrder",
			match: (e) =>
				e.type === "order.received" && e.targetAction === "parseOrder",
			handler: async () => {
				throw new Error("boom");
			},
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory, silentLogger);

		const event = makeEvent({ targetAction: "parseOrder" });
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		// Event should not be available for dequeue (it's failed, not pending)
		const marker = makeEvent({ id: "evt_marker" });
		await queue.enqueue(marker);
		const next = await queue.dequeue();
		expect(next.id).toBe("evt_marker");
	});

	it("acks event when no action matches", async () => {
		const queue = new InMemoryEventQueue();
		const action: Action = {
			name: "parseOrder",
			match: () => false,
			handler: vi.fn(),
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory, silentLogger);

		const event = makeEvent();
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(action.handler).not.toHaveBeenCalled();
	});

	it("fails event when multiple actions match", async () => {
		const queue = new InMemoryEventQueue();
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
		const scheduler = new Scheduler(
			queue,
			[action1, action2],
			stubContextFactory,
			silentLogger,
		);

		const event = makeEvent();
		await queue.enqueue(event);

		scheduler.start();
		await new Promise((r) => setTimeout(r, 10));
		scheduler.stop();
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();
	});

	it("start and stop control the loop", async () => {
		const queue = new InMemoryEventQueue();
		const handler = vi.fn();
		const action: Action = {
			name: "parseOrder",
			match: (e) => e.targetAction === "parseOrder",
			handler,
		};
		const scheduler = new Scheduler(queue, [action], stubContextFactory, silentLogger);

		scheduler.start();
		scheduler.stop();
		// Enqueue a dummy to unblock dequeue
		await queue.enqueue(makeEvent());
		await scheduler.stopped;

		// Enqueue after stop — should not be processed
		await queue.enqueue(makeEvent({ targetAction: "parseOrder" }));
		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});

	describe("logging", () => {
		it("logs action.started and action.completed on success", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				match: (e) => e.targetAction === "parseOrder",
				handler: vi.fn(),
			};
			const scheduler = new Scheduler(queue, [action], stubContextFactory, logger);

			const event = makeEvent({ targetAction: "parseOrder" });
			await queue.enqueue(event);

			scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			scheduler.stop();
			await queue.enqueue(makeEvent());
			await scheduler.stopped;

			const output = lines();
			const started = output.find((l) => l.msg === "action.started");
			const completed = output.find((l) => l.msg === "action.completed");

			expect(started).toBeDefined();
			expect(started?.action).toBe("parseOrder");
			expect(started?.correlationId).toBe("corr_test");
			expect(started?.eventId).toBe(event.id);

			expect(completed).toBeDefined();
			expect(completed?.action).toBe("parseOrder");
			expect(completed?.durationMs).toBeTypeOf("number");
		});

		it("logs action.failed when action throws", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				match: (e) => e.targetAction === "parseOrder",
				handler: async () => {
					throw new Error("boom");
				},
			};
			const scheduler = new Scheduler(queue, [action], stubContextFactory, logger);

			await queue.enqueue(makeEvent({ targetAction: "parseOrder" }));

			scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			scheduler.stop();
			await queue.enqueue(makeEvent());
			await scheduler.stopped;

			const output = lines();
			const failed = output.find((l) => l.msg === "action.failed");
			expect(failed).toBeDefined();
			expect(failed?.action).toBe("parseOrder");
			expect(failed?.error).toBe("boom");
			expect(failed?.durationMs).toBeTypeOf("number");
			// pino error level = 50
			expect(failed?.level).toBe(50);
		});

		it("logs event.no-match when no action matches", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const action: Action = {
				name: "parseOrder",
				match: () => false,
				handler: vi.fn(),
			};
			const scheduler = new Scheduler(queue, [action], stubContextFactory, logger);

			const event = makeEvent({ type: "unknown.event" });
			await queue.enqueue(event);

			scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			scheduler.stop();
			await queue.enqueue(makeEvent());
			await scheduler.stopped;

			const output = lines();
			const noMatch = output.find((l) => l.msg === "event.no-match");
			expect(noMatch).toBeDefined();
			expect(noMatch?.type).toBe("unknown.event");
			expect(noMatch?.correlationId).toBe("corr_test");
			// pino warn level = 40
			expect(noMatch?.level).toBe(40);
		});

		it("logs event.ambiguous-match when multiple actions match", async () => {
			const queue = new InMemoryEventQueue();
			const { logger, lines } = createTestLogger();
			const action1: Action = { name: "a", match: () => true, handler: vi.fn() };
			const action2: Action = { name: "b", match: () => true, handler: vi.fn() };
			const scheduler = new Scheduler(queue, [action1, action2], stubContextFactory, logger);

			await queue.enqueue(makeEvent());

			scheduler.start();
			await new Promise((r) => setTimeout(r, 10));
			scheduler.stop();
			await queue.enqueue(makeEvent());
			await scheduler.stopped;

			const output = lines();
			const ambiguous = output.find((l) => l.msg === "event.ambiguous-match");
			expect(ambiguous).toBeDefined();
			expect(ambiguous?.actions).toEqual(["a", "b"]);
			// pino error level = 50
			expect(ambiguous?.level).toBe(50);
		});
	});
});
