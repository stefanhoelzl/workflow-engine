import { parentPort } from "node:worker_threads";
import { IIFE_NAMESPACE } from "@workflow-engine/core";
import {
	JSException,
	type JSValueHandle,
	QuickJS,
	type QuickJSOptions,
	type Snapshot,
} from "quickjs-wasi";
import { base64Extension } from "quickjs-wasi/base64";
import { cryptoExtension } from "quickjs-wasi/crypto";
import { encodingExtension } from "quickjs-wasi/encoding";
import { headersExtension } from "quickjs-wasi/headers";
import { structuredCloneExtension } from "quickjs-wasi/structured-clone";
import { urlExtension } from "quickjs-wasi/url";
import { type Bridge, createBridge } from "./bridge.js";
import {
	accountOutputBytes,
	configureWorkerLimits,
	resetRunCounters,
} from "./limit-counters.js";
import {
	createPluginContext,
	type GuestFunctionDescription,
	type PluginContext,
	type PluginDescriptor,
} from "./plugin.js";
import {
	collectGuestFunctions,
	type GlobalBinder,
	loadPluginModules,
	runOnBeforeRunStarted,
	runOnPost,
	runOnRunFinished,
	runPhasePrivateDelete,
	runPhaseSourceEval,
	runPhaseWorker,
	type SourceEvaluator,
	type WarnFn,
} from "./plugin-runtime.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";
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

// Configured stack-size cap (bytes). Applied after `QuickJS.create` and after
// `QuickJS.restore` via `qjs_set_max_stack_size` — QuickJSOptions does not
// surface this publicly, so we reach through to the wasm export directly.
let stackSizeForNextCreate = 0;

function applyStackLimit(vm: QuickJS, stackBytes: number): void {
	if (stackBytes <= 0) {
		return;
	}
	const setter = (
		vm as unknown as {
			exports?: {
				// biome-ignore lint/style/useNamingConvention: wasm export name matches QuickJS's upstream C symbol
				qjs_set_max_stack_size?: (n: number) => void;
			};
		}
	).exports?.qjs_set_max_stack_size;
	if (typeof setter === "function") {
		setter(stackBytes);
	}
}

// Re-entrancy guard: if an onPost hook triggers post() (e.g. by emitting
// a log inside the hook itself), we skip the hook pipeline on that nested
// call so we don't recurse or deadlock. Nested messages go out raw.
let inPostHooks = false;

// Post a WorkerToMain message. Applies plugin onPost hooks first, then
// accounts the serialized size against the per-run output-bytes cap. A
// breach throws `SandboxLimitError` via queueMicrotask AND drops the
// message on the floor — the worker exits before main sees any further
// events for this run. Non-event messages (`ready`, `init-error`, `done`,
// `log`) are subject to the cap too: the cap covers everything crossing
// the channel per the sandbox spec, and attempting to carve out exceptions
// would let a hostile workflow starve output by flooding `log`.
function post(msg: WorkerToMain): void {
	const lifecycle = state?.pluginLifecycle;
	if (!lifecycle || inPostHooks) {
		if (!accountForOutput(msg)) {
			return;
		}
		port.postMessage(msg);
		return;
	}
	inPostHooks = true;
	let finalMsg: WorkerToMain;
	let hookErrors: readonly Error[];
	try {
		const result = runOnPost({
			setups: lifecycle.setups,
			order: lifecycle.order,
			msg,
		});
		finalMsg = result.msg;
		hookErrors = result.errors;
	} finally {
		inPostHooks = false;
	}
	if (!accountForOutput(finalMsg)) {
		return;
	}
	port.postMessage(finalMsg);
	for (const err of hookErrors) {
		const pluginName =
			(err as Error & { pluginName?: string }).pluginName ?? "<unknown>";
		const logMsg: WorkerToMain = {
			type: "log",
			level: "error",
			message: "sandbox.plugin.onPost_failed",
			meta: { plugin: pluginName, error: err.message },
		};
		if (!accountForOutput(logMsg)) {
			return;
		}
		port.postMessage(logMsg);
	}
}

