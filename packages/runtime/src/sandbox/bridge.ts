import type { QuickJSHandle } from "quickjs-emscripten";
import type { ActionContext } from "../context/index.js";
import type { Bridge } from "./bridge-factory.js";

function bridgeCtx(b: Bridge, ctx: ActionContext): void {
	const ctxHandle = b.vm.newObject();

	bridgeEvent(b, ctxHandle, ctx);
	bridgeEnv(b, ctxHandle, ctx);
	bridgeEmit(b, ctxHandle, ctx);

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

function bridgeHostFetch(b: Bridge, fetchFn: typeof globalThis.fetch): void {
	b.async(b.vm.global, "__hostFetch", {
		method: "xhr.send",
		args: [b.arg.string, b.arg.string, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (method, url, headers, body) => {
			const response = await fetchFn(url, {
				method,
				headers: headers as Record<string, string>,
				body: body as string | null,
			});
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});
			return {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body: await response.text(),
			};
		},
	});
}

export { bridgeCtx, bridgeHostFetch };
