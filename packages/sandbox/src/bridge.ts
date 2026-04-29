import { performance } from "node:perf_hooks";
import { JSException, type JSValueHandle, type QuickJS } from "quickjs-wasi";
import {
	BridgeError,
	CallableDisposedError,
	GuestArgTypeMismatchError,
	GuestSafeError,
	GuestThrownError,
	GuestValidationError,
} from "./guest-errors.js";
import {
	CALLABLE_RESULT_BRAND,
	type Callable,
	type CallableResult,
	createPluginContext,
	type GuestFunctionDescription,
	type LogConfig,
	type PluginContext,
} from "./plugin.js";
import type { ArgSpec, GuestValue, ResultSpec } from "./plugin-types.js";
import type { WireEvent, WireFraming } from "./protocol.js";
import type { AnchorCell } from "./wasi.js";

const NS_PER_MS = 1_000_000;
const US_PER_MS = 1000;

// --- Event sink (worker installs to forward events to main thread) ---

type EventSink = (event: WireEvent) => void;

// --- Extractor types ---

interface RequiredExtractor<T> {
	readonly kind: "required";
	readonly extractFn: (vm: QuickJS, handle: JSValueHandle) => T;
	readonly optional: OptionalExtractor<T>;
	readonly rest: RestExtractor<T>;
}

interface OptionalExtractor<T> {
	readonly kind: "optional";
	readonly extractFn: (vm: QuickJS, handle: JSValueHandle) => T;
}

interface RestExtractor<T> {
	readonly kind: "rest";
	readonly extractFn: (vm: QuickJS, handle: JSValueHandle) => T;
}

// SDK-input shape for emit framing. The bridge transforms `"open"` into
// `{ open: <mintedCallId> }` on the wire (asymmetric SDK vs wire types).
type EmitFraming = "leaf" | "open" | { readonly close: number };

interface CallableLeak {
	readonly callable: Callable;
	readonly descriptor: string;
}

