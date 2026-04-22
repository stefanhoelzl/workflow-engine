import type {
	Callable,
	GuestFunctionDescription,
	PluginSetup,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";

type TimerKind = "setTimeout" | "setInterval";
type ClearKind = "clearTimeout" | "clearInterval";

interface PendingTimer {
	readonly nodeId: ReturnType<typeof setTimeout>;
	readonly kind: TimerKind;
	readonly callable: Callable;
}

// HTML spec: timeout is a WebIDL `long` (ToInt32) clamped to 0 if negative.
// Without this, Node prints TimeoutNaN/Negative/Overflow warnings when guest
// code passes NaN, <0, or >=2^31. Matches the legacy normaliseDelay in
// packages/sandbox/src/globals.ts.
const INT32_MAX = 2_147_483_647;
function normaliseDelay(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > INT32_MAX) {
		return 0;
	}
	return Math.trunc(n);
}

interface TimerRegistry {
	// Delay is accepted as `unknown` to match WHATWG/HTML semantics:
	// `setTimeout`/`setInterval` coerce any value (undefined → 0, NaN → 0,
	// string "10" → 10, etc.). Strict number-typing here would reject
	// valid guest calls like `setTimeout(cb)` (no delay arg).
	readonly scheduleOnce: (cb: Callable, delay: unknown) => number;
	readonly scheduleInterval: (cb: Callable, delay: unknown) => number;
	readonly cancel: (id: number) => void;
	readonly clearAll: () => void;
}

function stopNodeTimer(entry: PendingTimer): void {
	if (entry.kind === "setTimeout") {
		clearTimeout(entry.nodeId);
	} else {
		clearInterval(entry.nodeId);
	}
}

function disposeAndStop(entry: PendingTimer): void {
	stopNodeTimer(entry);
	entry.callable.dispose();
}

// Cross-run-leak prevention — matches globals.ts `clearActive`. Each
// still-pending timer is cleared and its timer.clear leaf emitted so the
// run archive records the cleanup; Node timer ids are stopped and
// callables disposed; the map is emptied so the next run starts clean.
function clearAllPending(
	ctx: SandboxContext,
	pending: Map<number, PendingTimer>,
): void {
	for (const [id, entry] of pending) {
		const clearKind: ClearKind =
			entry.kind === "setTimeout" ? "clearTimeout" : "clearInterval";
		ctx.emit("timer.clear", clearKind, { input: { timerId: id } });
		disposeAndStop(entry);
	}
	pending.clear();
}

function createTimerRegistry(ctx: SandboxContext): TimerRegistry {
	const pending = new Map<number, PendingTimer>();

	function fire(numId: number, kind: TimerKind): void {
		const entry = pending.get(numId);
		if (!entry) {
			return;
		}
		ctx.request("timer", kind, { input: { timerId: numId } }, () =>
			entry.callable(),
		);
		if (kind === "setTimeout") {
			pending.delete(numId);
			entry.callable.dispose();
		}
	}

	function scheduleOnce(cb: Callable, rawDelay: unknown): number {
		const delay = normaliseDelay(rawDelay);
		const nodeId = setTimeout(() => fire(numId, "setTimeout"), delay);
		const numId = Number(nodeId);
		pending.set(numId, { nodeId, kind: "setTimeout", callable: cb });
		return numId;
	}

	function scheduleInterval(cb: Callable, rawDelay: unknown): number {
		const delay = normaliseDelay(rawDelay);
		const nodeId = setInterval(() => fire(numId, "setInterval"), delay);
		const numId = Number(nodeId);
		pending.set(numId, { nodeId, kind: "setInterval", callable: cb });
		return numId;
	}

	function cancel(id: number): void {
		const entry = pending.get(id);
		if (!entry) {
			return;
		}
		disposeAndStop(entry);
		pending.delete(id);
	}

	return {
		scheduleOnce,
		scheduleInterval,
		cancel,
		clearAll: () => clearAllPending(ctx, pending),
	};
}

function timersGuestFunctions(
	registry: TimerRegistry,
): GuestFunctionDescription[] {
	// `delay` is `Guest.raw()` because WHATWG allows `setTimeout(cb)` (no
	// delay) and `setTimeout(cb, "10")` (string delay); both must work.
	// Strict `Guest.number()` would throw `expected number, got undefined`
	// on valid guest calls. Coercion happens in `normaliseDelay`.
	const setTimeoutDesc: GuestFunctionDescription = {
		name: "setTimeout",
		args: [Guest.callable(), Guest.raw()],
		result: Guest.number(),
		handler: ((cb: Callable, delay: unknown) =>
			registry.scheduleOnce(
				cb,
				delay,
			)) as unknown as GuestFunctionDescription["handler"],
		log: { event: "timer.set" },
		public: true,
	};
	const setIntervalDesc: GuestFunctionDescription = {
		name: "setInterval",
		args: [Guest.callable(), Guest.raw()],
		result: Guest.number(),
		handler: ((cb: Callable, delay: unknown) =>
			registry.scheduleInterval(
				cb,
				delay,
			)) as unknown as GuestFunctionDescription["handler"],
		log: { event: "timer.set" },
		public: true,
	};
	// clearTimeout/clearInterval per WHATWG coerce any value to an integer
	// handle; `null`, `undefined`, and non-numeric values MUST be no-ops, not
	// type errors. Use `Guest.raw()` and coerce host-side.
	const clearTimeoutDesc: GuestFunctionDescription = {
		name: "clearTimeout",
		args: [Guest.raw()],
		result: Guest.void(),
		handler: ((id: unknown) => {
			const n = Number(id);
			if (Number.isFinite(n)) {
				registry.cancel(n);
			}
		}) as unknown as GuestFunctionDescription["handler"],
		log: { event: "timer.clear" },
		public: true,
	};
	const clearIntervalDesc: GuestFunctionDescription = {
		name: "clearInterval",
		args: [Guest.raw()],
		result: Guest.void(),
		handler: ((id: unknown) => {
			const n = Number(id);
			if (Number.isFinite(n)) {
				registry.cancel(n);
			}
		}) as unknown as GuestFunctionDescription["handler"],
		log: { event: "timer.clear" },
		public: true,
	};
	return [setTimeoutDesc, setIntervalDesc, clearTimeoutDesc, clearIntervalDesc];
}

/**
 * Ports legacy globals.ts setTimeout/setInterval/
 * clearTimeout/clearInterval behaviour onto the plugin architecture.
 *
 * Emission shape per timer callback:
 *   setTimeout(cb, 10) from guest →
 *     timer.set {input:{delay, timerId}}                              (leaf)
 *     … delay ms later, when the Node timer fires:
 *     timer.request {input:{timerId}}                                 (open)
 *     (any events emitted inside cb nest under timer.request)
 *     timer.response {output} or timer.error {error}                  (close)
 *   clearTimeout(id) from guest →
 *     timer.clear {input:{timerId}}                                   (leaf)
 */
const name = "timers";

function worker(ctx: SandboxContext): PluginSetup {
	const registry = createTimerRegistry(ctx);
	return {
		guestFunctions: timersGuestFunctions(registry),
		onRunFinished: () => {
			registry.clearAll();
		},
	};
}

export type { ClearKind, TimerKind };
export { name, worker };
