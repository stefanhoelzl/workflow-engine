import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSHandle,
} from "quickjs-emscripten";
import type { ActionContext } from "../context/index.js";
import { type LogEntry, createBridge } from "./bridge-factory.js";
import { bridgeCtx } from "./bridge.js";
import { setupGlobals } from "./globals.js";

type SandboxResult =
	| { ok: true; logs: LogEntry[] }
	| { ok: false; error: { message: string; stack: string }; logs: LogEntry[] };

interface SpawnOptions {
	signal?: AbortSignal;
	filename?: string;
	exportName?: string;
}

interface Sandbox {
	spawn(
		source: string,
		ctx: ActionContext,
		options?: SpawnOptions,
	): Promise<SandboxResult>;
}

function dumpError(
	vm: QuickJSContext,
	handle: QuickJSHandle,
	logs: readonly LogEntry[],
): SandboxResult {
	const err = vm.dump(handle);
	handle.dispose();
	return {
		ok: false,
		error: {
			message: String(err?.message ?? err),
			stack: String(err?.stack ?? ""),
		},
		logs: [...logs],
	};
}

async function createSandbox(): Promise<Sandbox> {
	const module = await getQuickJS();
	return {
		async spawn(source, ctx, options) {
			const runtime = module.newRuntime();
			const vm = runtime.newContext();
			const b = createBridge(vm, runtime);
			let timerCleanup: ReturnType<typeof setupGlobals> | undefined;
			try {
				timerCleanup = setupGlobals(b);
				bridgeCtx(b, ctx);

				const filename = options?.filename ?? "action.js";
				const exportName = options?.exportName ?? "default";

				const moduleResult = vm.evalCode(source, filename, {
					type: "module",
				});
				if (moduleResult.error) {
					return dumpError(vm, moduleResult.error, b.logs);
				}
				const fnHandle = vm.getProp(moduleResult.value, exportName);
				moduleResult.value.dispose();

				const ctxHandle = vm.getProp(vm.global, "ctx");
				const callResult = vm.callFunction(fnHandle, vm.undefined, ctxHandle);
				ctxHandle.dispose();
				fnHandle.dispose();
				if (callResult.error) {
					return dumpError(vm, callResult.error, b.logs);
				}

				const resolved = vm.resolvePromise(callResult.value);
				callResult.value.dispose();

				vm.runtime.executePendingJobs();
				const actionResult = await resolved;

				if (actionResult.error) {
					return dumpError(vm, actionResult.error, b.logs);
				}
				actionResult.value.dispose();
				return { ok: true, logs: [...b.logs] };
			} finally {
				timerCleanup?.dispose();
				b.dispose();
				vm.dispose();
				runtime.dispose();
			}
		},
	};
}

export type { LogEntry } from "./bridge-factory.js";
export type { Sandbox, SandboxResult, SpawnOptions };
export { createSandbox };