function accountForOutput(msg: WorkerToMain): boolean {
	// Output-bytes counting is scoped to `type:"event"` messages only —
	// the channel that author-emitted events traverse. Control-plane
	// messages (`ready`, `init-error`, `done`, `log`) bypass the cap:
	// they are fixed-shape protocol traffic, not author-influenced, and
	// dropping them would strand main's pending run promise or lose
	// engine diagnostics. The measured size is `JSON.stringify(msg.event)
	// .length`, i.e. payload only — the wire-envelope overhead is
	// constant and not author-controllable.
	if (msg.type !== "event") {
		return true;
	}
	let size: number;
	try {
		size = JSON.stringify(msg.event).length;
	} catch {
		size = 0;
	}
	return accountOutputBytes(size);
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

interface GuestFunctionEntry {
	readonly pluginName: string;
	readonly descriptor: GuestFunctionDescription;
}

type RunState = "ready" | "running" | "restoring" | "dead";

interface WorkerState {
	vm: QuickJS;
	// Bridge is built once at init and survives every snapshot restore via
	// `bridge.rebind(newVm)`. Plugin lifecycle hooks closed over the boot-time
	// PluginContext — that ctx is pinned by the plugin closures themselves
	// (in `pluginLifecycle.setups`); the bridge owns its own internal ctx
	// for descriptor log auto-wrap. Either way, what survives restores is the
	// bridge instance — re-binding swaps the VM underneath while the sink,
	// anchor, and emit path stay live.
	readonly bridge: Bridge;
	currentAbort: AbortController | null;
	pluginLifecycle: PluginLifecycleState;
	// Snapshot-restore bookkeeping. After init, the worker takes one
	// `vm.snapshot()` from which every subsequent run restores — giving
	// the guest fresh state per run. `guestFunctions` and `createOptions`
	// are frozen at init and replayed on every restore so the rebuilt
	// VM re-registers host callbacks and receives the same extensions.
	readonly snapshotRef: Snapshot;
	readonly guestFunctions: readonly GuestFunctionEntry[];
	readonly createOptions: QuickJSOptions;
	runState: RunState;
	restorePromise: Promise<void> | null;
}

let state: WorkerState | null = null;

// Test seam: when set, the next async restore after a run throws
// synthetically. Used by the `Restore failure marks sandbox dead`
// scenario — see packages/sandbox/src/sandbox.test.ts. Read once at
// module load; adds a constant-time branch in the restore path.
const TEST_RESTORE_FAIL =
	// biome-ignore lint/style/noProcessEnv: scoped test-only seam
	process.env.WFE_TEST_SANDBOX_RESTORE_FAIL === "1";

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
			memoryLimit: msg.memoryBytes,
		};
		configureWorkerLimits({
			outputBytes: msg.outputBytes,
			pendingCallables: msg.pendingCallables,
		});
		// Stack-size cap. `QuickJSOptions` does not expose `maxStackSize`
		// publicly, but the underlying wasm export `qjs_set_max_stack_size`
		// is the exact hook used by QuickJS itself to apply a stack cap.
		// We set it immediately after VM creation so Phase 2 (plugin source
		// eval) and Phase 4 (user source eval) both run under the cap.
		stackSizeForNextCreate = msg.stackBytes;

		// Seed the shared anchor BEFORE QuickJS.create so the WASI monotonic
		// clock returns small values during VM init; otherwise QuickJS caches a
		// large reference for performance.now() and every subsequent guest read
		// is skewed by the Node process uptime at init time.
		wasiState.anchor.ns = perfNowNs();
		createOptions.wasi = createWasiFactory(wasiState, post);

		vm = await QuickJS.create(createOptions);
		applyStackLimit(vm, stackSizeForNextCreate);

		bridge = createBridge(vm, wasiState.anchor);
		bridge.setSink((event) => post({ type: "event", event }));

		// Phases 1a–3: plugin-boot pipeline. Performs the full
		// `worker() → source eval → private-delete` sequence before user-
		// source evaluation.
		const bootResult = await runPluginBootPipeline(
			vm,
			bridge,
			msg.pluginDescriptors,
		);

		// Phase 4 — user source eval.
		const evalResult = vm.evalCode(msg.source, msg.filename);
		evalResult.dispose();

		// Capture the post-init VM snapshot. Every subsequent `handleRun`
		// restores from this snapshot off the critical path, so guest
		// state from one run does not leak into the next.
		const snapshotRef = vm.snapshot();

		state = {
			vm,
			bridge,
			currentAbort: null,
			pluginLifecycle: bootResult.pluginLifecycle,
			snapshotRef,
			guestFunctions: bootResult.guestFunctions,
			createOptions,
			runState: "ready",
			restorePromise: null,
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
		vm?.dispose();
		post({ type: "init-error", error: serialized });
		process.exit(0);
	}
}

interface BootPipelineResult {
	readonly pluginLifecycle: PluginLifecycleState;
	readonly guestFunctions: readonly GuestFunctionEntry[];
}

