import { CronExpressionParser } from "cron-parser";
import type { Executor } from "../executor/index.js";
import type { CronTriggerDescriptor } from "../executor/types.js";
import type { Logger } from "../logger.js";
import type { TriggerSource, TriggerViewEntry } from "./source.js";

// ---------------------------------------------------------------------------
// Cron TriggerSource
// ---------------------------------------------------------------------------
//
// `createCronTriggerSource` is the cron-kind protocol adapter. The source:
//   - Holds one `setTimeout` handle per (tenant, workflow, trigger name).
//   - Receives a kind-filtered view of cron descriptors via `reconfigure()`
//     on every workflow state change (the WorkflowRegistry pushes these).
//   - On each fire, invokes `executor.invoke(tenant, workflow, descriptor,
//     {}, bundleSource)` with an empty payload and arms the next tick
//     regardless of the invocation outcome.
//   - Clamps `setTimeout` delays to 24h max so yearly schedules don't hit
//     Node's signed-int-ms overflow, and so DST/clock-drift corrections
//     are picked up on the next wake.
//
// Scheduled ticks on restart are silently skipped: the source computes
// `nextDate(now, tz)` for each entry at `reconfigure` time and arms for
// that instant. Missed ticks are not recovered and no lifecycle event
// is emitted for them (by design — see openspec cron-trigger spec).

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MAX_TIMEOUT_MS =
	HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

interface CronTriggerSourceDeps {
	readonly executor: Executor;
	readonly logger: Logger;
}

interface SourceEntry {
	readonly tenant: string;
	readonly workflow: TriggerViewEntry<"cron">["workflow"];
	readonly bundleSource: string;
	readonly descriptor: CronTriggerDescriptor;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function entryKey(
	tenant: string,
	workflowName: string,
	triggerName: string,
): string {
	return `${tenant}\u0000${workflowName}\u0000${triggerName}`;
}

function computeNextDelay(
	descriptor: CronTriggerDescriptor,
	now: Date,
): number {
	const cron = CronExpressionParser.parse(descriptor.schedule, {
		tz: descriptor.tz,
		currentDate: now,
	});
	const nextDate = cron.next();
	const delay = nextDate.getTime() - now.getTime();
	// `cron-parser` always returns a next date strictly after `currentDate`
	// (the parser treats `currentDate` exclusively), so `delay` is always > 0
	// under normal operation. Guard anyway to avoid a zero-delay tight loop
	// if that invariant ever changes.
	return Math.max(delay, 1);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups source state, arm/cancel helpers, and TriggerSource lifecycle methods
function createCronTriggerSource(
	deps: CronTriggerSourceDeps,
): TriggerSource<"cron"> {
	const entries = new Map<string, SourceEntry>();

	function cancelAll(): void {
		for (const entry of entries.values()) {
			if (entry.timer !== undefined) {
				clearTimeout(entry.timer);
				entry.timer = undefined;
			}
		}
	}

	function arm(entry: SourceEntry): void {
		const now = new Date();
		let delay: number;
		try {
			delay = computeNextDelay(entry.descriptor, now);
		} catch (err) {
			// Schedule or tz invalid — shouldn't reach here because the manifest
			// Zod schema gates both at upload, but fail loudly if it does.
			deps.logger.error("cron.schedule-invalid", {
				tenant: entry.tenant,
				workflow: entry.workflow.name,
				trigger: entry.descriptor.name,
				schedule: entry.descriptor.schedule,
				tz: entry.descriptor.tz,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		const clamped = Math.min(delay, MAX_TIMEOUT_MS);
		const wasClamped = clamped < delay;
		entry.timer = setTimeout(() => {
			onFire(entry, wasClamped).catch(() => {
				// onFire already logs any thrown error; swallow the rejection
				// here so an unhandledPromiseRejection doesn't tear down the
				// process on a transient schedule/dispatch failure.
			});
		}, clamped);
	}

	async function onFire(
		entry: SourceEntry,
		wasClamped: boolean,
	): Promise<void> {
		entry.timer = undefined;
		if (wasClamped) {
			// Under the 24h clamp the timer woke up early on purpose. Don't
			// invoke; recompute and re-arm so we eventually land on the real
			// scheduled instant.
			arm(entry);
			return;
		}
		try {
			await deps.executor.invoke(
				entry.tenant,
				entry.workflow,
				entry.descriptor,
				{},
				entry.bundleSource,
			);
		} catch (err) {
			// `executor.invoke` translates handler errors into `{ok:false}`
			// envelopes; a thrown error here means the executor itself failed
			// (sandbox construction, queue dispatch). Log and keep scheduling.
			deps.logger.error("cron.invoke-threw", {
				tenant: entry.tenant,
				workflow: entry.workflow.name,
				trigger: entry.descriptor.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Re-arm from the current clock regardless of invocation outcome.
		// This prevents a long-running invocation from causing the next tick
		// to fire immediately (we always compute nextDate(now)).
		if (
			entries.get(
				entryKey(entry.tenant, entry.workflow.name, entry.descriptor.name),
			) === entry
		) {
			arm(entry);
		}
	}

	return {
		kind: "cron",
		start() {
			return Promise.resolve();
		},
		stop() {
			cancelAll();
			entries.clear();
			return Promise.resolve();
		},
		reconfigure(view: readonly TriggerViewEntry<"cron">[]) {
			cancelAll();
			entries.clear();
			for (const v of view) {
				const descriptor = v.descriptor as CronTriggerDescriptor;
				const entry: SourceEntry = {
					tenant: v.tenant,
					workflow: v.workflow,
					bundleSource: v.bundleSource,
					descriptor,
					timer: undefined,
				};
				entries.set(
					entryKey(v.tenant, v.workflow.name, descriptor.name),
					entry,
				);
				arm(entry);
			}
		},
	};
}

export { createCronTriggerSource };
