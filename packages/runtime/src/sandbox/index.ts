import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSHandle,
} from "quickjs-emscripten";
import type { ActionContext } from "../context/index.js";
import { bridgeCtx } from "./bridge.js";
import { setupGlobals } from "./globals.js";

type SandboxResult =
	| { ok: true }
	| { ok: false; error: { message: string; stack: string } };

interface SpawnOptions {
	signal?: AbortSignal;
	filename?: string;
}

interface Sandbox {
	spawn(
		source: string,
		ctx: ActionContext,
		options?: SpawnOptions,
	): Promise<SandboxResult>;
}

function dumpError(vm: QuickJSContext, handle: QuickJSHandle): SandboxResult {
	const err = vm.dump(handle);
	handle.dispose();
	return {
		ok: false,
		error: {
			message: String(err?.message ?? err),
			stack: String(err?.stack ?? ""),
		},
	};
}

async function createSandbox(): Promise<Sandbox> {
	const module = await getQuickJS();
	return {
		async spawn(source, ctx, options) {
			const runtime = module.newRuntime();
			const vm = runtime.newContext();
			let timerCleanup: ReturnType<typeof setupGlobals> | undefined;
			try {
				timerCleanup = setupGlobals(vm, runtime);
				bridgeCtx(vm, runtime, ctx);

				const handlerSource = source
					.replace(EXPORT_DEFAULT_RE, "")
					.replace(TRAILING_SEMICOLON_RE, "");
				const filename = options?.filename ?? "action.js";

				const fnResult = vm.evalCode(`(${handlerSource})`, filename);
				if (fnResult.error) {
					return dumpError(vm, fnResult.error);
				}

				const ctxHandle = vm.getProp(vm.global, "ctx");
				const callResult = vm.callFunction(
					fnResult.value,
					vm.undefined,
					ctxHandle,
				);
				ctxHandle.dispose();
				fnResult.value.dispose();
				if (callResult.error) {
					return dumpError(vm, callResult.error);
				}

				const resolved = vm.resolvePromise(callResult.value);
				callResult.value.dispose();

				vm.runtime.executePendingJobs();
				const actionResult = await resolved;

				if (actionResult.error) {
					return dumpError(vm, actionResult.error);
				}
				actionResult.value.dispose();
				return { ok: true };
			} finally {
				timerCleanup?.dispose();
				vm.dispose();
				runtime.dispose();
			}
		},
	};
}

const EXPORT_DEFAULT_RE = /export\s+default\s+/;
const TRAILING_SEMICOLON_RE = /;\s*$/;

export type { Sandbox, SandboxResult, SpawnOptions };
export { createSandbox };
