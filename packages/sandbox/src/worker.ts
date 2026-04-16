import { parentPort } from "node:worker_threads";
import type { EventKind, InvocationEvent } from "@workflow-engine/core";
import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten";
import { bridgeHostFetch } from "./bridge.js";
import { type Bridge, createBridge } from "./bridge-factory.js";
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

// --- __emitEvent guest global ---
//
// Installed once per sandbox via vm.newFunction (NOT via bridge.sync/async).
// Accepts only `action.*` event kinds. Stamps id/seq/ref/ts/workflow/workflowSha
// from the bridge's current run context and posts the event to the main thread.
// Does NOT generate system events for itself.

const ALLOWED_EMIT_KINDS = new Set<EventKind>([
	"action.request",
	"action.response",
	"action.error",
]);

function installEmitEvent(bridge: Bridge): void {
	const fn = bridge.vm.newFunction("__emitEvent", (eventHandle) => {
		const raw = bridge.vm.dump(eventHandle) as {
			kind?: string;
			name?: string;
			input?: unknown;
			output?: unknown;
			error?: unknown;
		};
		const ctx = bridge.getRunContext();
		if (!ctx) {
			return bridge.vm.undefined;
		}
		const kind = raw?.kind as EventKind | undefined;
		if (!(kind && ALLOWED_EMIT_KINDS.has(kind))) {
			return {
				error: bridge.vm.newError({
					name: "TypeError",
					message: `__emitEvent: invalid kind '${String(raw?.kind)}' (only action.* allowed)`,
				}),
			};
		}
		const name = String(raw?.name ?? "");
		const seqValue = bridge.nextSeq();

		let ref: number | null;
		if (kind === "action.request") {
			ref = bridge.currentRef();
			bridge.pushRef(seqValue);
		} else {
			ref = bridge.popRef();
		}

		const event: InvocationEvent = {
			kind,
			id: ctx.invocationId,
			seq: seqValue,
			ref,
			ts: Date.now(),
			workflow: ctx.workflow,
			workflowSha: ctx.workflowSha,
			name,
			...(raw.input === undefined ? {} : { input: raw.input }),
			...(raw.output === undefined ? {} : { output: raw.output }),
			...(raw.error === undefined
				? {}
				: {
						error: raw.error as {
							message: string;
							stack: string;
							issues?: unknown;
						},
					}),
		};
		bridge.emit(event);
		return bridge.vm.undefined;
	});
	bridge.vm.setProp(bridge.vm.global, "__emitEvent", fn);
	fn.dispose();
}

// --- Sandbox state (lives for the life of this worker) ---

interface SandboxState {
	vm: QuickJSContext;
	runtime: QuickJSRuntime;
	bridge: Bridge;
	timers: TimerCleanup;
	moduleNamespace: QuickJSHandle;
	constructionMethodNames: string[];
	constructionMethodEventNames: Record<string, string>;
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
	bridge.setSink((event) => post({ type: "event", event }));
	const timers = setupGlobals(bridge);

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

	installEmitEvent(bridge);

	installRpcMethods(
		bridge,
		bridge.vm.global,
		msg.methodNames,
		sendRequest,
		msg.methodEventNames,
	);

	const evalResult = vm.evalCode(msg.source, msg.filename, { type: "module" });
	if (evalResult.error) {
		const err = dumpVmError(vm, evalResult.error);
		timers.dispose();
		bridge.dispose();
		vm.dispose();
		runtime.dispose();
		post({ type: "init-error", error: err });
		process.exit(0);
	}

	state = {
		vm,
		runtime,
		bridge,
		timers,
		moduleNamespace: evalResult.value,
		constructionMethodNames: [...msg.methodNames],
		constructionMethodEventNames: { ...(msg.methodEventNames ?? {}) },
		currentAbort: null,
	};

	post({ type: "ready" });
}

