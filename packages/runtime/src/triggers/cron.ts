import { CronExpressionParser } from "cron-parser";
import type { CronTriggerDescriptor } from "../executor/types.js";
import type { Logger } from "../logger.js";
import type {
	ReconfigureResult,
	TriggerEntry,
	TriggerSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// Cron TriggerSource
// ---------------------------------------------------------------------------
//
// `createCronTriggerSource` is the cron-kind protocol adapter. The source:
//   - Holds one `setTimeout` handle per (owner, repo, workflowName,
//     triggerName), grouped per-(owner, repo) so
//     `reconfigure(owner, repo, entries)` only touches that pair's timers.
//   - Receives `reconfigure(owner, repo, entries)` from the WorkflowRegistry
//     on every repo upload. Entries for other (owner, repo) pairs are
//     untouched.
//   - On each fire, invokes `entry.fire({})` with an empty payload and
//     arms the next tick regardless of outcome.
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
	readonly logger: Logger;
}

interface SourceEntry {
	readonly owner: string;
	readonly repo: string;
	readonly entry: TriggerEntry<CronTriggerDescriptor>;
	timer: ReturnType<typeof setTimeout> | undefined;
}

interface CronTriggerSource
	extends TriggerSource<"cron", CronTriggerDescriptor> {
	getEntry(
		owner: string,
		repo: string,
		workflowName: string,
		triggerName: string,
	): TriggerEntry<CronTriggerDescriptor> | undefined;
}

function entryKey(workflowName: string, triggerName: string): string {
	return `${workflowName}/${triggerName}`;
}

function pairKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
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
): CronTriggerSource {
	// Per-(owner, repo) map of entry-key -> SourceEntry. Outer key is
	// "owner/repo" so `reconfigure(owner, repo, [])` can cancel only that
	// pair's timers.
	const pairs = new Map<string, Map<string, SourceEntry>>();

	function cancelPair(owner: string, repo: string): void {
		const entries = pairs.get(pairKey(owner, repo));
		if (!entries) {
			return;
		}
		for (const entry of entries.values()) {
			if (entry.timer !== undefined) {
				clearTimeout(entry.timer);
				entry.timer = undefined;
			}
		}
	}

	function cancelAll(): void {
		for (const entries of pairs.values()) {
			for (const entry of entries.values()) {
				if (entry.timer !== undefined) {
					clearTimeout(entry.timer);
					entry.timer = undefined;
				}
			}
		}
	}

	function arm(srcEntry: SourceEntry): void {
		const now = new Date();
		let delay: number;
		try {
			delay = computeNextDelay(srcEntry.entry.descriptor, now);
		} catch (err) {
			// Schedule or tz invalid — shouldn't reach here because the manifest
			// Zod schema gates both at upload, but fail loudly if it does.
			const message = err instanceof Error ? err.message : String(err);
			deps.logger.error("cron.schedule-invalid", {
				owner: srcEntry.owner,
				repo: srcEntry.repo,
				workflow: srcEntry.entry.descriptor.workflowName,
				trigger: srcEntry.entry.descriptor.name,
				schedule: srcEntry.entry.descriptor.schedule,
				tz: srcEntry.entry.descriptor.tz,
				error: message,
			});
			// Surface to the author via the dashboard. Single shared call site
			// for cold-boot arm, post-fire re-arm, and reconfigure() re-arm —
			// the assertion in `emitTriggerException` keeps this kind safe.
			srcEntry.entry
				.exception({
					name: "cron.schedule-invalid",
					error: { message },
					input: {
						schedule: srcEntry.entry.descriptor.schedule,
						tz: srcEntry.entry.descriptor.tz,
					},
				})
				.catch((emitErr) => {
					deps.logger.error("cron.exception-emit-failed", {
						owner: srcEntry.owner,
						repo: srcEntry.repo,
						workflow: srcEntry.entry.descriptor.workflowName,
						trigger: srcEntry.entry.descriptor.name,
						error: emitErr instanceof Error ? emitErr.message : String(emitErr),
					});
				});
			return;
		}
		const clamped = Math.min(delay, MAX_TIMEOUT_MS);
		const wasClamped = clamped < delay;
		srcEntry.timer = setTimeout(() => {
			onFire(srcEntry, wasClamped).catch(() => {
				// onFire already logs any thrown error; swallow the rejection
				// here so an unhandledPromiseRejection doesn't tear down the
				// process on a transient schedule/dispatch failure.
			});
		}, clamped);
	}

	async function onFire(
		srcEntry: SourceEntry,
		wasClamped: boolean,
	): Promise<void> {
		srcEntry.timer = undefined;
		if (wasClamped) {
			// Under the 24h clamp the timer woke up early on purpose. Don't
			// fire; recompute and re-arm so we eventually land on the real
			// scheduled instant.
			arm(srcEntry);
			return;
		}
		try {
			// No dispatch argument — the executor defaults to
			// `{ source: "trigger" }`, which is the correct provenance for
			// every cron tick (scheduled backend wake, not a manual fire).
			await srcEntry.entry.fire({});
		} catch (err) {
			// `fire` is built by the registry and returns `{ok, ...}` rather
			// than throwing; a thrown error here means the registry-built
			// closure itself failed (should not happen). Log and keep
			// scheduling.
			deps.logger.error("cron.fire-threw", {
				owner: srcEntry.owner,
				repo: srcEntry.repo,
				workflow: srcEntry.entry.descriptor.workflowName,
				trigger: srcEntry.entry.descriptor.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Re-arm from the current clock regardless of invocation outcome.
		// Guard against races with reconfigure: only re-arm if this entry
		// is still the current one for its key.
		const pairMap = pairs.get(pairKey(srcEntry.owner, srcEntry.repo));
		const key = entryKey(
			srcEntry.entry.descriptor.workflowName,
			srcEntry.entry.descriptor.name,
		);
		if (pairMap?.get(key) === srcEntry) {
			arm(srcEntry);
		}
	}

	return {
		kind: "cron",
		start() {
			return Promise.resolve();
		},
		stop() {
			cancelAll();
			pairs.clear();
			return Promise.resolve();
		},
		reconfigure(
			owner: string,
			repo: string,
			entries: readonly TriggerEntry<CronTriggerDescriptor>[],
		): Promise<ReconfigureResult> {
			const key = pairKey(owner, repo);
			cancelPair(owner, repo);
			pairs.delete(key);
			if (entries.length === 0) {
				return Promise.resolve({ ok: true });
			}
			const pairMap = new Map<string, SourceEntry>();
			pairs.set(key, pairMap);
			for (const entry of entries) {
				const srcEntry: SourceEntry = {
					owner,
					repo,
					entry,
					timer: undefined,
				};
				pairMap.set(
					entryKey(entry.descriptor.workflowName, entry.descriptor.name),
					srcEntry,
				);
				arm(srcEntry);
			}
			return Promise.resolve({ ok: true });
		},
		getEntry(owner, repo, workflowName, triggerName) {
			return pairs
				.get(pairKey(owner, repo))
				?.get(entryKey(workflowName, triggerName))?.entry;
		},
	};
}

export type { CronTriggerSource };
export { createCronTriggerSource };
