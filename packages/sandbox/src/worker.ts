import { parentPort } from "node:worker_threads";
import { IIFE_NAMESPACE } from "@workflow-engine/core";
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
import { type Bridge, createBridge } from "./bridge-factory.js";
import { installGuestFunctions } from "./guest-function-install.js";
import type { PluginDescriptor } from "./plugin.js";
import {
	collectGuestFunctions,
	type FrameTracker,
	type GlobalBinder,
	loadPluginModules,
	runOnBeforeRunStarted,
	runOnRunFinished,
	runPhasePrivateDelete,
	runPhaseSourceEval,
	runPhaseWorker,
	type SourceEvaluator,
	truncateFinalRefStack,
	type WarnFn,
} from "./plugin-runtime.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";
import { createSandboxContext } from "./sandbox-context.js";
import {
	createWasiFactory,
	createWasiState,
	installWasiHooks,
	perfNowNs,
	type WasiState,
} from "./wasi.js";
import { defaultPluginLoader } from "./worker-plugin-loader.js";

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

// --- Sandbox state (lives for the life of this worker) ---

interface PluginLifecycleState {
	readonly setups: ReadonlyMap<string, import("./plugin.js").PluginSetup>;
	readonly order: readonly string[];
}

interface SandboxState {
	vm: QuickJS;
	bridge: Bridge;
	currentAbort: AbortController | null;
	pluginLifecycle: PluginLifecycleState;
}

let state: SandboxState | null = null;

// --- WASI overrides: observability for clock/random + fd_write routing ---

const wasiState: WasiState = createWasiState();

// --- Init phases ---
//
// Phase 0 — module load: worker.ts imports are processed at module evaluation
//           time. Plugin descriptor modules are resolved inside Phase 1a via
//           dynamic import.
// Phase 1 — WASM instantiate: QuickJS.create(); bridge + timers + fetch/RPC
//           method setup; polyfill bundle eval + assertion.
// Phase 1a — plugin.worker() iteration (only when msg.pluginDescriptors
//            non-empty): resolve each descriptor's source via data: URI
//            import, run its worker(ctx, deps, config), collect
//            PluginSetup results.
// Phase 2 — plugin source eval (in topo order).
// Phase 3 — private-descriptor auto-deletion (delete globalThis[name] for
//           every guestFunction with public !== true).
// Phase 4 — user source eval (msg.source at msg.filename).
//
// Any throw in any phase above is caught at the outer try/catch: partial VM
// resources are disposed, an init-error is posted to main, and the worker
// exits with code 0 so the main-thread init handshake can report a typed
// error without also surfacing a non-zero exit.

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: handleInit sets up VM, bridge, plugin pipeline, and user-source eval as an atomic sequence
async function handleInit(
	msg: Extract<MainToWorker, { type: "init" }>,
): Promise<void> {
	let vm: QuickJS | null = null;
	let bridge: Bridge | null = null;
	try {
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

		vm = await QuickJS.create(createOptions);

		bridge = createBridge(vm, wasiState.anchor);
		wasiState.bridge = bridge;
		bridge.setSink((event) => post({ type: "event", event }));

		// Phases 1a–3: plugin-boot pipeline. Performs the full
		// `worker() → source eval → private-delete` sequence before user-
		// source evaluation.
		const pluginLifecycle = await runPluginBootPipeline(
			vm,
			bridge,
			msg.pluginDescriptors,
		);

		// Phase 4 — user source eval.
		const evalResult = vm.evalCode(msg.source, msg.filename);
		evalResult.dispose();

		state = {
			vm,
			bridge,
			currentAbort: null,
			pluginLifecycle,
		};

		post({ type: "ready" });
	} catch (err) {
		const serialized =
			err instanceof JSException
				? serializeJsException(err)
				: serializeError(err);
		if (err instanceof JSException) {
			err.dispose();
		}
		bridge?.dispose();
		vm?.dispose();
		post({ type: "init-error", error: serialized });
		process.exit(0);
	}
}

async function runPluginBootPipeline(
	vm: QuickJS,
	bridge: Bridge,
	descriptors: readonly PluginDescriptor[],
): Promise<PluginLifecycleState> {
	const ctx = createSandboxContext(bridge);
	// Phase 1a — module load + plugin.worker().
	const loaded = await loadPluginModules(descriptors, defaultPluginLoader);
	const phase1 = await runPhaseWorker(loaded, ctx);

	// Phase 1b — install WASI hooks collected during plugin.worker().
	// `installWasiHooks` enforces hook-slot collision (one plugin per slot);
	// a throw here is caught by the outer init try/catch and reported as an
	// init-error.
	for (const name of phase1.order) {
		const setup = phase1.setups.get(name);
		if (setup?.wasiHooks) {
			installWasiHooks(wasiState, setup.wasiHooks);
		}
	}

	// Phase 1c — install each plugin's guest functions on globalThis so that
	// Phase 2 plugin-source evaluation can capture private descriptors
	// (`const x = globalThis.__x; delete globalThis.__x;`). Public
	// descriptors remain visible through Phase 3 and into user source.
	const guestFunctions = collectGuestFunctions(phase1);
	installGuestFunctions(vm, ctx, guestFunctions);

	// Phase 2 — plugin source eval.
	const evaluator: SourceEvaluator = {
		eval(source, filename) {
			const r = vm.evalCode(source, filename);
			r.dispose();
		},
	};
	runPhaseSourceEval(phase1, descriptors, evaluator);

	// Phase 3 — private-descriptor auto-deletion.
	// QuickJS has no deleteProp — use evalCode with a JSON-escaped name so
	// the delete semantically removes the binding (not just sets undefined).
	const binder: GlobalBinder = {
		delete(name) {
			const r = vm.evalCode(
				`delete globalThis[${JSON.stringify(name)}];`,
				"<sandbox-phase3-delete>",
			);
			r.dispose();
		},
	};
	runPhasePrivateDelete(phase1, binder);

	return { setups: phase1.setups, order: phase1.order };
}