// The Bridge owns the entire host↔VM boundary:
//   - marshal/arg extractors and primitives over the current VM,
//   - the WASI clock anchor + per-run callId minting,
//   - the event sink + runActive gate,
//   - host-callable Callable lifecycle (makeCallable + dispose registry),
//   - guest-function descriptor installation (host trampoline registration).
//
// Worker-side runActive gating is deliberate (not redundant with main):
// emits during plugin boot or Phase-4 user-source eval (which inline WPT
// test bodies whose synchronous `test(...)` calls can invoke
// `console.log(Symbol.for(...))` — see `console-log-symbol.any.js`) carry
// values that may be unclonable (registered symbols cross `vm.dump` as
// host primitives and break `port.postMessage`). Suppressing at source
// avoids the clone failure AND keeps init-time emissions out of the bus,
// matching the pre-refactor behaviour. The main-side `RunSequencer`
// retains a distinct runActive for stamping; both gates are required.
//
// Callable leak audit: every `Callable` constructed via `makeCallable`
// holds a `dup`'d JSValueHandle into the current VM. Plugins that receive
// a Callable own its disposal via `Callable.dispose()`. Survivors at end
// of run-lifecycle are leaks — and dangerous: their handle is into the
// VM about to be disposed by the post-run snapshot restore. The audit
// (drainCallableLeaks) is invoked by worker.ts AFTER every plugin's
// `onRunFinished` and BEFORE clearRunActive; survivors are logged with
// their originating descriptor name and auto-disposed, converting a
// future worker crash (vm.callFunction on a disposed VM) into a defined
// `CallableDisposedError` from `Callable.invoke`.
interface Bridge {
	readonly arg: {
		readonly string: RequiredExtractor<string>;
		readonly number: RequiredExtractor<number>;
		readonly json: RequiredExtractor<unknown>;
		readonly boolean: RequiredExtractor<unknown>;
	};
	readonly marshal: {
		readonly string: (value: string) => JSValueHandle;
		readonly number: (value: number) => JSValueHandle;
		readonly json: (value: unknown) => JSValueHandle;
		readonly boolean: (value: unknown) => JSValueHandle;
		// biome-ignore lint/suspicious/noConfusingVoidType: void marshal must accept void return values from impl
		readonly void: (value: void) => JSValueHandle;
	};
	/**
	 * Open the run window: subsequent `buildEvent` calls produce wire
	 * events and post them via the sink. Pure boolean toggle; callers MUST
	 * also invoke `resetCallIds()` at run start so each run mints CallIds
	 * from a fresh sequence.
	 */
	setRunActive(): void;
	/**
	 * Close the run window: subsequent `buildEvent` calls return without
	 * posting. Pure boolean toggle; the callId counter is left untouched
	 * (the next `resetCallIds()` zeroes it).
	 */
	clearRunActive(): void;
	/**
	 * Zero the per-run callId counter. Worker calls this at run start
	 * (paired with `setRunActive()`) so each run's open-events mint
	 * deterministic, monotonic IDs from 0.
	 */
	resetCallIds(): void;
	/**
	 * Build a WireEvent and emit it via the sink — but ONLY when a run is
	 * active. Outside the active window, the call is a no-op (no
	 * postMessage, no callId minted) and the return value is 0. This
	 * mirrors the pre-refactor "silent pre/post-run emission" behaviour
	 * and prevents init-time emissions (e.g. WPT test bodies that run
	 * during Phase-4 source eval) from posting unclonable values to main.
	 *
	 * For `type: "open"`, mints a per-run-unique callId from the local
	 * counter and rewrites to wire shape `{ open: <id> }`. For `"leaf"`
	 * and `{ close }`, the SDK-input shape passes through unchanged.
	 * Returns the assigned CallId for opens (so the SDK caller can
	 * capture it for a future close); returns 0 for leaves, closes, and
	 * out-of-window calls (callers ignore the return value in those cases).
	 */
	buildEvent(
		kind: string,
		name: string,
		framing: EmitFraming,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): number;
	emit(event: WireEvent): void;
	setSink(sink: EventSink | null): void;
	resetAnchor(): void;
	anchorNs(): bigint;
	tsUs(): number;
	// Re-point the bridge at a new VM after a snapshot restore. Resets per-run
	// state (runActive, seq, refStack); preserves sink + anchor so plugin
	// lifecycle hooks (which closed over this bridge at boot via
	// PluginContext) keep emitting against the live VM. Without this, the
	// bridge's marshal closures would still hold the disposed VM and
	// onBeforeRunStarted/onRunFinished emissions would silently no-op on
	// every run after the first — see openspec note re. trigger.request
	// missing on second-and-later runs.
	rebind(newVm: QuickJS): void;
	/**
	 * Wraps a guest-side function handle as a host-side Callable. The
	 * underlying handle is `.dup()`d so the Callable outlives the synchronous
	 * call that captured it (timer callbacks, SDK dispatchers, any deferred-
	 * invocation surface need this lifetime extension).
	 *
	 * Re-entry-safe disposal: a Callable may be invoked from inside its own
	 * guest frame (e.g. `let id = setInterval(() => clearInterval(id), 0)`).
	 * Releasing `dup` while it is on the WASM stack would trigger
	 * `RuntimeError: memory access out of bounds` when QuickJS unwinds back
	 * through the freed handle. `dispose()` while invocation depth > 0 marks
	 * the Callable for deferred release; the underlying `dup.dispose()` runs
	 * once the outermost frame unwinds. `dispose()` is idempotent.
	 *
	 * If `descriptorName` is provided, the Callable is also entered into
	 * the per-bridge live-Callable registry consulted by
	 * `drainCallableLeaks`. Tests that don't care about the leak audit can
	 * omit it.
	 */
	makeCallable(handle: JSValueHandle, descriptorName?: string): Callable;
	/**
	 * Install a guest-function descriptor as a host callback on the current
	 * VM's globalThis. The trampoline closure unmarshalArgs → invokes
	 * descriptor.handler → marshalResult, dispatching log events through
	 * the bridge's internal `PluginContext` (built once at factory time over
	 * `self`) per descriptor.log.
	 */
	installDescriptor(descriptor: GuestFunctionDescription): void;
	/**
	 * Re-register the host trampoline for a descriptor against the bridge's
	 * current VM. Called from worker.ts on the snapshot-restore rebind path
	 * after `bridge.rebind(newVm)`.
	 */
	rebindDescriptor(descriptor: GuestFunctionDescription): void;
	/**
	 * Snapshot live Callables and clear the registry. Returned in insertion
	 * order. Caller (worker.ts `runLifecycleAfter`) is responsible for
	 * logging each entry and calling `.dispose()` on the survivors.
	 */
	drainCallableLeaks(): readonly CallableLeak[];
	/**
	 * Marshal a host JS value into a VM handle. Wraps quickjs-wasi's
	 * `vm.hostToHandle` so top-level Promise values can resolve safely after
	 * the VM has been disposed: the deferred's `.then` callbacks no-op on
	 * late disposal instead of triggering an unhandled rejection that would
	 * kill the worker. Non-Promise values are forwarded unchanged.
	 *
	 * Nested Promises inside object/array trees are not supported (quickjs-
	 * wasi recurses with its own unguarded `hostToHandle` callsite); a dev-
	 * mode scan asserts the invariant. Plugin authors must `await` host-side
	 * before returning data that contains a Promise.
	 */
	hostToHandle(value: unknown): JSValueHandle;
}

