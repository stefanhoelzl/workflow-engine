import { SANDBOX_LIMIT_ERROR_NAME } from "./worker-termination.js";

// ---------------------------------------------------------------------------
// Worker-side resource-limit counters
// ---------------------------------------------------------------------------
//
// Two worker-thread counters, configured at init and reset at the start of
// every run:
//   - output bytes: cumulative serialized size of events crossing the
//     worker→main event channel.
//   - pending callables: in-flight host-callable count (Callable dispatch
//     in `plugin-runtime.ts` enters on request, exits on response/error).
//
// On breach, `throwLimit` constructs a tagged `SandboxLimitError` (name +
// own `dim` property) and throws it via `queueMicrotask` so it escapes any
// surrounding plugin try/catch, surfaces through Node's uncaughtException
// pathway, and lands on the worker's `error` event. The structured clone
// preserves the `dim` own property so main-side `worker-termination.ts` can
// classify it as `{kind:"limit", dim, observed?}`.
//
// CPU is enforced via a main-thread watchdog (`worker-termination.ts`).
// Memory and stack are RECOVERABLE caps enforced natively by QuickJS
// (memory via `QuickJS.create({memoryLimit})`, stack via
// `qjs_set_max_stack_size`); they surface as guest-catchable in-VM
// exceptions and never use the microtask-throw / `SandboxLimitError`
// path. This module handles only the two terminal worker-counter
// dimensions.

let outputBytesLimit = Number.POSITIVE_INFINITY;
let outputBytesUsed = 0;
let pendingCallablesLimit = Number.POSITIVE_INFINITY;
let pendingCallablesCount = 0;

// Terminal-class dimensions only. Recoverable caps (memory, stack) are
// enforced by QuickJS natively and surface as guest-catchable JSExceptions;
// they do NOT use this microtask-throw path.
function throwLimit(dim: "output" | "pending", observed?: number): void {
	const e = new Error(`sandbox limit exceeded: ${dim}`);
	e.name = SANDBOX_LIMIT_ERROR_NAME;
	(e as Error & { dim: string; observed?: number }).dim = dim;
	if (observed !== undefined) {
		(e as Error & { dim: string; observed?: number }).observed = observed;
	}
	queueMicrotask(() => {
		throw e;
	});
}

function configureWorkerLimits(opts: {
	outputBytes: number;
	pendingCallables: number;
}): void {
	outputBytesLimit = opts.outputBytes;
	pendingCallablesLimit = opts.pendingCallables;
}

function resetRunCounters(): void {
	outputBytesUsed = 0;
	pendingCallablesCount = 0;
}

// Measures the serialized size of an outgoing message. On the emission that
// would push cumulative usage over the cap, synthesize a `SandboxLimitError`
// with `dim="output"` and return `false` — the caller (worker's `post()`)
// skips `parentPort.postMessage` so the offending event does not cross the
// channel. The worker exits via the queued microtask throw.
function accountOutputBytes(size: number): boolean {
	if (outputBytesUsed + size > outputBytesLimit) {
		throwLimit("output", outputBytesUsed + size);
		return false;
	}
	outputBytesUsed += size;
	return true;
}

function enterPendingCallable(): void {
	pendingCallablesCount += 1;
	if (pendingCallablesCount > pendingCallablesLimit) {
		throwLimit("pending", pendingCallablesCount);
	}
}

function exitPendingCallable(): void {
	if (pendingCallablesCount > 0) {
		pendingCallablesCount -= 1;
	}
}

export {
	accountOutputBytes,
	configureWorkerLimits,
	enterPendingCallable,
	exitPendingCallable,
	resetRunCounters,
	throwLimit,
};