function emitTriggerEvent(
	bridge: Bridge,
	kind: EventKind,
	name: string,
	extra: { input?: unknown; output?: unknown; error?: unknown },
): number {
	const ctx = bridge.getRunContext();
	if (!ctx) {
		return -1;
	}
	const seqValue = bridge.nextSeq();
	let ref: number | null;
	if (kind === "trigger.request") {
		ref = null;
		bridge.pushRef(seqValue);
	} else {
		ref = bridge.popRef();
	}
	const event: InvocationEvent = {
		kind,
		id: ctx.invocationId,
		seq: seqValue,
		ref,
		ts: Date.now(),
		workflow: ctx.workflow,
		workflowSha: ctx.workflowSha,
		name,
		...(extra.input === undefined ? {} : { input: extra.input }),
		...(extra.output === undefined ? {} : { output: extra.output }),
		...(extra.error === undefined
			? {}
			: {
					error: extra.error as {
						message: string;
						stack: string;
						issues?: unknown;
					},
				}),
	};
	bridge.emit(event);
	return seqValue;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run orchestrates context setup, install/invoke/cleanup, and trigger event emission as one unit
async function handleRun(
	msg: Extract<MainToWorker, { type: "run" }>,
): Promise<void> {
	if (!state) {
		post({
			type: "done",
			payload: {
				ok: false,
				error: { message: "sandbox not initialized", stack: "" },
			},
		});
		return;
	}
	const { vm, bridge, timers, moduleNamespace } = state;

	bridge.setRunContext({
		invocationId: msg.invocationId,
		workflow: msg.workflow,
		workflowSha: msg.workflowSha,
	});
	state.currentAbort = new AbortController();
	const extraNames = msg.extraNames;
	installRpcMethods(bridge, bridge.vm.global, extraNames, sendRequest);

	emitTriggerEvent(bridge, "trigger.request", msg.exportName, {
		input: msg.ctx,
	});

	let payload: RunResultPayload;
	try {
		const fnHandle = vm.getProp(moduleNamespace, msg.exportName);
		const ctxHandle = bridge.marshal.json(msg.ctx);

		const callResult = vm.callFunction(fnHandle, vm.undefined, ctxHandle);
		ctxHandle.dispose();
		fnHandle.dispose();

		if (callResult.error) {
			const err = dumpVmError(vm, callResult.error);
			emitTriggerEvent(bridge, "trigger.error", msg.exportName, {
				error: { message: err.message, stack: err.stack },
			});
			payload = {
				ok: false,
				error: { message: err.message, stack: err.stack },
			};
		} else {
			const resolved = vm.resolvePromise(callResult.value);
			callResult.value.dispose();
			vm.runtime.executePendingJobs();
			const actionResult = await resolved;
			if (actionResult.error) {
				const err = dumpVmError(vm, actionResult.error);
				emitTriggerEvent(bridge, "trigger.error", msg.exportName, {
					error: { message: err.message, stack: err.stack },
				});
				payload = {
					ok: false,
					error: { message: err.message, stack: err.stack },
				};
			} else {
				const resultValue = vm.dump(actionResult.value);
				actionResult.value.dispose();
				emitTriggerEvent(bridge, "trigger.response", msg.exportName, {
					output: resultValue,
				});
				payload = {
					ok: true,
					result: resultValue,
				};
			}
		}
	} catch (err) {
		const e = serializeError(err);
		emitTriggerEvent(bridge, "trigger.error", msg.exportName, {
			error: { message: e.message, stack: e.stack },
		});
		payload = {
			ok: false,
			error: { message: e.message, stack: e.stack },
		};
	} finally {
		timers.clearActive();
		state.currentAbort?.abort();
		state.currentAbort = null;
		uninstallGlobals(bridge, extraNames);
		bridge.clearRunContext();
	}

	post({ type: "done", payload });
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
			queueMicrotask(() => {
				throw err;
			});
		}
	})();
});
