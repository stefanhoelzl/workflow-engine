import type { JSValueHandle } from "quickjs-wasi";
import type { Bridge } from "./bridge-factory.js";

interface TimerCleanup {
	dispose(): void;
	clearActive(): void;
}

type TimerName = "setTimeout" | "setInterval";
type ClearName = "clearTimeout" | "clearInterval";

interface PendingTimer {
	cb: JSValueHandle;
	name: TimerName;
}

// HTML spec: timeout is a WebIDL `long` (ToInt32), then clamped to 0 if
// negative. Without this, host Node prints TimeoutNaN/Negative/Overflow
// warnings when guests pass NaN, <0, or >=2^31.
const INT32_MAX = 2_147_483_647;
function normalizeDelay(raw: number): number {
	if (!Number.isFinite(raw) || raw < 0 || raw > INT32_MAX) {
		return 0;
	}
	return Math.trunc(raw);
}

function setupGlobals(b: Bridge): TimerCleanup {
	setupConsole(b);
	return setupTimers(b);
}

function setupConsole(b: Bridge): void {
	const consoleObj = b.vm.newObject();
	for (const name of ["log", "info", "warn", "error", "debug"] as const) {
		b.sync(consoleObj, name, {
			method: `console.${name}`,
			args: [b.arg.json.rest],
			marshal: b.marshal.void,
			impl: () => {
				/* no-op: auto-log captures method + args */
			},
		});
	}
	b.vm.setProp(b.vm.global, "console", consoleObj);
	consoleObj.dispose();
}

// Timers bypass the bridge's b.sync / b.async wrappers because those cannot
// represent a callback-handle argument; instead they emit events manually via
// b.buildEvent / b.emit / b.pushRef / b.popRef. See the sandbox capability's
// "Timer event kinds" and "Safe globals — timers" requirements for the
// emission contract.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: registering all timer globals together is clearer than splitting
function setupTimers(b: Bridge): TimerCleanup {
	const pendingCallbacks = new Map<number, PendingTimer>();

	function emitEvent(
		kind:
			| "timer.set"
			| "timer.request"
			| "timer.response"
			| "timer.error"
			| "timer.clear",
		ref: number | null,
		name: TimerName | ClearName,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): number {
		const seq = b.nextSeq();
		const evt = b.buildEvent(kind, seq, ref, name, extra);
		if (evt) {
			b.emit(evt);
		}
		return seq;
	}

	function dumpSafe(handle: JSValueHandle): unknown {
		try {
			return b.vm.dump(handle);
		} catch {
			return;
		}
	}

	function runCallback(
		cb: JSValueHandle,
		numId: number,
		name: TimerName,
	): void {
		const reqSeq = emitEvent("timer.request", null, name, {
			input: { timerId: numId },
		});
		b.pushRef(reqSeq);
		try {
			const ret = b.vm.callFunction(cb, b.vm.undefined);
			const output = dumpSafe(ret);
			ret.dispose();
			emitEvent("timer.response", reqSeq, name, {
				input: { timerId: numId },
				...(output === undefined ? {} : { output }),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? (err.stack ?? "") : "";
			emitEvent("timer.error", reqSeq, name, {
				input: { timerId: numId },
				error: { message, stack },
			});
		} finally {
			b.popRef();
			b.vm.executePendingJobs();
		}
	}

	const setTimeoutFn = b.vm.newFunction(
		"setTimeout",
		(callbackHandle, delayHandle) => {
			const delay = normalizeDelay(delayHandle.toNumber());
			const cb = callbackHandle.dup();

			const id = setTimeout(() => {
				runCallback(cb, numId, "setTimeout");
				pendingCallbacks.delete(numId);
				cb.dispose();
			}, delay);

			const numId = Number(id);
			emitEvent("timer.set", b.currentRef(), "setTimeout", {
				input: { delay, timerId: numId },
			});
			pendingCallbacks.set(numId, { cb, name: "setTimeout" });
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setTimeout", setTimeoutFn);
	setTimeoutFn.dispose();

	const clearTimeoutFn = b.vm.newFunction("clearTimeout", (idHandle) => {
		const id = idHandle.toNumber();
		const entry = pendingCallbacks.get(id);
		if (entry) {
			emitEvent("timer.clear", b.currentRef(), "clearTimeout", {
				input: { timerId: id },
			});
			clearTimeout(id);
			entry.cb.dispose();
			pendingCallbacks.delete(id);
		}
		return b.vm.undefined;
	});
	b.vm.setProp(b.vm.global, "clearTimeout", clearTimeoutFn);
	clearTimeoutFn.dispose();

	const setIntervalFn = b.vm.newFunction(
		"setInterval",
		(callbackHandle, delayHandle) => {
			const delay = normalizeDelay(delayHandle.toNumber());
			const cb = callbackHandle.dup();

			const id = setInterval(() => {
				runCallback(cb, numId, "setInterval");
			}, delay);

			const numId = Number(id);
			emitEvent("timer.set", b.currentRef(), "setInterval", {
				input: { delay, timerId: numId },
			});
			pendingCallbacks.set(numId, { cb, name: "setInterval" });
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setInterval", setIntervalFn);
	setIntervalFn.dispose();

	const clearIntervalFn = b.vm.newFunction("clearInterval", (idHandle) => {
		const id = idHandle.toNumber();
		const entry = pendingCallbacks.get(id);
		if (entry) {
			emitEvent("timer.clear", b.currentRef(), "clearInterval", {
				input: { timerId: id },
			});
			clearInterval(id);
			entry.cb.dispose();
			pendingCallbacks.delete(id);
		}
		return b.vm.undefined;
	});
	b.vm.setProp(b.vm.global, "clearInterval", clearIntervalFn);
	clearIntervalFn.dispose();

	function clearActive(): void {
		for (const [id, entry] of pendingCallbacks) {
			const clearName: ClearName =
				entry.name === "setTimeout" ? "clearTimeout" : "clearInterval";
			emitEvent("timer.clear", null, clearName, {
				input: { timerId: id },
			});
			clearTimeout(id);
			clearInterval(id);
			entry.cb.dispose();
		}
		pendingCallbacks.clear();
	}

	return {
		dispose: clearActive,
		clearActive,
	};
}

// JS shim that wraps crypto.subtle methods so they return Promises, matching
// the standard WebCrypto spec. The WASM crypto extension returns synchronously
// — this shim runs inside the VM to wrap each method.
const CRYPTO_PROMISE_SHIM = `(function() {
  var _subtle = crypto.subtle;
  var _methods = ['digest','importKey','exportKey','sign','verify','encrypt','decrypt','generateKey','deriveBits','deriveKey','wrapKey','unwrapKey'];
  for (var i = 0; i < _methods.length; i++) {
    var m = _methods[i];
    var orig = _subtle[m].bind(_subtle);
    _subtle[m] = (function(fn) {
      return function() {
        try { return Promise.resolve(fn.apply(null, arguments)); }
        catch (e) { return Promise.reject(e); }
      };
    })(orig);
  }
})();`;

export type { TimerCleanup };
export { CRYPTO_PROMISE_SHIM, setupGlobals };
