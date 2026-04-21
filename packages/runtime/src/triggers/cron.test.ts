import type { WorkflowManifest } from "@workflow-engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type { CronTriggerDescriptor } from "../executor/types.js";
import { createLogger } from "../logger.js";
import { createCronTriggerSource } from "./cron.js";
import type { TriggerViewEntry } from "./source.js";

// ---------------------------------------------------------------------------
// Cron TriggerSource behavior tests
// ---------------------------------------------------------------------------

function makeWorkflow(): WorkflowManifest {
	return {
		name: "w",
		module: "w.js",
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
	};
}

function makeDescriptor(
	name: string,
	schedule: string,
	tz: string,
): CronTriggerDescriptor {
	return {
		kind: "cron",
		type: "cron",
		name,
		schedule,
		tz,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
}

function makeView(
	name: string,
	schedule: string,
	tz = "UTC",
): TriggerViewEntry<"cron"> {
	return {
		tenant: "t0",
		workflow: makeWorkflow(),
		bundleSource: "source",
		descriptor: makeDescriptor(name, schedule, tz),
	};
}

function stubExecutor(): Executor {
	return {
		invoke: vi.fn(async () => ({
			ok: true as const,
			output: undefined,
		})),
	};
}

function silentLogger() {
	return createLogger("test", { level: "silent" });
}

describe("createCronTriggerSource", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires executor.invoke with empty payload when a tick is due", async () => {
		// Set the fake clock to 08:59:59 UTC so the next '0 9 * * *' fires in 1s.
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});

		source.reconfigure([makeView("daily", "0 9 * * *", "UTC")]);

		expect(executor.invoke).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1500);

		expect(executor.invoke).toHaveBeenCalledTimes(1);
		const call = (executor.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.[0]).toBe("t0"); // tenant
		expect(call?.[3]).toEqual({}); // payload
		await source.stop();
	});

	it("rearms the next tick after firing", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:00.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});

		// Every minute on the minute.
		source.reconfigure([makeView("minutely", "* * * * *", "UTC")]);

		// Advance past the first tick (60s) and the second (another 60s).
		await vi.advanceTimersByTimeAsync(61_000);
		expect(executor.invoke).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(executor.invoke).toHaveBeenCalledTimes(2);

		await source.stop();
	});

	it("cancels pending timers on reconfigure", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});

		source.reconfigure([makeView("A", "0 9 * * *", "UTC")]);
		// Replace with a different view BEFORE the 1s tick fires.
		source.reconfigure([makeView("B", "0 10 * * *", "UTC")]);

		// Advance past A's old fire time.
		await vi.advanceTimersByTimeAsync(1500);
		expect(executor.invoke).not.toHaveBeenCalled();

		// Advance to B's fire time (10:00 = ~3600s from start).
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(executor.invoke).toHaveBeenCalledTimes(1);
		const call = (executor.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
		// Descriptor from B is passed.
		expect((call?.[2] as CronTriggerDescriptor).name).toBe("B");

		await source.stop();
	});

	it("stop cancels all timers so no more ticks fire", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});
		source.reconfigure([makeView("daily", "0 9 * * *", "UTC")]);

		await source.stop();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(executor.invoke).not.toHaveBeenCalled();
	});

	it("clamps long delays to 24h and re-arms without firing", async () => {
		// Yearly schedule: next fire in ~1 year → well past the 24h clamp.
		vi.setSystemTime(new Date("2026-04-21T00:00:00.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});

		source.reconfigure([makeView("yearly", "0 0 1 1 *", "UTC")]);

		// Advance past the 24h clamp — it should re-arm but NOT invoke
		// (since the real fire time is still ~354 days away).
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1);
		expect(executor.invoke).not.toHaveBeenCalled();

		// Advance another 24h — still no fire.
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(executor.invoke).not.toHaveBeenCalled();

		await source.stop();
	});

	it("silently skips missed ticks on fresh reconfigure (restart semantics)", async () => {
		// Simulate a restart where the "previous" 09:00 fire would have been
		// missed — the source should compute nextDate(now=09:02) = tomorrow 09:00,
		// not fire for today's missed 09:00.
		vi.setSystemTime(new Date("2026-04-21T09:02:00.000Z"));
		const executor = stubExecutor();
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});
		source.reconfigure([makeView("daily", "0 9 * * *", "UTC")]);

		// Advance 12 hours — still haven't hit tomorrow 09:00.
		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(executor.invoke).not.toHaveBeenCalled();

		// Advance the remaining ~11h58m to hit tomorrow 09:00.
		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(executor.invoke).toHaveBeenCalledTimes(1);

		await source.stop();
	});

	it("rearms a tick from the current clock even after a long invocation", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:00.000Z"));

		// Invoke takes 30s (delayed resolution). In real time the runQueue
		// would serialize, but the cron source itself should rearm based on
		// `now` AFTER the invocation resolves.
		const executor: Executor = {
			invoke: vi.fn(async () => {
				await new Promise((r) => setTimeout(r, 30_000));
				return { ok: true as const, output: undefined };
			}),
		};
		const source = createCronTriggerSource({
			executor,
			logger: silentLogger(),
		});
		source.reconfigure([makeView("minutely", "* * * * *", "UTC")]);

		// Advance to the first fire (60s), then the 30s the handler takes,
		// then a bit more. The next tick should fire at minute-2 boundary
		// (not at minute-1.5).
		await vi.advanceTimersByTimeAsync(60_000); // fires at 0:01:00
		await vi.advanceTimersByTimeAsync(30_000); // handler resolves at 0:01:30
		await vi.advanceTimersByTimeAsync(1000); // let micro-tasks drain
		// At this point the next arm computed from 0:01:31 -> next fire 0:02:00.
		expect(executor.invoke).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000); // advance to 0:02:01
		expect(executor.invoke).toHaveBeenCalledTimes(2);

		await source.stop();
	});
});
