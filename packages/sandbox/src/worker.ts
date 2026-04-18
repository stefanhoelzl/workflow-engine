import { parentPort } from "node:worker_threads";
import SANDBOX_POLYFILLS from "virtual:sandbox-polyfills";
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
import { setupGlobals, type TimerCleanup } from "./globals.js";
import { installRpcMethods, uninstallGlobals } from "./install-host-methods.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";
import {
	createWasiFactory,
	createWasiState,
	perfNowNs,
	type WasiState,
} from "./wasi.js";

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
			at: new Date().toISOString(),
			ts: bridge.tsUs(),
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

// --- WASI overrides: observability for clock/random + fd_write routing ---

const wasiState: WasiState = createWasiState();

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

	// Seed the shared anchor BEFORE QuickJS.create so the WASI monotonic
	// clock returns small values during VM init; otherwise QuickJS caches a
	// large reference for performance.now() and every subsequent guest read
	// is skewed by the Node process uptime at init time.
	wasiState.anchor.ns = perfNowNs();
	createOptions.wasi = createWasiFactory(wasiState, post);

	const vm = await QuickJS.create(createOptions);

	const bridge = createBridge(vm, wasiState.anchor);
	wasiState.bridge = bridge;
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

	// Consolidated guest-side polyfill bundle — installs (in order):
	//   trivial (self, navigator), event-target (EventTarget/Event/ErrorEvent/
	//   AbortController/AbortSignal + globalThis-as-EventTarget hybrid install),
	//   report-error (ErrorEvent dispatch + __reportError host forwarding),
	//   microtask (queueMicrotask wrap routing errors through reportError),
	//   fetch (fetch shim on __hostFetch),
	//   subtle-crypto (validation + DOMException translation around the
	//   cryptoExtension's native crypto.subtle; also promise-wraps the
	//   synchronous native methods).
	// Evaluated AFTER __hostFetch (from bridgeHostFetch above) and __reportError
	// (from installRpcMethods). Generated at consumer build time by
	// `sandboxPolyfills()` vite plugin; see packages/sandbox/src/polyfills/.
	const polyfillResult = vm.evalCode(SANDBOX_POLYFILLS, "<sandbox-polyfills>");
	polyfillResult.dispose();

	// Init-assertion: guard against future quickjs-wasi upgrades breaking the
	// hybrid globalThis-as-EventTarget install. Evaluated in the guest heap.
	const assertResult = vm.evalCode(
		`(function(){
			if (typeof globalThis.addEventListener !== 'function')
				throw new Error('sandbox init: globalThis.addEventListener missing');
			if (!(globalThis instanceof EventTarget))
				throw new Error('sandbox init: globalThis is not an EventTarget');
		})();`,
		"<sandbox-polyfill-assert>",
	);
	assertResult.dispose();

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
		at: new Date().toISOString(),
		ts: bridge.tsUs(),
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

function emitTerminalTriggerEvent(
	bridge: Bridge,
	exportName: string,
	payload: RunResultPayload,
): void {
	if (payload.ok) {
		emitTriggerEvent(bridge, "trigger.response", exportName, {
			output: payload.result,
		});
	} else {
		emitTriggerEvent(bridge, "trigger.error", exportName, {
			error: {
				message: payload.error.message,
				stack: payload.error.stack,
			},
		});
	}
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run orchestrator threads abort signal, installs per-run extras, invokes the exported function, and emits trigger events — splitting obscures the sequence
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

	bridge.resetAnchor();
	bridge.setRunContext({
		invocationId: msg.invocationId,
		workflow: msg.workflow,
		workflowSha: msg.workflowSha,
	});
	state.currentAbort = new AbortController();
	// Per-run extraMethods that share a name with a construction-time method
	// must NOT re-register a QuickJS host callback (quickjs-wasi throws on
	// double-registration). The main-thread dispatch (allMethods = {...methods,
	// ...extraMethods}) routes the call to the extra impl for the run's
	// duration, so the existing guest binding already forwards correctly.
	const constructionNames = new Set(state.constructionMethodNames);
	const extraNames = msg.extraNames.filter((n) => !constructionNames.has(n));
	installRpcMethods(bridge, bridge.vm.global, extraNames, sendRequest);

	emitTriggerEvent(bridge, "trigger.request", msg.exportName, {
		input: msg.ctx,
	});

	let payload: RunResultPayload | null = null;
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
	} catch (err) {
		const e = serializeError(err);
		payload = {
			ok: false,
			error: { message: e.message, stack: e.stack },
		};
	} finally {
		// Clear pending timers (emitting timer.clear events) BEFORE the terminal
		// trigger event so those clear events land in the same archive flush.
		timers.clearActive();
		if (payload) {
			emitTerminalTriggerEvent(bridge, msg.exportName, payload);
		}
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