/**
 * Wraps the Bridge's refStack primitives as a FrameTracker so plugin-runtime
 * lifecycle helpers can depth-check / truncate without depending on the
 * Bridge type directly.
 */
function bridgeFrameTracker(bridge: Bridge): FrameTracker {
	return {
		depth() {
			return bridge.refStackDepth();
		},
		truncateTo(depth) {
			return bridge.truncateRefStackTo(depth);
		},
	};
}

/**
 * Emits a `log` message to the main thread for a dangling-frame warning.
 * Plugin-runtime surfaces these when onBeforeRunStarted or the final
 * cleanup drop frames that weren't explicitly closed; surfacing them via
 * the existing logger channel keeps the signal visible without requiring a
 * new protocol message.
 */
const logDanglingFrame: WarnFn = (warning) => {
	post({
		type: "log",
		level: "warn",
		message: "sandbox.plugin.dangling_frame",
		meta: {
			phase: warning.phase,
			...(warning.plugin === undefined ? {} : { plugin: warning.plugin }),
			dropped: warning.dropped,
		},
	});
};

/**
 * Runs onBeforeRunStarted hooks across all registered plugins. A hook throw
 * does NOT abort the run — we log an error and continue with the guest
 * handler. Frames pushed by hooks that threw are already truncated by
 * runOnBeforeRunStarted internally.
 */
function runLifecycleBefore(
	pluginLifecycle: PluginLifecycleState | null,
	runInput: import("./plugin.js").RunInput,
	tracker: FrameTracker,
): void {
	if (!pluginLifecycle) {
		return;
	}
	try {
		runOnBeforeRunStarted({
			setups: pluginLifecycle.setups,
			order: pluginLifecycle.order,
			runInput,
			tracker,
			warn: logDanglingFrame,
		});
	} catch (err) {
		post({
			type: "log",
			level: "error",
			message: "sandbox.plugin.onBeforeRunStarted_failed",
			meta: { error: err instanceof Error ? err.message : String(err) },
		});
	}
}

/**
 * Runs onRunFinished hooks in reverse topo order, then truncates any
 * remaining refStack frames with a dangling-frame warning. Invoked from
 * handleRun's finally block so it always fires — even if the guest handler
 * threw.
 */
function runLifecycleAfter(
	pluginLifecycle: PluginLifecycleState,
	runInput: import("./plugin.js").RunInput,
	payload: RunResultPayload,
	tracker: FrameTracker,
): void {
	const runResult: import("./plugin.js").RunResult = payload.ok
		? { ok: true, output: payload.result }
		: { ok: false, error: new Error(payload.error.message) };
	runOnRunFinished({
		setups: pluginLifecycle.setups,
		order: pluginLifecycle.order,
		result: runResult,
		runInput,
		warn: logDanglingFrame,
	});
	truncateFinalRefStack(tracker, logDanglingFrame);
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

async function invokeGuestHandler(
	vm: QuickJS,
	exportName: string,
	ctx: unknown,
): Promise<RunResultPayload> {
	const fnHandle = readExportFromIife(vm, exportName);
	if (!fnHandle) {
		return {
			ok: false,
			error: {
				message: `export '${exportName}' not found in workflow bundle`,
				stack: "",
			},
		};
	}
	try {
		return await callGuestFunction(vm, fnHandle, ctx);
	} finally {
		fnHandle.dispose();
	}
}

interface RunFinalizeArgs {
	readonly state: SandboxState;
	readonly runInput: import("./plugin.js").RunInput;
	readonly payload: RunResultPayload;
	readonly tracker: FrameTracker;
}

function finalizeRun(args: RunFinalizeArgs): void {
	const { state, runInput, payload, tracker } = args;
	const { bridge, pluginLifecycle } = state;
	runLifecycleAfter(pluginLifecycle, runInput, payload, tracker);
	state.currentAbort?.abort();
	state.currentAbort = null;
	bridge.clearRunActive();
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
	const { vm, bridge, pluginLifecycle } = state;

	bridge.resetAnchor();
	// Run metadata (tenant/workflow/workflowSha/invocationId) is tracked on
	// the main thread (`packages/sandbox/src/index.ts`) and stamped onto
	// events before they reach `sb.onEvent` subscribers. The worker only
	// flips a boolean "run active" flag so the bridge knows to produce
	// events (vs. the init-phase "no run" state which would short-circuit
	// emission).
	bridge.setRunActive();
	state.currentAbort = new AbortController();

	const runInput: import("./plugin.js").RunInput = {
		name: msg.exportName,
		input: msg.ctx,
	};
	const tracker = bridgeFrameTracker(bridge);
	runLifecycleBefore(pluginLifecycle, runInput, tracker);

	let payload: RunResultPayload;
	try {
		payload = await invokeGuestHandler(vm, msg.exportName, msg.ctx);
	} catch (err) {
		const e = serializeError(err);
		payload = { ok: false, error: { message: e.message, stack: e.stack } };
	}
	finalizeRun({ state, runInput, payload, tracker });
	post({ type: "done", payload });
}

port.on("message", (msg: MainToWorker) => {
	(async () => {
		try {
			if (msg.type === "init") {
				await handleInit(msg);
			} else if (msg.type === "run") {
				await handleRun(msg);
			}
		} catch (err) {
			queueMicrotask(() => {
				throw err;
			});
		}
	})();
});