async function runPluginBootPipeline(
	vm: QuickJS,
	bridge: Bridge,
	descriptors: readonly PluginDescriptor[],
): Promise<BootPipelineResult> {
	// Plugin-facing ctx for `plugin.worker(ctx, deps, config)`. Pinned by each
	// plugin's returned closure (in `pluginLifecycle.setups`), so it survives
	// across snapshot restores as long as the plugin holds it. The bridge
	// owns its own internal ctx for descriptor log auto-wrap; this one is
	// only handed to plugin authors.
	const ctx: PluginContext = createPluginContext(bridge);
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
	for (const { descriptor } of guestFunctions) {
		bridge.installDescriptor(descriptor);
	}

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

	return {
		pluginLifecycle: { setups: phase1.setups, order: phase1.order },
		guestFunctions,
	};
}

// Re-register host callbacks against the restored VM via the bridge.
// The Bridge is reused across restores (bridge.rebind switches the
// underlying VM in place), so plugin lifecycle hooks — which closed over
// the boot-time PluginContext via `pluginLifecycle.setups` — keep emitting
// through the live bridge. The bridge's internal ctx (used by descriptor
// log auto-wrap) is also stable across restores. Only guest-function host
// callbacks need rebinding because they are registered on a specific
// QuickJS instance — `bridge.rebindDescriptor` re-registers each on the
// bridge's current VM.
function rebindGuestCallbacks(currentState: WorkerState): void {
	for (const { descriptor } of currentState.guestFunctions) {
		currentState.bridge.rebindDescriptor(descriptor);
	}
}

// Kick off the async post-run restore. Returns the in-flight promise so
// the next `handleRun` can await it before dispatch. Dispose order: bridge
// first (detaches sink callbacks), then VM. Re-seed the WASI monotonic
// anchor so the restored VM's `performance.now()` starts near zero again.
// On failure, rethrow via queueMicrotask: the worker's `port.on("message",
// ...)` handler doesn't observe this promise, so we route errors through
// Node's unhandled-rejection path which terminates the worker and fires
// `onTerminated` on main.
function startRestore(currentState: WorkerState): Promise<void> {
	if (currentState.restorePromise) {
		return currentState.restorePromise;
	}
	const promise = (async () => {
		if (TEST_RESTORE_FAIL) {
			throw new Error(
				"injected restore failure (WFE_TEST_SANDBOX_RESTORE_FAIL)",
			);
		}
		// Dispose the old VM up-front, then restore. The historical race —
		// late host-callback work scheduled by guest async that resolved
		// just before `post({type:"done"})` calling into the freshly
		// disposed VM, surfaced under concurrent WPT load (idlharness,
		// fetch suites) — is now closed structurally by the Callable-leak
		// audit at end of `runLifecycleAfter`: every Callable holding a
		// `JSValueHandle` into the outgoing VM is auto-disposed before
		// this point, so no remaining host code can re-enter the VM.
		// Disposing first avoids holding two VMs briefly. If a future leak
		// path reintroduces a hazard, the audit's
		// `sandbox.plugin.callable_leak` log line names the offending
		// descriptor.
		currentState.vm.dispose();
		wasiState.anchor.ns = perfNowNs();
		const newVm = await QuickJS.restore(
			currentState.snapshotRef,
			currentState.createOptions,
		);
		// Re-point the bridge at the restored VM in place. ctx + pluginLifecycle
		// setups close over this same bridge instance; rebinding here is what
		// keeps onBeforeRunStarted / onRunFinished emitting on every run, not
		// just the first.
		currentState.bridge.rebind(newVm);
		rebindGuestCallbacks(currentState);
		applyStackLimit(newVm, stackSizeForNextCreate);
		currentState.vm = newVm;
		currentState.runState = "ready";
		currentState.restorePromise = null;
	})();
	// Surface failures through Node's uncaught-error pathway so the worker
	// dies and main fires onTerminated. The awaiting handleRun will also see the
	// rejection, but the rethrow is what terminates the worker.
	promise.catch((err) => {
		currentState.runState = "dead";
		queueMicrotask(() => {
			throw err;
		});
	});
	currentState.restorePromise = promise;
	return promise;
}

/**
 * Emits a `log` message to the main thread for a dangling-frame warning.
 * Frame tracking now lives entirely on the main-thread RunSequencer (see
 * `run-sequencer.ts`); the worker no longer truncates or counts open
 * frames itself. This warn channel is preserved for any plugin-lifecycle
 * surfacing that benefits from the same wire shape.
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
 * Runs onBeforeRunStarted hooks across all registered plugins. A hook
 * throw does NOT abort the run — we log an error and continue with the
 * guest handler. Frame state (refStack, callMap) is owned by the main-
 * thread RunSequencer; the worker no longer truncates anything on hook
 * throw.
 */
