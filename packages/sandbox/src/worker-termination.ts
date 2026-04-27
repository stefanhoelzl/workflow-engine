import type { Worker } from "node:worker_threads";

// ---------------------------------------------------------------------------
// Worker-termination correlation
// ---------------------------------------------------------------------------
//
// Encapsulates the state machine that correlates Node's `worker.on("error")`
// and `worker.on("exit")` events with an optional main-thread CPU watchdog to
// produce a single exactly-once `TerminationCause` dispatch. The sandbox
// consumes this via `createWorkerTermination(worker)` and exposes a widened
// `onTerminated(cause)` callback in place of the old `onDied(err)`.
//
// Classification rules:
//   - `disposing` (caller invoked `dispose()`): suppress all dispatch.
//   - `cpuBudgetExpired` (watchdog fired): synthesize
//     `{kind:"limit", dim:"cpu", observed: <ms elapsed>}` — no Error lands on
//     the worker's error channel because main called `worker.terminate()`.
//   - tagged `SandboxLimitError` from the worker (`err.name === "SANDBOX_LIMIT_ERROR_NAME"`,
//     own `dim` property): `{kind:"limit", dim, observed?}` copying the
//     structured-cloned own props.
//   - any other Error or non-zero exit without a recorded error: treated as
//     a crash `{kind:"crash", err}`.
//
// `LimitDim` is the TERMINAL-only dimension union. Recoverable caps
// (memory, stack) surface as catchable QuickJS exceptions inside the VM
// and never reach this classification — the worker stays alive.
//
// The module is deliberately ignorant of what `dim` values mean — it just
// forwards them. The sandbox-store and executor interpret the cause.

const SANDBOX_LIMIT_ERROR_NAME = "SandboxLimitError";

type LimitDim = "cpu" | "output" | "pending";

type TerminationCause =
	| { kind: "limit"; dim: LimitDim; observed?: number }
	| { kind: "crash"; err: Error };

interface WorkerTermination {
	armCpuBudget(ms: number): void;
	disarmCpuBudget(): void;
	markDisposing(): void;
	onTerminated(cb: (cause: TerminationCause) => void): void;
	// Synchronous getter consumed by `sandbox.ts`'s `onError` / `onExit`
	// handlers inside `sb.run()` so the run promise can settle with
	// the same classification the `onTerminated` callback would deliver.
	// Returns `null` when the worker is disposing or has not yet
	// recorded a terminating signal.
	cause(): TerminationCause | null;
}

interface SandboxLimitErrorShape {
	readonly name: string;
	readonly dim?: unknown;
	readonly observed?: unknown;
}

function isSandboxLimitError(
	err: unknown,
): err is Error & SandboxLimitErrorShape {
	if (!(err instanceof Error)) {
		return false;
	}
	if (err.name !== SANDBOX_LIMIT_ERROR_NAME) {
		return false;
	}
	const dim = (err as unknown as SandboxLimitErrorShape).dim;
	return dim === "output" || dim === "pending";
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure binds worker-event wiring, classify(), arm/disarm watchdog, and dispatch state into one cohesive state machine; splitting would require a shared mutable container purely for structure.
function createWorkerTermination(worker: Worker): WorkerTermination {
	let lastError: Error | null = null;
	let disposing = false;
	let cpuBudgetExpired = false;
	let observedOnExpiry: number | null = null;
	let fired = false;
	let startedAt = 0;
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	let terminatedCb: ((cause: TerminationCause) => void) | null = null;

	function dispatch(cause: TerminationCause): void {
		if (fired) {
			return;
		}
		fired = true;
		if (terminatedCb) {
			terminatedCb(cause);
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: classify reads three flags (cpuBudgetExpired / lastError / isSandboxLimitError) into a discriminated union — the cascade IS the specification, not accidental branching.
	function classify(): TerminationCause {
		if (cpuBudgetExpired) {
			const cause: TerminationCause = {
				kind: "limit",
				dim: "cpu",
				...(observedOnExpiry === null ? {} : { observed: observedOnExpiry }),
			};
			return cause;
		}
		if (lastError && isSandboxLimitError(lastError)) {
			const dim = (lastError as unknown as SandboxLimitErrorShape)
				.dim as LimitDim;
			const observedRaw = (lastError as unknown as SandboxLimitErrorShape)
				.observed;
			const observed =
				typeof observedRaw === "number" && Number.isFinite(observedRaw)
					? observedRaw
					: undefined;
			return {
				kind: "limit",
				dim,
				...(observed === undefined ? {} : { observed }),
			};
		}
		const err = lastError ?? new Error("worker exited");
		return { kind: "crash", err };
	}

	worker.on("error", (err) => {
		// Record the FIRST error — subsequent errors (if any) are ignored.
		// Node delivers the uncaught exception via a single `error` event;
		// extra events would indicate multiple unrelated failures.
		if (!lastError) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	});

	worker.on("exit", () => {
		if (disposing) {
			return;
		}
		dispatch(classify());
	});

	return {
		armCpuBudget(ms: number): void {
			startedAt = Date.now();
			cpuBudgetExpired = false;
			observedOnExpiry = null;
			if (watchdog !== null) {
				clearTimeout(watchdog);
			}
			watchdog = setTimeout(() => {
				watchdog = null;
				cpuBudgetExpired = true;
				observedOnExpiry = Date.now() - startedAt;
				worker.terminate().catch(() => {
					// `terminate()` may reject after the worker has already
					// exited; the exit handler above still fires dispatch.
				});
			}, ms);
		},
		disarmCpuBudget(): void {
			if (watchdog !== null) {
				clearTimeout(watchdog);
				watchdog = null;
			}
		},
		markDisposing(): void {
			disposing = true;
			if (watchdog !== null) {
				clearTimeout(watchdog);
				watchdog = null;
			}
		},
		onTerminated(cb: (cause: TerminationCause) => void): void {
			terminatedCb = cb;
		},
		cause(): TerminationCause | null {
			if (disposing) {
				return null;
			}
			if (!(cpuBudgetExpired || lastError)) {
				return null;
			}
			return classify();
		},
	};
}

export type { LimitDim, TerminationCause, WorkerTermination };
export { createWorkerTermination, SANDBOX_LIMIT_ERROR_NAME };