// --- Extractor construction ---

function makeExtractor<T>(
	extractFn: (vm: QuickJS, handle: JSValueHandle) => T,
): RequiredExtractor<T> {
	const optional: OptionalExtractor<T> = { kind: "optional", extractFn };
	const rest: RestExtractor<T> = { kind: "rest", extractFn };
	return { kind: "required", extractFn, optional, rest };
}

const ARG_EXTRACTORS = {
	string: makeExtractor<string>((_vm, h) => h.toString()),
	number: makeExtractor<number>((_vm, h) => h.toNumber()),
	json: makeExtractor<unknown>((vm, h) => vm.dump(h)),
	boolean: makeExtractor<unknown>((vm, h) => vm.dump(h)),
};

// --- Marshal helpers (private; closed over currentVm via bridge methods) ---

function classify(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

// Table-driven kind → type-test mapping. Returns the JS type-of string
// that satisfies the ArgSpec kind, or null when the kind is not a simple
// type check (raw accepts anything; callable is deferred).
const PRIMITIVE_KIND_TO_JS_TYPE: Record<string, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	object: "object",
	array: "array",
};

function assertMatchesKind(
	descriptorName: string,
	idx: number,
	kind: ArgSpec<unknown>["kind"],
	value: unknown,
): void {
	const received = classify(value);
	if (kind === "raw" || kind === "callable") {
		// callable args are dispatched via the handle path in unmarshalArgs
		// and don't reach this dumped-value check; raw accepts anything.
		return;
	}
	const expected = PRIMITIVE_KIND_TO_JS_TYPE[kind];
	if (expected === undefined) {
		throw new GuestValidationError(descriptorName, "unknown arg kind");
	}
	if (received !== expected) {
		throw new GuestArgTypeMismatchError(
			descriptorName,
			idx,
			expected,
			received,
		);
	}
}

// quickjs-wasi's `hostToHandle` is unguarded against late VM disposal when
// `value instanceof Promise`: it installs `.then(r => deferred.resolve(
// vm.hostToHandle(r)))` callbacks that fire as microtasks at promise-
// resolution time. If the VM is disposed between the call and the resolve,
// `assertNotDisposed` throws inside the .then body, surfaces as an
// unhandled rejection, and kills the worker (observed under WPT idlharness
// concurrency, where a host fetch resolves after the run's snapshot
// restore has already disposed the outgoing VM).
//
// `safeHostToHandle` wraps the upstream API so the deferred-resolution
// path no-ops on disposal. For non-Promise values we forward straight
// through. Nested Promises inside object/array trees are not supported
// (quickjs-wasi recurses with its own unguarded callsite); a dev-mode
// scan asserts the invariant so a future plugin author hits a hard error
// instead of silently re-opening the race.
// Bounded recursion depth for the nested-Promise scan. Plugin-shaped
// payloads (fetch responses, sql rows, mail send args) are shallow; 8
// covers any realistic envelope without risking a runaway walk on
// pathological inputs.
const NESTED_PROMISE_SCAN_MAX_DEPTH = 8;

