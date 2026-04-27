import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent as baseMakeEvent } from "@workflow-engine/core/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { setExitFnForTests } from "../system-shutdown.js";
import { type BusConsumer, createEventBus } from "./index.js";

function makeEvent(seq: number): InvocationEvent {
	return baseMakeEvent({
		kind: "system.request",
		seq,
		ts: 1000 + seq,
		workflow: "wf",
		name: "console.log",
		input: ["hello"],
	});
}

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger;
}

function consumer(
	name: string,
	strict: boolean,
	handle: BusConsumer["handle"],
): BusConsumer {
	return { name, strict, handle };
}

describe("createEventBus", () => {
	it("fans out one event to every consumer", async () => {
		const handleA = vi.fn().mockResolvedValue(undefined);
		const handleB = vi.fn().mockResolvedValue(undefined);
		const bus = createEventBus(
			[consumer("a", false, handleA), consumer("b", false, handleB)],
			{ logger: makeLogger() },
		);

		const event = makeEvent(0);
		await bus.emit(event);

		expect(handleA).toHaveBeenCalledWith(event);
		expect(handleB).toHaveBeenCalledWith(event);
	});

	it("awaits consumers in registration order", async () => {
		const calls: string[] = [];
		const first = consumer("first", false, async () => {
			await new Promise((r) => setTimeout(r, 5));
			calls.push("first");
		});
		const second = consumer("second", false, async () => {
			calls.push("second");
		});
		const bus = createEventBus([first, second], { logger: makeLogger() });

		await bus.emit(makeEvent(0));

		expect(calls).toEqual(["first", "second"]);
	});

	it("logs and skips a best-effort consumer that throws", async () => {
		const boom = new Error("boom");
		const logger = makeLogger();
		const failing = consumer("failing", false, vi.fn().mockRejectedValue(boom));
		const after = consumer(
			"after",
			false,
			vi.fn().mockResolvedValue(undefined),
		);
		const bus = createEventBus([failing, after], { logger });

		await expect(bus.emit(makeEvent(0))).resolves.toBeUndefined();
		expect(after.handle).toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith("bus.consumer-failed", {
			consumer: "failing",
			error: expect.objectContaining({ message: "boom" }),
		});
	});

	it("emits with no consumers as a no-op", async () => {
		const logger = makeLogger();
		const bus = createEventBus([], { logger });
		await expect(bus.emit(makeEvent(0))).resolves.toBeUndefined();
		expect(logger.error).not.toHaveBeenCalled();
	});
});

describe("createEventBus — strict consumer fatal exit", () => {
	let exitSpy: ReturnType<typeof vi.fn<() => void>>;

	beforeEach(() => {
		exitSpy = vi.fn<() => void>();
		setExitFnForTests(exitSpy);
	});

	afterEach(async () => {
		// Reset to a no-op and drain pending setImmediates so they don't fire
		// against the next test's spy.
		setExitFnForTests(() => {});
		await new Promise((resolve) => setImmediate(resolve));
	});

	it("terminates the runtime when a strict consumer throws", async () => {
		const boom = new Error("storage offline");
		const logger = makeLogger();
		const failing = consumer(
			"persistence",
			true,
			vi.fn().mockRejectedValue(boom),
		);
		const after = consumer("after", false, vi.fn());
		const bus = createEventBus([failing, after], { logger });

		const event = makeEvent(0);
		// bus.emit never resolves under strict failure; start it and assert on
		// side effects.
		// biome-ignore lint/complexity/noVoid: bus.emit's Promise never resolves under strict failure; void marks the deliberate floating promise
		void bus.emit(event);

		// Drain microtasks + setImmediate so logger.error and exit hook fire.
		for (let i = 0; i < 5; i++) {
			// biome-ignore lint/performance/noAwaitInLoops: deliberate microtask drain — each Promise.resolve() yields one tick of the queue, sequential by design
			await Promise.resolve();
		}
		await new Promise((resolve) => setImmediate(resolve));

		// bus.consumer-failed logged with the consumer name + error.
		expect(logger.error).toHaveBeenCalledWith("bus.consumer-failed", {
			consumer: "persistence",
			error: expect.objectContaining({ message: "storage offline" }),
		});
		// runtime.fatal logged with the right reason and event context.
		expect(logger.error).toHaveBeenCalledWith(
			"runtime.fatal",
			expect.objectContaining({
				reason: "bus-strict-consumer-failed",
				consumer: "persistence",
				id: event.id,
				kind: event.kind,
				seq: event.seq,
				error: expect.objectContaining({ message: "storage offline" }),
			}),
		);
		// process.exit(1) scheduled exactly once.
		expect(exitSpy).toHaveBeenCalledTimes(1);
		// Subsequent consumers are NOT called (the strict failure short-circuited).
		expect(after.handle).not.toHaveBeenCalled();
	});

	it("bus.emit does not resolve after strict failure", async () => {
		const logger = makeLogger();
		const failing = consumer(
			"persistence",
			true,
			vi.fn().mockRejectedValue(new Error("boom")),
		);
		const bus = createEventBus([failing], { logger });

		const settled = await Promise.race([
			bus.emit(makeEvent(0)).then(
				() => "resolved" as const,
				() => "rejected" as const,
			),
			new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 30)),
		]);
		expect(settled).toBe("timer");
	});
});
