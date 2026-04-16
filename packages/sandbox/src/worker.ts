import { parentPort } from "node:worker_threads";
import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten";
import { bridgeHostFetch } from "./bridge.js";
import { type Bridge, createBridge, type LogEntry } from "./bridge-factory.js";
import { setupGlobals, type TimerCleanup } from "./globals.js";
import { installRpcMethods, uninstallGlobals } from "./install-host-methods.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";

if (!parentPort) {
	throw new Error("worker.ts must be loaded as a worker_threads Worker");
}
const port = parentPort;

function post(msg: WorkerToMain): void {
	port.postMessage(msg);
}

function serializeError(err: unknown): SerializedError {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			stack: err.stack ?? "",
		};
	}
	const msg = String(err);
	return { name: "Error", message: msg, stack: "" };
}

function dumpVmError(
	vm: QuickJSContext,
	handle: QuickJSHandle,
): SerializedError {
	const err = vm.dump(handle);
	handle.dispose();
	return {
		name: String(err?.name ?? "Error"),
		message: String(err?.message ?? err),
		stack: String(err?.stack ?? ""),
	};
}

// --- RPC request/response state ---

let nextRequestId = 1;
const pendingRequests = new Map<
	number,
	{ resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

function sendRequest(method: string, args: unknown[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const requestId = nextRequestId++;
		pendingRequests.set(requestId, { resolve, reject });
		post({ type: "request", requestId, method, args });
	});
}

function handleResponse(
	requestId: number,
	ok: boolean,
	result?: unknown,
	error?: SerializedError,
): void {
	const pending = pendingRequests.get(requestId);
	if (!pending) {
		return;
	}
	pendingRequests.delete(requestId);
	if (ok) {
		pending.resolve(result);
	} else {
		const err = new Error(error?.message ?? "unknown RPC error");
		err.name = error?.name ?? "Error";
		err.stack = error?.stack ?? "";
		if (error?.issues !== undefined) {
			(err as Error & { issues?: unknown }).issues = error.issues;
		}
		if (error?.data) {
			for (const [key, value] of Object.entries(error.data)) {
				(err as unknown as Record<string, unknown>)[key] = value;
			}
		}
		pending.reject(err);
	}
}

// --- Sandbox state (lives for the life of this worker) ---

interface SandboxState {
	vm: QuickJSContext;
	runtime: QuickJSRuntime;
	bridge: Bridge;
	timers: TimerCleanup;
	moduleNamespace: QuickJSHandle;
	constructionMethodNames: string[];
	currentAbort: AbortController | null;
}

let state: SandboxState | null = null;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: init sets up VM, bridge, timers, fetch forwarding, and source eval as an atomic sequence
async function handleInit(
	msg: Extract<MainToWorker, { type: "init" }>,
): Promise<void> {
	const module = await getQuickJS();
	const runtime = module.newRuntime();
	const vm = runtime.newContext();
	const bridge = createBridge(vm, runtime);
	const timers = setupGlobals(bridge);

	// Fetch uses a signal provider that reads the current run's AbortController.
	// When the main side requests forwarding (options.fetch set), the bridge
	// implementation round-trips via sendRequest instead of calling the
	// worker's native fetch.
	const fetchImpl: typeof globalThis.fetch = msg.forwardFetch
		? ((async (input, init) => {
				const url = typeof input === "string" ? input : String(input);
				const method = init?.method ?? "GET";
				const headers =
					init?.headers && typeof init.headers === "object"
						? Object.fromEntries(
								Object.entries(init.headers as Record<string, string>),
							)
						: {};
				const body = init?.body ?? null;
				const response = (await sendRequest("__hostFetchForward", [
					method,
					url,
					headers,
					body,
				])) as {
					status: number;
					statusText: string;
					headers: Record<string, string>;
					body: string;
				};
				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}) as typeof globalThis.fetch)
		: globalThis.fetch;
	bridgeHostFetch(bridge, fetchImpl, () => state?.currentAbort?.signal);

	// Construction-time methods are installed as RPC proxies.
	installRpcMethods(bridge, bridge.vm.global, msg.methodNames, sendRequest);

	const evalResult = vm.evalCode(msg.source, msg.filename, { type: "module" });
	if (evalResult.error) {
		const err = dumpVmError(vm, evalResult.error);
		timers.dispose();
		bridge.dispose();
		vm.dispose();
		runtime.dispose();
		post({ type: "init-error", error: err });
		// Drain pending jobs then exit so the main side's `worker.on("exit")`
		// fires deterministically.
		process.exit(0);
	}

	state = {
		vm,
		runtime,
		bridge,
		timers,
		moduleNamespace: evalResult.value,
		constructionMethodNames: [...msg.methodNames],
		currentAbort: null,
	};

	post({ type: "ready" });
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run orchestrates install/invoke/cleanup as one unit
async function handleRun(
	msg: Extract<MainToWorker, { type: "run" }>,
): Promise<void> {
	if (!state) {
		post({
			type: "done",
			payload: {
				ok: false,
				error: { message: "sandbox not initialized", stack: "" },
				logs: [],
			},
		});
		return;
	}
	const { vm, bridge, timers, moduleNamespace } = state;

	bridge.resetLogs();
	state.currentAbort = new AbortController();
	const extraNames = msg.extraNames;
	installRpcMethods(bridge, bridge.vm.global, extraNames, sendRequest);

	let payload: RunResultPayload;
	try {
		const fnHandle = vm.getProp(moduleNamespace, msg.exportName);
		const ctxHandle = bridge.marshal.json(msg.ctx);

		const callResult = vm.callFunction(fnHandle, vm.undefined, ctxHandle);
		ctxHandle.dispose();
		fnHandle.dispose();

		if (callResult.error) {
			const err = dumpVmError(vm, callResult.error);
			payload = {
				ok: false,
				error: { message: err.message, stack: err.stack },
				logs: [...bridge.logs],
			};
		} else {
			const resolved = vm.resolvePromise(callResult.value);
			callResult.value.dispose();
			vm.runtime.executePendingJobs();
			const actionResult = await resolved;
			if (actionResult.error) {
				const err = dumpVmError(vm, actionResult.error);
				payload = {
					ok: false,
					error: { message: err.message, stack: err.stack },
					logs: [...bridge.logs],
				};
			} else {
				const resultValue = vm.dump(actionResult.value);
				actionResult.value.dispose();
				payload = {
					ok: true,
					result: resultValue,
					logs: [...bridge.logs],
				};
			}
		}
	} catch (err) {
		const e = serializeError(err);
		payload = {
			ok: false,
			error: { message: e.message, stack: e.stack },
			logs: [...bridge.logs],
		};
	} finally {
		// Cancel any pending background work this run started.
		timers.clearActive();
		state.currentAbort?.abort();
		state.currentAbort = null;
		uninstallGlobals(bridge, extraNames);
	}

	post({ type: "done", payload });
}

function drainExtractedLogs(bridge: Bridge): LogEntry[] {
	return [...bridge.logs];
}

port.on("message", (msg: MainToWorker) => {
	(async () => {
		try {
			if (msg.type === "init") {
				await handleInit(msg);
			} else if (msg.type === "run") {
				await handleRun(msg);
			} else if (msg.type === "response") {
				if (msg.ok) {
					handleResponse(msg.requestId, true, msg.result);
				} else {
					handleResponse(msg.requestId, false, undefined, msg.error);
				}
			}
		} catch (err) {
			// Uncaught worker error — surface to main via worker.on("error") by
			// re-throwing synchronously from a microtask.
			queueMicrotask(() => {
				throw err;
			});
		}
	})();
});

export { drainExtractedLogs };