function assertNoNestedPromise(value: unknown, depth: number): void {
	if (
		depth > NESTED_PROMISE_SCAN_MAX_DEPTH ||
		value === null ||
		value === undefined
	) {
		return;
	}
	if (value instanceof Promise) {
		throw new Error(
			"safeHostToHandle: nested Promise not supported; await host-side before marshalling",
		);
	}
	if (Array.isArray(value)) {
		for (const v of value) {
			assertNoNestedPromise(v, depth + 1);
		}
		return;
	}
	if (typeof value !== "object") {
		return;
	}
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return;
	}
	for (const v of Object.values(value as Record<string, unknown>)) {
		assertNoNestedPromise(v, depth + 1);
	}
}

function safeHostToHandle(vm: QuickJS, value: unknown): JSValueHandle {
	if (value instanceof Promise) {
		const deferred = vm.newPromise();
		value.then(
			(r) => {
				try {
					deferred.resolve(safeHostToHandle(vm, r));
					vm.executePendingJobs();
				} catch {
					// Late VM disposal between marshal and resolve. Guest is gone;
					// silently drop.
				}
			},
			(err) => {
				try {
					deferred.reject(safeHostToHandle(vm, err));
					vm.executePendingJobs();
				} catch {
					// Late VM disposal between marshal and reject; silently drop.
				}
			},
		);
		return deferred.handle;
	}
	assertNoNestedPromise(value, 0);
	return vm.hostToHandle(value);
}

// quickjs-wasi's `vm.hostToHandle` returns shared singletons for null,
// undefined, true, and false — the same JSValueHandle instance the VM uses
// everywhere. Disposing one of those singletons decrements the shared
// refcount and corrupts subsequent use. Always dup singletons so the caller
// owns an independent handle whose dispose only affects the dup.
function marshalArg(vm: QuickJS, value: unknown): JSValueHandle {
	const handle = safeHostToHandle(vm, value);
	if (
		value === null ||
		value === undefined ||
		value === true ||
		value === false
	) {
		return handle.dup();
	}
	return handle;
}

/**
 * Construct a `{ ok: true, value }` envelope. Brand attached via
 * `Object.defineProperty` so it is non-enumerable (defaults to writable /
 * configurable / enumerable all `false`) — keeps the envelope clone-clean
 * for `JSON.stringify` and `structuredClone`.
 */
function makeOkEnvelope(value: GuestValue): CallableResult {
	const env: CallableResult = { ok: true, value };
	Object.defineProperty(env, CALLABLE_RESULT_BRAND, { value: true });
	return env;
}

/**
 * Construct a `{ ok: false, error }` envelope carrying the live
 * `GuestThrownError` instance. The bridge closure rule's pass-through
 * branch (R-12, F-2) handles `GuestThrownError` instances thrown from
 * Pattern-2 (explicit-await) callers; wire serialisation to a plain
 * payload happens at `pluginRequest`'s emission boundary.
 */
function makeErrEnvelope(error: GuestThrownError): CallableResult {
	const env: CallableResult = { ok: false, error };
	Object.defineProperty(env, CALLABLE_RESULT_BRAND, { value: true });
	return env;
}

/**
 * Sync invocation of a guest function via `vm.callFunction`. Surfaces a
 * guest-side `JSException` as a `GuestThrownError` (carrying the original
 * `.name` / `.message` / guest `.stack` verbatim) so the caller can route
 * the failure into the appropriate channel. `Callable.invoke` consumes
 * this rejection and re-shapes it into a `CallableResult` error envelope
 * (Guest→host boundary opacity); other (non-Callable) callers, if any,
 * see the rethrown `GuestThrownError` and route via the bridge closure
 * rule (sanitizeForGuest).
 */
function callGuestFn(
	vm: QuickJS,
	handle: JSValueHandle,
	argHandles: readonly JSValueHandle[],
): JSValueHandle {
	try {
		return vm.callFunction(handle, vm.undefined, ...argHandles);
	} catch (err) {
		if (err instanceof JSException) {
			const message = err.message || "guest function threw";
			const innerName =
				typeof (err as { name?: unknown }).name === "string"
					? (err as { name: string }).name
					: "Error";
			const stack = err.stack ?? "";
			err.dispose();
			const rethrown = new GuestThrownError(message);
			rethrown.name = innerName;
			if (stack) {
				rethrown.stack = stack;
			}
			throw rethrown;
		}
		throw err;
	}
}

