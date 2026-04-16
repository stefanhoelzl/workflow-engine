import type { QuickJSHandle } from "quickjs-emscripten";
import type { Bridge } from "./bridge-factory.js";
import { setupCrypto } from "./crypto.js";

interface TimerCleanup {
	dispose(): void;
	clearActive(): void;
}

function setupGlobals(b: Bridge): TimerCleanup {
	setupConsole(b);
	setupCrypto(b);
	setupPerformance(b);
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

function setupPerformance(b: Bridge): void {
	const origin = performance.now();
	const perfObj = b.vm.newObject();
	b.sync(perfObj, "now", {
		method: "performance.now",
		args: [],
		marshal: b.marshal.number,
		impl: () => performance.now() - origin,
	});
	b.vm.setProp(b.vm.global, "performance", perfObj);
	perfObj.dispose();
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: registering all timer globals together is clearer than splitting
function setupTimers(b: Bridge): TimerCleanup {
	const pendingCallbacks = new Map<number, QuickJSHandle>();

	// Timers are direct vm.newFunction installs (not bridge.sync) because they
	// take a guest callback handle and must dup/call it; the bridge wrappers
	// can't represent that argument shape. They emit no events for now — guest
	// timer use is rare and the cost of full request/response wrapping
	// outweighs the value. Method-name tracking in the event stream would
	// require restructuring how vm.newFunction interacts with bridge state.

	const setTimeoutFn = b.vm.newFunction(
		"setTimeout",
		(callbackHandle, delayHandle) => {
			const delay = b.vm.getNumber(delayHandle);
			const cb = callbackHandle.dup();

			const id = setTimeout(() => {
				pendingCallbacks.delete(id as unknown as number);
				b.vm.callFunction(cb, b.vm.undefined);
				cb.dispose();
				b.runtime.executePendingJobs();
			}, delay);

			const numId = id as unknown as number;
			pendingCallbacks.set(numId, cb);
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setTimeout", setTimeoutFn);
	setTimeoutFn.dispose();

	const clearTimeoutFn = b.vm.newFunction("clearTimeout", (idHandle) => {
		const id = b.vm.getNumber(idHandle);
		clearTimeout(id);
		const cb = pendingCallbacks.get(id);
		if (cb) {
			cb.dispose();
			pendingCallbacks.delete(id);
		}
	});
	b.vm.setProp(b.vm.global, "clearTimeout", clearTimeoutFn);
	clearTimeoutFn.dispose();

	const setIntervalFn = b.vm.newFunction(
		"setInterval",
		(callbackHandle, delayHandle) => {
			const delay = b.vm.getNumber(delayHandle);
			const cb = callbackHandle.dup();

			const id = setInterval(() => {
				b.vm.callFunction(cb, b.vm.undefined);
				b.runtime.executePendingJobs();
			}, delay);

			const numId = id as unknown as number;
			pendingCallbacks.set(numId, cb);
			return b.vm.newNumber(numId);
		},
	);
	b.vm.setProp(b.vm.global, "setInterval", setIntervalFn);
	setIntervalFn.dispose();

	const clearIntervalFn = b.vm.newFunction("clearInterval", (idHandle) => {
		const id = b.vm.getNumber(idHandle);
		clearInterval(id);
		const cb = pendingCallbacks.get(id);
		if (cb) {
			cb.dispose();
			pendingCallbacks.delete(id);
		}
	});
	b.vm.setProp(b.vm.global, "clearInterval", clearIntervalFn);
	clearIntervalFn.dispose();

	function clearActive(): void {
		for (const [id, cb] of pendingCallbacks) {
			clearTimeout(id);
			clearInterval(id);
			cb.dispose();
		}
		pendingCallbacks.clear();
	}

	return {
		dispose: clearActive,
		clearActive,
	};
}

export type { TimerCleanup };
export { setupGlobals };
