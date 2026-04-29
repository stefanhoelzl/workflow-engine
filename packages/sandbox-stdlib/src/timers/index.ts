import type {
	Callable,
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
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
// still-pending timer is cleared and its `system.call name="clear*"` leaf
// emitted so the run archive records the cleanup; Node timer ids are
// stopped and callables disposed; the map is emptied so the next run
// starts clean.
function clearAllPending(
	ctx: PluginContext,
	pending: Map<number, PendingTimer>,
): void {
	for (const [id, entry] of pending) {
		const clearKind: ClearKind =
			entry.kind === "setTimeout" ? "clearTimeout" : "clearInterval";
		ctx.emit("system.call", { name: clearKind, input: { timerId: id } });
		disposeAndStop(entry);
	}
	pending.clear();
}

function createTimerRegistry(ctx: PluginContext): TimerRegistry {
	const pending = new Map<number, PendingTimer>();

	function fire(numId: number, kind: TimerKind): void {
		const entry = pending.get(numId);
		if (!entry) {
			return;
		}
		ctx.request("system", { name: kind, input: { timerId: numId } }, () =>
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

// `logInput` strips the Callable from the `timer.set` event — a Callable is
// a host-thread wrapper holding an `invoke` function and a `JSValueHandle`
// ref; forwarding it to the main thread via `port.postMessage` fails with
// DataCloneError because functions are not structured-cloneable. Emit only
// the delay. (timerId belongs on the ensuing `timer.request` event, not the
// leaf.)
function timerSetLogInput(args: readonly unknown[]): { delay: unknown } {
	return { delay: args[1] };
}

// `delay` is `Guest.raw()` because WHATWG allows `setTimeout(cb)` (no delay)
// and `setTimeout(cb, "10")` (string delay); both must work. Strict
// `Guest.number()` would throw `expected number, got undefined` on valid
// guest calls. Coercion happens in `normaliseDelay`.
function setDescriptor(
	name: "setTimeout" | "setInterval",
	schedule: (cb: Callable, delay: unknown) => number,
): GuestFunctionDescription {
	return {
		name,
		args: [Guest.callable(), Guest.raw()],
		result: Guest.number(),
		handler: ((cb: Callable, delay: unknown) =>
			schedule(cb, delay)) as unknown as GuestFunctionDescription["handler"],
		log: { event: "system.call" },
		logInput: timerSetLogInput,
		public: true,
	};
}

// clearTimeout/clearInterval per WHATWG coerce any value to an integer
// handle; `null`, `undefined`, and non-numeric values MUST be no-ops, not
// type errors. Use `Guest.raw()` and coerce host-side.
function clearDescriptor(
	name: "clearTimeout" | "clearInterval",
	cancel: (id: number) => void,
): GuestFunctionDescription {
	return {
		name,
		args: [Guest.raw()],
		result: Guest.void(),
		handler: ((id: unknown) => {
			const n = Number(id);
			if (Number.isFinite(n)) {
				cancel(n);
			}
		}) as unknown as GuestFunctionDescription["handler"],
		log: { event: "system.call" },
		public: true,
	};
}

function timersGuestFunctions(
	registry: TimerRegistry,
): GuestFunctionDescription[] {
	return [
		setDescriptor("setTimeout", registry.scheduleOnce),
		setDescriptor("setInterval", registry.scheduleInterval),
		clearDescriptor("clearTimeout", registry.cancel),
		clearDescriptor("clearInterval", registry.cancel),
	];
}

/**
 * Ports legacy globals.ts setTimeout/setInterval/
 * clearTimeout/clearInterval behaviour onto the plugin architecture.
 *
 * Emission shape per timer callback:
 *   setTimeout(cb, 10) from guest →
 *     system.call   {name:"setTimeout", input:{delay}}                (leaf)
 *     … delay ms later, when the Node timer fires:
 *     system.request  {name:"setTimeout", input:{timerId}}            (open)
 *     (any events emitted inside cb nest under this open)
 *     system.response {name:"setTimeout", output} or
 *     system.error    {name:"setTimeout", error}                      (close)
 *   clearTimeout(id) from guest →
 *     system.call   {name:"clearTimeout", input:{timerId}}            (leaf)
 */
const name = "timers";

function worker(ctx: PluginContext): PluginSetup {
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