async function awaitGuestResult(
	vm: QuickJS,
	retHandle: JSValueHandle,
): Promise<GuestValue> {
	const resolved = vm.resolvePromise(retHandle);
	retHandle.dispose();
	vm.executePendingJobs();
	const outcome = await resolved;
	if ("error" in outcome) {
		const detail = vm.dump(outcome.error) as
			| { name?: string; message?: string; stack?: string }
			| undefined;
		outcome.error.dispose();
		const e = new GuestThrownError(
			detail?.message ?? "guest callable rejected",
		);
		if (typeof detail?.name === "string" && detail.name.length > 0) {
			e.name = detail.name;
		}
		if (detail?.stack !== undefined) {
			e.stack = detail.stack;
		}
		throw e;
	}
	const value = vm.dump(outcome.value) as GuestValue;
	outcome.value.dispose();
	return value;
}

/**
 * Closure rule for converting a host throw into a guest-bound error before
 * it crosses the QuickJS trampoline. See `openspec/specs/sandbox/spec.md`
 * "Host/sandbox boundary opacity for thrown errors".
 *
 *   - `GuestThrownError` → pass-through; preserve `.name` / `.message`,
 *     append a single `at <bridge:<publicName>>` frame to the existing
 *     guest stack.
 *   - `GuestSafeError` (any other subclass) → rebuild a fresh `Error`
 *     with `.name` carried over, `.message = "<publicName> failed: <inner>"`,
 *     synthetic single-frame stack, and structured own-properties copied.
 *   - Anything else → `BridgeError` catch-all with no inner detail.
 */
function sanitizeForGuest(err: unknown, publicName: string): Error {
	const bridgeFrame = `    at <bridge:${publicName}>`;
	if (err instanceof GuestThrownError) {
		const existing = err.stack ?? "";
		err.stack =
			existing.length > 0 ? `${existing}\n${bridgeFrame}` : bridgeFrame;
		return err;
	}
	if (err instanceof GuestSafeError) {
		const innerName = err.name;
		const innerMessage = err.message;
		const message = innerMessage
			? `${publicName} failed: ${innerMessage}`
			: `${publicName} failed`;
		const out = new Error(message);
		out.name = innerName;
		out.stack = `${innerName}: ${message}\n${bridgeFrame}`;
		for (const key of Object.keys(err)) {
			if (key === "name" || key === "message" || key === "stack") {
				continue;
			}
			(out as unknown as Record<string, unknown>)[key] = (
				err as unknown as Record<string, unknown>
			)[key];
		}
		return out;
	}
	const message = `${publicName} failed`;
	const out = new BridgeError(message);
	out.stack = `BridgeError: ${message}\n${bridgeFrame}`;
	return out;
}

/**
 * Idempotently extends `vm.newError` so it copies enumerable own-properties
 * of host-side `Error` instances onto the guest exception alongside
 * `name` / `message` / `stack`. Without this, dispatcher-curated structured
 * fields (`.reason`, `.kind`, `.code`, `.responseCode`, …) get dropped by
 * `quickjs-wasi`'s default `newError` and never reach the guest's
 * `try/catch` handler. Installed lazily on first descriptor install per VM;
 * the marker symbol on the VM instance ensures we wrap each VM exactly once.
 */
const NEW_ERROR_EXTENDED = Symbol.for(
	"@workflow-engine/sandbox#newErrorExtended",
);

function ensureExtendedNewError(vm: QuickJS): void {
	const carrier = vm as unknown as Record<symbol, true | undefined>;
	if (carrier[NEW_ERROR_EXTENDED] === true) {
		return;
	}
	const originalNewError = vm.newError.bind(vm);
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: enumerable-own-prop walk with a fixed skip-list (name/message/stack) and skip-marshal set (functions/symbols) plus the singleton-dispose guard mirroring the existing patch on quickjs-wasi's hostToHandle; collapsing into a helper would obscure the singleton-handle ownership rule
	const extended = (messageOrError: string | Error) => {
		const handle = originalNewError(messageOrError);
		if (typeof messageOrError === "string" || !messageOrError) {
			return handle;
		}
		const carrierObj = messageOrError as unknown as Record<string, unknown>;
		for (const key of Object.keys(carrierObj)) {
			if (key === "name" || key === "message" || key === "stack") {
				continue;
			}
			const value = carrierObj[key];
			if (typeof value === "function" || typeof value === "symbol") {
				continue;
			}
			const valHandle = vm.hostToHandle(value);
			handle.setProp(key, valHandle);
			if (
				value !== null &&
				value !== undefined &&
				value !== true &&
				value !== false
			) {
				valHandle.dispose();
			}
		}
		return handle;
	};
	(vm as unknown as { newError: typeof extended }).newError = extended;
	carrier[NEW_ERROR_EXTENDED] = true;
}

