import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSHandle,
} from "quickjs-emscripten";
import { bridgeHostFetch } from "./bridge.js";
import { type Bridge, createBridge, type LogEntry } from "./bridge-factory.js";
import { setupGlobals } from "./globals.js";
import {
	installMethods,
	type MethodMap,
	uninstallGlobals,
} from "./install-host-methods.js";

type RunResult =
	| { ok: true; result: unknown; logs: LogEntry[] }
	| {
			ok: false;
			error: { message: string; stack: string };
			logs: LogEntry[];
	  };

interface SandboxOptions {
	filename?: string;
	fetch?: typeof globalThis.fetch;
}

interface Sandbox {
	run(name: string, ctx: unknown, extraMethods?: MethodMap): Promise<RunResult>;
	dispose(): void;
}

function dumpError(
	vm: QuickJSContext,
	handle: QuickJSHandle,
	logs: readonly LogEntry[],
): RunResult {
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

function collisionName(
	reservedNames: ReadonlySet<string>,
	extraMethods: MethodMap,
): string | undefined {
	for (const key of Object.keys(extraMethods)) {
		if (reservedNames.has(key)) {
			return key;
		}
	}
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled VM lifecycle
async function sandbox(
	source: string,
	methods: MethodMap,
	options?: SandboxOptions,
): Promise<Sandbox> {
	const module = await getQuickJS();
	const runtime = module.newRuntime();
	const vm = runtime.newContext();
	const b: Bridge = createBridge(vm, runtime);
	const timerCleanup = setupGlobals(b);

	const filename = options?.filename ?? "action.js";
	const reservedNames = new Set(Object.keys(methods));
	// Built-in globals the sandbox installs itself — extraMethods must not shadow these either.
	for (const reserved of [
		"console",
		"performance",
		"crypto",
		"setTimeout",
		"clearTimeout",
		"setInterval",
		"clearInterval",
		"__hostFetch",
	]) {
		reservedNames.add(reserved);
	}

	let moduleNamespace: QuickJSHandle | undefined;
	let disposed = false;

	const doDispose = () => {
		if (disposed) {
			return;
		}
		disposed = true;
		moduleNamespace?.dispose();
		timerCleanup.dispose();
		b.dispose();
		vm.dispose();
		runtime.dispose();
	};

	try {
		bridgeHostFetch(b, options?.fetch ?? globalThis.fetch);
		installMethods(b, b.vm.global, methods);

		const moduleResult = vm.evalCode(source, filename, { type: "module" });
		if (moduleResult.error) {
			const failure = dumpError(vm, moduleResult.error, b.logs);
			doDispose();
			const err = new Error(failure.ok ? "unknown" : failure.error.message);
			err.stack = failure.ok ? "" : failure.error.stack;
			throw err;
		}
		moduleNamespace = moduleResult.value;
	} catch (err) {
		doDispose();
		throw err;
	}

	async function run(
		name: string,
		ctx: unknown,
		extraMethods: MethodMap = {},
	): Promise<RunResult> {
		if (disposed) {
			throw new Error("Sandbox is disposed");
		}

		const collision = collisionName(reservedNames, extraMethods);
		if (collision) {
			throw new Error(
				`extraMethods name '${collision}' collides with a reserved global or construction-time method`,
			);
		}

		b.resetLogs();

		const extraNames = Object.keys(extraMethods);
		try {
			installMethods(b, b.vm.global, extraMethods);

			// biome-ignore lint/style/noNonNullAssertion: moduleNamespace is set before run() is callable; disposed-check above blocks post-dispose entry
			const fnHandle = vm.getProp(moduleNamespace!, name);
			const ctxHandle = b.marshal.json(ctx);

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
			const resultValue = vm.dump(actionResult.value);
			actionResult.value.dispose();
			return { ok: true, result: resultValue, logs: [...b.logs] };
		} finally {
			uninstallGlobals(b, extraNames);
		}
	}

	return {
		run,
		dispose: doDispose,
	};
}

export type { LogEntry } from "./bridge-factory.js";
export type { MethodMap } from "./install-host-methods.js";
export type { RunResult, Sandbox, SandboxOptions };
export { sandbox };
