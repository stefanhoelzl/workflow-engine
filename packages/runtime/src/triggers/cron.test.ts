import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronTriggerDescriptor, InvokeResult } from "../executor/types.js";
import { createLogger } from "../logger.js";
import { createCronTriggerSource } from "./cron.js";
import type { TriggerEntry } from "./source.js";

// ---------------------------------------------------------------------------
// Cron TriggerSource behavior tests
// ---------------------------------------------------------------------------

function makeDescriptor(
	name: string,
	schedule: string,
	tz: string,
	workflowName = "w",
): CronTriggerDescriptor {
	return {
		kind: "cron",
		type: "cron",
		name,
		workflowName,
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

interface RecordedEntry {
	entry: TriggerEntry<CronTriggerDescriptor>;
	fire: ReturnType<typeof vi.fn>;
}

function makeEntry(
	name: string,
	schedule: string,
	tz = "UTC",
	workflowName = "w",
): RecordedEntry {
	const fire = vi.fn<(input: unknown) => Promise<InvokeResult<unknown>>>(
		async () => ({ ok: true, output: undefined }),
	);
	const entry: TriggerEntry<CronTriggerDescriptor> = {
		descriptor: makeDescriptor(name, schedule, tz, workflowName),
		fire,
	};
	return { entry, fire };
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

	it("fires entry.fire with empty payload when a tick is due", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("daily", "0 9 * * *", "UTC");

		await source.reconfigure("t0", [rec.entry]);

		expect(rec.fire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1500);

		expect(rec.fire).toHaveBeenCalledTimes(1);
		expect(rec.fire.mock.calls[0]?.[0]).toEqual({});
		await source.stop();
	});

	it("rearms the next tick after firing", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:00.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("minutely", "* * * * *", "UTC");

		await source.reconfigure("t0", [rec.entry]);

		await vi.advanceTimersByTimeAsync(61_000);
		expect(rec.fire).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(rec.fire).toHaveBeenCalledTimes(2);

		await source.stop();
	});

	it("cancels pending timers on reconfigure for the same owner", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const recA = makeEntry("A", "0 9 * * *", "UTC");
		const recB = makeEntry("B", "0 10 * * *", "UTC");

		await source.reconfigure("t0", [recA.entry]);
		await source.reconfigure("t0", [recB.entry]);

		await vi.advanceTimersByTimeAsync(1500);
		expect(recA.fire).not.toHaveBeenCalled();
		expect(recB.fire).not.toHaveBeenCalled();

		// Advance ~1h to 10:00 UTC.
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(recA.fire).not.toHaveBeenCalled();
		expect(recB.fire).toHaveBeenCalledTimes(1);

		await source.stop();
	});

	it("reconfigure for one owner does not affect another", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const recA = makeEntry("A", "0 9 * * *", "UTC");
		const recB = makeEntry("B", "0 9 * * *", "UTC");

		await source.reconfigure("t0", [recA.entry]);
		await source.reconfigure("t1", [recB.entry]);

		// Clearing t0 must not cancel t1's timer.
		await source.reconfigure("t0", []);

		await vi.advanceTimersByTimeAsync(1500);
		expect(recA.fire).not.toHaveBeenCalled();
		expect(recB.fire).toHaveBeenCalledTimes(1);

		await source.stop();
	});

	it("reconfigure returns {ok: true} for valid entries", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("daily", "0 9 * * *", "UTC");

		const result = await source.reconfigure("t0", [rec.entry]);
		expect(result).toEqual({ ok: true });

		await source.stop();
	});

	it("stop cancels all timers across owners", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const recA = makeEntry("A", "0 9 * * *", "UTC");
		const recB = makeEntry("B", "0 9 * * *", "UTC");
		await source.reconfigure("t0", [recA.entry]);
		await source.reconfigure("t1", [recB.entry]);

		await source.stop();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(recA.fire).not.toHaveBeenCalled();
		expect(recB.fire).not.toHaveBeenCalled();
	});

	it("clamps long delays to 24h and re-arms without firing", async () => {
		vi.setSystemTime(new Date("2026-04-21T00:00:00.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("yearly", "0 0 1 1 *", "UTC");

		await source.reconfigure("t0", [rec.entry]);

		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1);
		expect(rec.fire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(rec.fire).not.toHaveBeenCalled();

		await source.stop();
	});

	it("silently skips missed ticks on fresh reconfigure (restart semantics)", async () => {
		vi.setSystemTime(new Date("2026-04-21T09:02:00.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("daily", "0 9 * * *", "UTC");

		await source.reconfigure("t0", [rec.entry]);

		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(rec.fire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(rec.fire).toHaveBeenCalledTimes(1);

		await source.stop();
	});

	it("getEntry resolves the installed TriggerEntry for manual fire", async () => {
		vi.setSystemTime(new Date("2026-04-21T08:59:59.000Z"));
		const source = createCronTriggerSource({ logger: silentLogger() });
		const rec = makeEntry("daily", "0 9 * * *", "UTC", "w");
		await source.reconfigure("t0", [rec.entry]);

		const resolved = source.getEntry("t0", "w", "daily");
		expect(resolved).toBe(rec.entry);
		expect(source.getEntry("t0", "w", "missing")).toBeUndefined();
		expect(source.getEntry("t1", "w", "daily")).toBeUndefined();

		await source.stop();
	});
});
