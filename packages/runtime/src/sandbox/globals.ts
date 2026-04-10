import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
} from "quickjs-emscripten";

interface TimerCleanup {
	dispose(): void;
}

function setupGlobals(
	vm: QuickJSContext,
	runtime: QuickJSRuntime,
): TimerCleanup {
	setupBtoaAtob(vm);
	return setupTimers(vm, runtime);
}

function setupBtoaAtob(vm: QuickJSContext): void {
	const btoaFn = vm.newFunction("btoa", (strHandle) => {
		const str = vm.getString(strHandle);
		return vm.newString(btoa(str));
	});
	vm.setProp(vm.global, "btoa", btoaFn);
	btoaFn.dispose();

	const atobFn = vm.newFunction("atob", (strHandle) => {
		const str = vm.getString(strHandle);
		return vm.newString(atob(str));
	});
	vm.setProp(vm.global, "atob", atobFn);
	atobFn.dispose();
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: registering all timer globals together is clearer than splitting
function setupTimers(
	vm: QuickJSContext,
	runtime: QuickJSRuntime,
): TimerCleanup {
	const pendingCallbacks = new Map<number, QuickJSHandle>();

	const setTimeoutFn = vm.newFunction(
		"setTimeout",
		(callbackHandle, delayHandle) => {
			const delay = vm.getNumber(delayHandle);
			const cb = callbackHandle.dup();

			const id = setTimeout(() => {
				pendingCallbacks.delete(id as unknown as number);
				vm.callFunction(cb, vm.undefined);
				cb.dispose();
				runtime.executePendingJobs();
			}, delay);

			const numId = id as unknown as number;
			pendingCallbacks.set(numId, cb);
			return vm.newNumber(numId);
		},
	);
	vm.setProp(vm.global, "setTimeout", setTimeoutFn);
	setTimeoutFn.dispose();

	const clearTimeoutFn = vm.newFunction("clearTimeout", (idHandle) => {
		const id = vm.getNumber(idHandle);
		clearTimeout(id);
		const cb = pendingCallbacks.get(id);
		if (cb) {
			cb.dispose();
			pendingCallbacks.delete(id);
		}
	});
	vm.setProp(vm.global, "clearTimeout", clearTimeoutFn);
	clearTimeoutFn.dispose();

	const setIntervalFn = vm.newFunction(
		"setInterval",
		(callbackHandle, delayHandle) => {
			const delay = vm.getNumber(delayHandle);
			const cb = callbackHandle.dup();

			const id = setInterval(() => {
				vm.callFunction(cb, vm.undefined);
				runtime.executePendingJobs();
			}, delay);

			const numId = id as unknown as number;
			pendingCallbacks.set(numId, cb);
			return vm.newNumber(numId);
		},
	);
	vm.setProp(vm.global, "setInterval", setIntervalFn);
	setIntervalFn.dispose();

	const clearIntervalFn = vm.newFunction("clearInterval", (idHandle) => {
		const id = vm.getNumber(idHandle);
		clearInterval(id);
		const cb = pendingCallbacks.get(id);
		if (cb) {
			cb.dispose();
			pendingCallbacks.delete(id);
		}
	});
	vm.setProp(vm.global, "clearInterval", clearIntervalFn);
	clearIntervalFn.dispose();

	return {
		dispose() {
			for (const [id, cb] of pendingCallbacks) {
				clearTimeout(id);
				clearInterval(id);
				cb.dispose();
			}
			pendingCallbacks.clear();
		},
	};
}

export { setupGlobals };
