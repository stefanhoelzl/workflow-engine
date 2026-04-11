import type { QuickJSHandle } from "quickjs-emscripten";
import type { ActionContext } from "../context/index.js";
import type { Bridge } from "./bridge-factory.js";

function bridgeCtx(b: Bridge, ctx: ActionContext): void {
	const ctxHandle = b.vm.newObject();

	bridgeEvent(b, ctxHandle, ctx);
	bridgeEnv(b, ctxHandle, ctx);
	bridgeEmit(b, ctxHandle, ctx);
	bridgeFetch(b, ctxHandle, ctx);

	b.vm.setProp(b.vm.global, "ctx", ctxHandle);
	ctxHandle.dispose();
}

function bridgeEvent(
	b: Bridge,
	ctxHandle: QuickJSHandle,
	ctx: ActionContext,
): void {
	const eventJson = JSON.stringify({
		name: ctx.event.type,
		payload: ctx.event.payload,
	});
	const eventResult = b.vm.evalCode(`(${eventJson})`);
	if (eventResult.error) {
		eventResult.error.dispose();
	} else {
		b.vm.setProp(ctxHandle, "event", eventResult.value);
		eventResult.value.dispose();
	}
}

function bridgeEnv(
	b: Bridge,
	ctxHandle: QuickJSHandle,
	ctx: ActionContext,
): void {
	const envJson = JSON.stringify(ctx.env);
	const envResult = b.vm.evalCode(`(${envJson})`);
	if (envResult.error) {
		envResult.error.dispose();
	} else {
		b.vm.setProp(ctxHandle, "env", envResult.value);
		envResult.value.dispose();
	}
}

function bridgeEmit(
	b: Bridge,
	ctxHandle: QuickJSHandle,
	ctx: ActionContext,
): void {
	b.async(ctxHandle, "emit", {
		method: "ctx.emit",
		args: [b.arg.string, b.arg.json],
		marshal: b.marshal.void,
		impl: async (type, payload) => {
			await ctx.emit(type, payload);
		},
	});
}

function bridgeFetch(
	b: Bridge,
	ctxHandle: QuickJSHandle,
	ctx: ActionContext,
): void {
	b.async(ctxHandle, "fetch", {
		method: "ctx.fetch",
		args: [b.arg.string, b.arg.json.optional],
		marshal: (response: Response) => marshalResponse(b, response),
		impl: async (url, init) =>
			await ctx.fetch(url, init as RequestInit | undefined),
	});
}

function marshalResponse(b: Bridge, response: Response): QuickJSHandle {
	const obj = b.vm.newObject();

	const statusHandle = b.vm.newNumber(response.status);
	b.vm.setProp(obj, "status", statusHandle);
	statusHandle.dispose();

	const statusTextHandle = b.vm.newString(response.statusText);
	b.vm.setProp(obj, "statusText", statusTextHandle);
	statusTextHandle.dispose();

	const okHandle = response.ok ? b.vm.true : b.vm.false;
	b.vm.setProp(obj, "ok", okHandle);

	const urlHandle = b.vm.newString(response.url);
	b.vm.setProp(obj, "url", urlHandle);
	urlHandle.dispose();

	marshalHeaders(b, obj, response);

	b.async(obj, "json", {
		args: [],
		marshal: b.marshal.json,
		impl: async () => await response.clone().json(),
	});

	b.async(obj, "text", {
		args: [],
		marshal: b.marshal.string,
		impl: async () => await response.clone().text(),
	});

	return obj;
}

function marshalHeaders(
	b: Bridge,
	responseHandle: QuickJSHandle,
	response: Response,
): void {
	const entries: string[] = [];
	response.headers.forEach((value, key) => {
		entries.push(
			`[${JSON.stringify(key.toLowerCase())},${JSON.stringify(value)}]`,
		);
	});
	const mapCode = `new Map([${entries.join(",")}])`;
	const mapResult = b.vm.evalCode(mapCode);
	if (mapResult.error) {
		mapResult.error.dispose();
	} else {
		b.vm.setProp(responseHandle, "headers", mapResult.value);
		mapResult.value.dispose();
	}
}

export { bridgeCtx };
