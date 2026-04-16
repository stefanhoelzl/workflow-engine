import { parentPort } from "node:worker_threads";
import {
	type EventKind,
	IIFE_NAMESPACE,
	type InvocationEvent,
} from "@workflow-engine/core";
import {
	JSException,
	type JSValueHandle,
	QuickJS,
	type QuickJSOptions,
} from "quickjs-wasi";
import { base64Extension } from "quickjs-wasi/base64";
import { cryptoExtension } from "quickjs-wasi/crypto";
import { encodingExtension } from "quickjs-wasi/encoding";
import { headersExtension } from "quickjs-wasi/headers";
import { structuredCloneExtension } from "quickjs-wasi/structured-clone";
import { urlExtension } from "quickjs-wasi/url";
import { bridgeHostFetch } from "./bridge.js";
import { type Bridge, createBridge } from "./bridge-factory.js";
import {
	CRYPTO_PROMISE_SHIM,
	FETCH_SHIM,
	setupGlobals,
	type TimerCleanup,
} from "./globals.js";
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

function dumpVmError(vm: QuickJS, handle: JSValueHandle): SerializedError {
	const err = vm.dump(handle) as
		| { name?: string; message?: string; stack?: string }
		| null
		| undefined;
	handle.dispose();
	return {
		name: String(err?.name ?? "Error"),
		message: String(err?.message ?? err),
		stack: String(err?.stack ?? ""),
	};
}

function serializeJsException(err: JSException): SerializedError {
	return {
		name: err.name ?? "Error",
		message: err.message ?? String(err),
		stack: err.stack ?? "",
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
			throw new TypeError(
				`__emitEvent: invalid kind '${String(raw?.kind)}' (only action.* allowed)`,
			);
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
	vm: QuickJS;
	bridge: Bridge;
	timers: TimerCleanup;
	constructionMethodNames: string[];
	constructionMethodEventNames: Record<string, string>;
	currentAbort: AbortController | null;
}

let state: SandboxState | null = null;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: init sets up VM, bridge, timers, fetch forwarding, and source eval as an atomic sequence
async function handleInit(
	msg: Extract<MainToWorker, { type: "init" }>,
): Promise<void> {
	const createOptions: QuickJSOptions = {
		extensions: [
			base64Extension,
			cryptoExtension,
			encodingExtension,
			headersExtension,
			structuredCloneExtension,
			urlExtension,
		],
	};
	if (msg.memoryLimit !== undefined) {
		createOptions.memoryLimit = msg.memoryLimit;
	}
	// TODO(quickjs-wasi): wire clock/random/interruptHandler once we have a
	// way to serialize them across postMessage (likely via factory descriptors
	// resolved on the worker side).

	const vm = await QuickJS.create(createOptions);

	const bridge = createBridge(vm);
	bridge.setSink((event) => post({ type: "event", event }));
	const timers = setupGlobals(bridge);

	// Install crypto.subtle Promise shim AFTER globals so the ordering is
	// consistent with how the fetch shim is layered (shim eval runs once the
	// VM is ready). Must run before workflow code that touches crypto.subtle;
	// the workflow source is evaluated further below.
	const cryptoShimResult = vm.evalCode(CRYPTO_PROMISE_SHIM, "<crypto-shim>");
	cryptoShimResult.dispose();

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

	// After __hostFetch is installed, evaluate the fetch shim so guest code
	// can call standard fetch(url, init).
	const fetchShimResult = vm.evalCode(FETCH_SHIM, "<fetch-shim>");
	fetchShimResult.dispose();

	installEmitEvent(bridge);

	installRpcMethods(
		bridge,
		bridge.vm.global,
		msg.methodNames,
		sendRequest,
		msg.methodEventNames,
	);

	try {
		const evalResult = vm.evalCode(msg.source, msg.filename);
		evalResult.dispose();
	} catch (err) {
		const serialized =
			err instanceof JSException
				? serializeJsException(err)
				: serializeError(err);
		if (err instanceof JSException) {
			err.dispose();
		}
		timers.dispose();
		bridge.dispose();
		vm.dispose();
		post({ type: "init-error", error: serialized });
		process.exit(0);
	}

	state = {
		vm,
		bridge,
		timers,
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

function readExportFromIife(
	vm: QuickJS,
	exportName: string,
): JSValueHandle | null {
	const nsHandle = vm.global.getProp(IIFE_NAMESPACE);
	if (nsHandle.isUndefined || nsHandle.isNull) {
		nsHandle.dispose();
		return null;
	}
	const fnHandle = nsHandle.getProp(exportName);
	nsHandle.dispose();
	if (fnHandle.isUndefined || fnHandle.isNull) {
		fnHandle.dispose();
		return null;
	}
	return fnHandle;
}

// Invoke `fnHandle(ctx)` inside the VM, resolve the returned promise, and
// translate the outcome to a RunResultPayload. Dumps the returned value on
// success (via vm.dump) and serialises the error on failure (JSException on
// sync throw, dumped VM error on promise rejection).
async function callGuestFunction(
	vm: QuickJS,
	fnHandle: JSValueHandle,
	ctx: unknown,
): Promise<RunResultPayload> {
	const ctxHandle = vm.hostToHandle(ctx);
	let callResultHandle: JSValueHandle;
	try {
		callResultHandle = vm.callFunction(fnHandle, vm.undefined, ctxHandle);
	} catch (err) {
		ctxHandle.dispose();
		if (err instanceof JSException) {
			const serialized = serializeJsException(err);
			err.dispose();
			return {
				ok: false,
				error: { message: serialized.message, stack: serialized.stack },
			};
		}
		throw err;
	}
	ctxHandle.dispose();
	const resolved = vm.resolvePromise(callResultHandle);
	callResultHandle.dispose();
	vm.executePendingJobs();
	const actionResult = await resolved;
	if ("error" in actionResult) {
		const serialized = dumpVmError(vm, actionResult.error);
		return {
			ok: false,
			error: { message: serialized.message, stack: serialized.stack },
		};
	}
	const resultValue = vm.dump(actionResult.value);
	actionResult.value.dispose();
	return { ok: true, result: resultValue };
}

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
	const { vm, bridge, timers } = state;

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
		const fnHandle = readExportFromIife(vm, msg.exportName);
		if (fnHandle) {
			payload = await callGuestFunction(vm, fnHandle, msg.ctx);
			fnHandle.dispose();
		} else {
			payload = {
				ok: false,
				error: {
					message: `export '${msg.exportName}' not found in workflow bundle`,
					stack: "",
				},
			};
		}
		if (payload.ok) {
			emitTriggerEvent(bridge, "trigger.response", msg.exportName, {
				output: payload.result,
			});
		} else {
			emitTriggerEvent(bridge, "trigger.error", msg.exportName, {
				error: { message: payload.error.message, stack: payload.error.stack },
			});
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