function runLifecycleBefore(
	pluginLifecycle: PluginLifecycleState | null,
	runInput: import("./plugin.js").RunInput,
): void {
	if (!pluginLifecycle) {
		return;
	}
	try {
		runOnBeforeRunStarted({
			setups: pluginLifecycle.setups,
			order: pluginLifecycle.order,
			runInput,
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
 * Runs onRunFinished hooks in reverse topo order. Frame cleanup (closing
 * any plugin-opened frames) is the plugin's own responsibility — typically
 * via `ctx.emit({type: { close: callId }})` matching their own opens.
 * Frames left open after the run finishes are caught by the main-thread
 * RunSequencer's `finish()` (clean-end path: warn-and-drop; death path:
 * synthesise closes).
 */
function runLifecycleAfter(
	pluginLifecycle: PluginLifecycleState,
	bridge: Bridge,
	runInput: import("./plugin.js").RunInput,
	payload: RunResultPayload,
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
	// Callable leak audit. After every plugin's `onRunFinished` drain has
	// run, no Callable should remain live: by contract, a plugin that
	// receives a guest Callable owns disposal. Survivors are leaks — and
	// dangerous: their `dup` JSValueHandle is into the run's VM, which
	// the post-run snapshot-restore is about to dispose. A late invocation
	// from an unflushed host-callback would call into a freed VM and
	// crash the worker (the historical race the
	// `build-new-VM-before-dispose-old` fix in startRestore worked around).
	// We close that race structurally: log each survivor naming the
	// originating descriptor, and call `.dispose()` so any later invoke
	// throws a defined `CallableDisposedError` instead of touching the VM.
	const leaks = bridge.drainCallableLeaks();
	for (const { callable, descriptor } of leaks) {
		post({
			type: "log",
			level: "error",
			message: "sandbox.plugin.callable_leak",
			meta: { descriptor },
		});
		callable.dispose();
	}
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
	readonly state: WorkerState;
	readonly runInput: import("./plugin.js").RunInput;
	readonly payload: RunResultPayload;
}

function finalizeRun(args: RunFinalizeArgs): void {
	const { state, runInput, payload } = args;
	const { bridge, pluginLifecycle } = state;
	runLifecycleAfter(pluginLifecycle, bridge, runInput, payload);
	state.currentAbort?.abort();
	state.currentAbort = null;
	// Close the worker-side run window so any late host-callback
	// emissions (e.g. from guest async resolutions during the post-`done`
	// restore) are silently suppressed at the source, matching pre-
	// refactor behaviour.
	bridge.clearRunActive();
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: handleRun sequences the full per-run lifecycle (await prior restore, anchor reset, run-window open, lifecycle hooks, guest invoke, finalize, fire-and-forget restore) — splitting requires threading state across multiple call frames
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

	// If a previous run's async restore is still in flight, wait for it.
	// Errors in the restore propagate here and out through the outer
	// try/catch in the message handler — which also rethrows via
	// queueMicrotask, terminating the worker so main's `onTerminated` fires.
	if (state.runState === "restoring" && state.restorePromise) {
		await state.restorePromise;
	}
	state.runState = "running";

	const { vm, bridge, pluginLifecycle } = state;

	resetRunCounters();
	bridge.resetAnchor();
	// Open the worker-side run window. The bridge suppresses emissions
	// outside this window (returns from `buildEvent` without posting),
	// matching pre-refactor behaviour. This avoids posting init-time
	// events (e.g. WPT test bodies that run during Phase-4 source eval
	// inline `console.log(Symbol.for(...))` calls — registered symbols
	// would otherwise break `port.postMessage` clone). `resetCallIds`
	// zeroes the per-run callId counter so each run mints IDs from 0.
	//
	// Runtime metadata (owner/workflow/workflowSha/invocationId) is
	// stamped runtime-side; seq/ref are stamped main-side via the
	// RunSequencer. The worker's gate is for SUPPRESSION only; it does
	// not own ordering or stamping.
	bridge.resetCallIds();
	bridge.setRunActive();
	state.currentAbort = new AbortController();

	const runInput: import("./plugin.js").RunInput = {
		name: msg.exportName,
		input: msg.ctx,
		...(msg.extras === undefined ? {} : { extras: msg.extras }),
	};
	runLifecycleBefore(pluginLifecycle, runInput);

	let payload: RunResultPayload;
	try {
		payload = await invokeGuestHandler(vm, msg.exportName, msg.ctx);
	} catch (err) {
		const e = serializeError(err);
		payload = { ok: false, error: { message: e.message, stack: e.stack } };
	}
	finalizeRun({ state, runInput, payload });
	post({ type: "done", payload });

	// Fire-and-forget async restore so the next run sees fresh guest state.
	// Errors within `startRestore` are surfaced via queueMicrotask to
	// terminate the worker (see rationale in startRestore's comment).
	state.runState = "restoring";
	startRestore(state);
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