function resolveLog(descriptor: GuestFunctionDescription): LogConfig {
	return descriptor.log ?? { request: descriptor.name };
}

// --- Factory ---

interface CreateBridgeOptions {
	/**
	 * Test-only override for the internal `PluginContext` used by descriptor
	 * log auto-wrap. Production code does NOT pass this; the bridge builds
	 * its own ctx via `createPluginContext(self)`. Tests inject a
	 * `recordingContext` here to capture descriptor-trigger events without
	 * having to install a sink and translate WireEvents back to PluginContext
	 * shape.
	 */
	readonly ctxOverride?: PluginContext;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups marshal helpers, framing transformation, anchor/ts, callId minting, sink wiring, the live-Callable registry, the makeCallable + unmarshalArgs + marshalResult + installDescriptor pipeline as one cohesive VM-host boundary unit
function createBridge(
	vm: QuickJS,
	anchor: AnchorCell,
	options?: CreateBridgeOptions,
): Bridge {
	let currentVm: QuickJS = vm;
	let nextCallId = 0;
	let runActive = false;
	let sink: EventSink | null = null;
	// Map preserves insertion order so leak-audit output is deterministic.
	const liveCallables = new Map<Callable, string>();
	// Bridge-owned plugin context for descriptor log auto-wrap. Built after
	// the bridge object is assembled (`createPluginContext(bridge)` needs the
	// concrete bridge), then closed over by `buildHandler`. The non-null
	// assertion is safe because `buildHandler` is only invoked at
	// guest-callback-call time, which cannot happen before the factory
	// returns its assembled bridge.
	let internalCtx!: PluginContext;

	function resetAnchor(): void {
		anchor.ns = BigInt(Math.trunc(performance.now() * NS_PER_MS));
	}

	function tsUs(): number {
		const anchorMs = Number(anchor.ns) / NS_PER_MS;
		return Math.round((performance.now() - anchorMs) * US_PER_MS);
	}

	const marshal = {
		string: (value: string) => currentVm.newString(value),
		number: (value: number) => currentVm.newNumber(value),
		json: (value: unknown) => safeHostToHandle(currentVm, value),
		boolean: (value: unknown) => (value ? currentVm.true : currentVm.false),
		// biome-ignore lint/suspicious/noConfusingVoidType: must accept void return values from impl
		void: (_value: void) => currentVm.undefined,
	};

	function emit(event: WireEvent): void {
		if (sink) {
			sink(event);
		}
	}

	function toWireFraming(framing: EmitFraming): {
		readonly wireType: WireFraming;
		readonly assignedId: number;
	} {
		if (framing === "leaf") {
			return { wireType: "leaf", assignedId: 0 };
		}
		if (framing === "open") {
			const id = nextCallId++;
			return { wireType: { open: id }, assignedId: id };
		}
		// { close: callId } passes through unchanged on the wire.
		return { wireType: { close: framing.close }, assignedId: 0 };
	}

	function buildEvent(
		kind: string,
		name: string,
		framing: EmitFraming,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): number {
		if (!runActive) {
			return 0;
		}
		const { wireType, assignedId } = toWireFraming(framing);
		const event: WireEvent = {
			kind,
			name,
			at: new Date().toISOString(),
			ts: tsUs(),
			type: wireType,
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
		emit(event);
		return assignedId;
	}

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: closure groups dup-handle ownership, re-entry-safe disposal counters, envelope-vs-engine-bug routing, and live-Callable registry membership as one unit — splitting would shuttle the disposed/depth/pendingDispose state across helper functions
	function makeCallable(
		handle: JSValueHandle,
		descriptorName?: string,
	): Callable {
		const dup = handle.dup();
		let disposed = false;
		// Re-entry-safe disposal: see Bridge.makeCallable doc comment.
		let depth = 0;
		let pendingDispose = false;
		// On exit from any single invoke (success, envelope-error, or
		// engine-bug rejection): dispose marshalled arg handles, decrement
		// depth, and run any pendingDispose now that the outermost frame
		// has unwound. Extracted so `invoke`'s body stays focused on the
		// boundary-opacity contract; the disposal bookkeeping is mechanical.
		function invokeFinally(argHandles: readonly JSValueHandle[]): void {
			for (const h of argHandles) {
				h.dispose();
			}
			depth--;
			if (depth === 0 && pendingDispose && !disposed) {
				disposed = true;
				dup.dispose();
				liveCallables.delete(callable);
			}
		}
		const invoke = async (
			...args: readonly GuestValue[]
		): Promise<CallableResult> => {
			// Engine-side failures — fail loud (reject, do NOT envelope).
			// Disposed Callable / unmarshallable arg both signal host plugin
			// programming bugs, not guest behaviour. See
			// `openspec/specs/sandbox/spec.md` "Guest→host boundary opacity
			// (Callable envelope contract)".
			if (disposed) {
				throw new CallableDisposedError();
			}
			const argHandles = args.map((a) => marshalArg(currentVm, a));
			depth++;
			try {
				try {
					const retHandle = callGuestFn(currentVm, dup, argHandles);
					const value = await awaitGuestResult(currentVm, retHandle);
					return makeOkEnvelope(value);
				} catch (err) {
					// `callGuestFn` (sync guest throw) and `awaitGuestResult`
					// (async guest throw / promise rejection) both surface
					// `GuestThrownError`. Convert to envelope (R-13). Anything
					// else is an engine bug and keeps rejecting.
					if (err instanceof GuestThrownError) {
						return makeErrEnvelope(err);
					}
					throw err;
				}
			} finally {
				invokeFinally(argHandles);
			}
		};
		const callable = invoke as Callable;
		callable.dispose = () => {
			if (disposed || pendingDispose) {
				return;
			}
			if (depth > 0) {
				pendingDispose = true;
				return;
			}
			disposed = true;
			dup.dispose();
			liveCallables.delete(callable);
		};
		if (descriptorName !== undefined) {
			liveCallables.set(callable, descriptorName);
		}
		return callable;
	}

	function unmarshalArgs(
		descriptorName: string,
		specs: readonly ArgSpec<unknown>[],
		handles: readonly JSValueHandle[],
	): unknown[] {
		const out: unknown[] = [];
		for (let i = 0; i < specs.length; i++) {
			const spec = specs[i];
			if (spec === undefined) {
				continue;
			}
			const handle = handles[i];
			if (handle === undefined) {
				out.push(undefined);
				continue;
			}
			if (spec.kind === "callable") {
				// Callables are wrapped around the guest handle directly so the
				// underlying function can be re-invoked after the current sync
				// call returns. Plugins own disposal via callable.dispose();
				// drainCallableLeaks catches any plugin-side leak.
				out.push(makeCallable(handle, descriptorName));
				continue;
			}
			const dumped = currentVm.dump(handle);
			assertMatchesKind(descriptorName, i, spec.kind, dumped);
			out.push(dumped);
		}
		return out;
	}

	function marshalResult(
		descriptorName: string,
		spec: ResultSpec<unknown>,
		value: unknown,
	): JSValueHandle {
		switch (spec.kind) {
			case "void":
				return currentVm.undefined;
			case "string":
				if (typeof value !== "string") {
					throw new GuestValidationError(
						descriptorName,
						`result: expected string, got ${classify(value)}`,
					);
				}
				return currentVm.newString(value);
			case "number":
				if (typeof value !== "number") {
					throw new GuestValidationError(
						descriptorName,
						`result: expected number, got ${classify(value)}`,
					);
				}
				return currentVm.newNumber(value);
			case "boolean":
				if (typeof value !== "boolean") {
					throw new GuestValidationError(
						descriptorName,
						`result: expected boolean, got ${classify(value)}`,
					);
				}
				return value ? currentVm.true : currentVm.false;
			case "object":
			case "array":
			case "raw":
				// See marshalArg: singleton null/undefined/true/false from
				// hostToHandle must be duplicated before being returned to
				// QuickJS as a function result, otherwise the shared singleton
				// refcount is corrupted when QuickJS releases its hold.
				return marshalArg(currentVm, value);
			default:
				throw new GuestValidationError(descriptorName, "unknown result kind");
		}
	}

	function buildHandler(
		descriptor: GuestFunctionDescription,
	): (...handles: JSValueHandle[]) => JSValueHandle {
		const log = resolveLog(descriptor);
		const publicName = descriptor.publicName ?? descriptor.name;
		// Cast handler to a uniform unknown-arg signature — the descriptor's
		// typed ArgSpec shape is enforced by the test harness/author, not the
		// runtime, so the VM-side invocation path treats args as opaque values.
		type AnyHandler = (...args: readonly unknown[]) => unknown;
		const handler = descriptor.handler as unknown as AnyHandler;
		return (...handles) => {
			try {
				const args = unmarshalArgs(descriptor.name, descriptor.args, handles);
				const invoke = () => handler(...args);
				const eventName = descriptor.logName
					? descriptor.logName(args)
					: descriptor.name;
				const eventInput = descriptor.logInput
					? descriptor.logInput(args)
					: args;
				if ("event" in log) {
					// Single-leaf event before handler invocation; handler result is
					// NOT wrapped so caller controls event shape explicitly via
					// internalCtx.emit.
					internalCtx.emit(log.event, { name: eventName, input: eventInput });
					const raw = invoke();
					return marshalResult(descriptor.name, descriptor.result, raw);
				}
				// request-style wrap: internalCtx.request emits prefix.request/
				// response/error around the handler. For sync handlers the raw
				// value is available immediately; the async variant is handled in
				// a later PR when Promise-returning guest functions become
				// mainstream.
				const raw = internalCtx.request(
					log.request,
					{ name: eventName, input: eventInput },
					invoke,
				);
				return marshalResult(descriptor.name, descriptor.result, raw);
			} catch (err) {
				throw sanitizeForGuest(err, publicName);
			}
		};
	}

	function installDescriptor(descriptor: GuestFunctionDescription): void {
		ensureExtendedNewError(currentVm);
		const fn = currentVm.newFunction(descriptor.name, buildHandler(descriptor));
		currentVm.setProp(currentVm.global, descriptor.name, fn);
		fn.dispose();
	}

	function rebindDescriptor(descriptor: GuestFunctionDescription): void {
		ensureExtendedNewError(currentVm);
		currentVm.registerHostCallback(descriptor.name, buildHandler(descriptor));
	}

	function drainCallableLeaks(): readonly CallableLeak[] {
		const out: CallableLeak[] = [];
		for (const [callable, descriptor] of liveCallables) {
			out.push({ callable, descriptor });
		}
		liveCallables.clear();
		return out;
	}

	const bridge: Bridge = {
		arg: ARG_EXTRACTORS,
		marshal,
		setRunActive() {
			runActive = true;
		},
		clearRunActive() {
			runActive = false;
		},
		resetCallIds() {
			nextCallId = 0;
		},
		buildEvent,
		emit,
		setSink(s: EventSink | null) {
			sink = s;
		},
		resetAnchor,
		anchorNs() {
			return anchor.ns;
		},
		tsUs,
		rebind(newVm: QuickJS) {
			// Snapshot-restore VM swap. Reset per-run worker-side state:
			// runActive (gate) and the callId counter. seq/refStack live
			// on the main-thread RunSequencer and are reset there via
			// `sequencer.finish()` in the run lifecycle. The live-Callable
			// registry is NOT cleared here: the run-end audit
			// (drainCallableLeaks) runs before rebind, so the registry is
			// already empty by this point.
			currentVm = newVm;
			runActive = false;
			nextCallId = 0;
		},
		makeCallable,
		installDescriptor,
		rebindDescriptor,
		drainCallableLeaks,
		hostToHandle(value: unknown) {
			return safeHostToHandle(currentVm, value);
		},
	};
	internalCtx = options?.ctxOverride ?? createPluginContext(bridge);
	return bridge;
}

export type { Bridge, CallableLeak, EmitFraming, EventSink };
export { createBridge };
