import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from "quickjs-emscripten";
import type { ActionContext } from "../context/index.js";

function bridgeCtx(vm: QuickJSContext, runtime: QuickJSRuntime, ctx: ActionContext): void {
	const ctxHandle = vm.newObject();

	bridgeEvent(vm, ctxHandle, ctx);
	bridgeEnv(vm, ctxHandle, ctx);
	bridgeEmit(vm, runtime, ctxHandle, ctx);
	bridgeFetch(vm, runtime, ctxHandle, ctx);

	vm.setProp(vm.global, "ctx", ctxHandle);
	ctxHandle.dispose();
}

function bridgeEvent(vm: QuickJSContext, ctxHandle: QuickJSHandle, ctx: ActionContext): void {
	const eventJson = JSON.stringify({
		name: ctx.event.type,
		payload: ctx.event.payload,
	});
	const eventResult = vm.evalCode(`(${eventJson})`);
	if (eventResult.error) {
		eventResult.error.dispose();
	} else {
		vm.setProp(ctxHandle, "event", eventResult.value);
		eventResult.value.dispose();
	}
}

function bridgeEnv(vm: QuickJSContext, ctxHandle: QuickJSHandle, ctx: ActionContext): void {
	const envJson = JSON.stringify(ctx.env);
	const envResult = vm.evalCode(`(${envJson})`);
	if (envResult.error) {
		envResult.error.dispose();
	} else {
		vm.setProp(ctxHandle, "env", envResult.value);
		envResult.value.dispose();
	}
}

function bridgeEmit(vm: QuickJSContext, runtime: QuickJSRuntime, ctxHandle: QuickJSHandle, ctx: ActionContext): void {
	const emitFn = vm.newFunction("emit", (typeHandle, payloadHandle) => {
		const type = vm.getString(typeHandle);
		const payload = vm.dump(payloadHandle);

		const deferred = vm.newPromise();

		ctx.emit(type, payload).then(
			() => {
				deferred.resolve(vm.undefined);
				runtime.executePendingJobs();
			},
			(err) => {
				const errObj = vm.newError(err instanceof Error ? err.message : String(err));
				deferred.reject(errObj);
				errObj.dispose();
				runtime.executePendingJobs();
			},
		);

		return deferred.handle;
	});
	vm.setProp(ctxHandle, "emit", emitFn);
	emitFn.dispose();
}

function bridgeFetch(vm: QuickJSContext, runtime: QuickJSRuntime, ctxHandle: QuickJSHandle, ctx: ActionContext): void {
	const fetchFn = vm.newFunction("fetch", (urlHandle, initHandle) => {
		const url = vm.getString(urlHandle);
		const init = initHandle ? vm.dump(initHandle) : undefined;

		const deferred = vm.newPromise();

		ctx.fetch(url, init).then(
			(response) => {
				const responseHandle = marshalResponse(vm, runtime, response);
				deferred.resolve(responseHandle);
				responseHandle.dispose();
				runtime.executePendingJobs();
			},
			(err) => {
				const errObj = vm.newError(err instanceof Error ? err.message : String(err));
				deferred.reject(errObj);
				errObj.dispose();
				runtime.executePendingJobs();
			},
		);

		return deferred.handle;
	});
	vm.setProp(ctxHandle, "fetch", fetchFn);
	fetchFn.dispose();
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: assembling a multi-faceted Response proxy in one place is clearer than splitting
function marshalResponse(vm: QuickJSContext, runtime: QuickJSRuntime, response: Response): QuickJSHandle {
	const obj = vm.newObject();

	// Properties
	const statusHandle = vm.newNumber(response.status);
	vm.setProp(obj, "status", statusHandle);
	statusHandle.dispose();

	const statusTextHandle = vm.newString(response.statusText);
	vm.setProp(obj, "statusText", statusTextHandle);
	statusTextHandle.dispose();

	const okHandle = response.ok ? vm.true : vm.false;
	vm.setProp(obj, "ok", okHandle);

	const urlHandle = vm.newString(response.url);
	vm.setProp(obj, "url", urlHandle);
	urlHandle.dispose();

	// Headers as Map
	marshalHeaders(vm, obj, response);

	// json() method
	const jsonFn = vm.newFunction("json", () => {
		const deferred = vm.newPromise();

		response
			.clone()
			.json()
			.then(
				(data) => {
					const jsonStr = JSON.stringify(data);
					const result = vm.evalCode(`(${jsonStr})`);
					if (result.error) {
						deferred.reject(result.error);
						result.error.dispose();
					} else {
						deferred.resolve(result.value);
						result.value.dispose();
					}
					runtime.executePendingJobs();
				},
				(err) => {
					const errObj = vm.newError(err instanceof Error ? err.message : String(err));
					deferred.reject(errObj);
					errObj.dispose();
					runtime.executePendingJobs();
				},
			);

		return deferred.handle;
	});
	vm.setProp(obj, "json", jsonFn);
	jsonFn.dispose();

	// text() method
	const textFn = vm.newFunction("text", () => {
		const deferred = vm.newPromise();

		response
			.clone()
			.text()
			.then(
				(text) => {
					const textHandle = vm.newString(text);
					deferred.resolve(textHandle);
					textHandle.dispose();
					runtime.executePendingJobs();
				},
				(err) => {
					const errObj = vm.newError(err instanceof Error ? err.message : String(err));
					deferred.reject(errObj);
					errObj.dispose();
					runtime.executePendingJobs();
				},
			);

		return deferred.handle;
	});
	vm.setProp(obj, "text", textFn);
	textFn.dispose();

	return obj;
}

function marshalHeaders(vm: QuickJSContext, responseHandle: QuickJSHandle, response: Response): void {
	// Build a Map from headers, with lowercase keys
	const entries: string[] = [];
	response.headers.forEach((value, key) => {
		entries.push(`[${JSON.stringify(key.toLowerCase())},${JSON.stringify(value)}]`);
	});
	const mapCode = `new Map([${entries.join(",")}])`;
	const mapResult = vm.evalCode(mapCode);
	if (mapResult.error) {
		mapResult.error.dispose();
	} else {
		vm.setProp(responseHandle, "headers", mapResult.value);
		mapResult.value.dispose();
	}
}

export { bridgeCtx };
