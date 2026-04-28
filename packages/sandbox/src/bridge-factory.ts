import { performance } from "node:perf_hooks";
import { JSException, type JSValueHandle, type QuickJS } from "quickjs-wasi";
import {
	CallableDisposedError,
	GuestArgTypeMismatchError,
	GuestValidationError,
} from "./guest-errors.js";
import type {
	Callable,
	GuestFunctionDescription,
	LogConfig,
	SandboxContext,
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
	// SandboxContext) keep emitting against the live VM. Without this, the
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
	 * `ctx.emit` or `ctx.request` per descriptor.log.
	 */
	installDescriptor(
		ctx: SandboxContext,
		descriptor: GuestFunctionDescription,
	): void;
	/**
	 * Re-register the host trampoline for a descriptor against the bridge's
	 * current VM. Called from worker.ts on the snapshot-restore rebind path
	 * after `bridge.rebind(newVm)`.
	 */
	rebindDescriptor(
		ctx: SandboxContext,
		descriptor: GuestFunctionDescription,
	): void;
	/**
	 * Snapshot live Callables and clear the registry. Returned in insertion
	 * order. Caller (worker.ts `runLifecycleAfter`) is responsible for
	 * logging each entry and calling `.dispose()` on the survivors.
	 */
	drainCallableLeaks(): readonly CallableLeak[];
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

// quickjs-wasi's `vm.hostToHandle` returns shared singletons for null,
// undefined, true, and false — the same JSValueHandle instance the VM uses
// everywhere. Disposing one of those singletons decrements the shared
// refcount and corrupts subsequent use. Always dup singletons so the caller
// owns an independent handle whose dispose only affects the dup.
function marshalArg(vm: QuickJS, value: unknown): JSValueHandle {
	const handle = vm.hostToHandle(value);
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

function callGuestFn(
	vm: QuickJS,
	handle: JSValueHandle,
	argHandles: readonly JSValueHandle[],
): JSValueHandle {
	try {
		return vm.callFunction(handle, vm.undefined, ...argHandles);
	} catch (err) {
		if (err instanceof JSException) {
			// JSException is an Error instance, not a JSValueHandle — read
			// `.message` / `.stack` directly. The prior `vm.dump(err as
			// unknown as JSValueHandle)` cast returned `undefined` and
			// masked every guest-side error with the generic fallback
			// message below.
			const message = err.message || "guest function threw";
			const stack = err.stack ?? "";
			err.dispose();
			const rethrown = new Error(message);
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
			| { message?: string; stack?: string }
			| undefined;
		outcome.error.dispose();
		const e = new Error(detail?.message ?? "guest callable rejected");
		if (detail?.stack !== undefined) {
			e.stack = detail.stack;
		}
		throw e;
	}
	const value = vm.dump(outcome.value) as GuestValue;
	outcome.value.dispose();
	return value;
}

function resolveLog(descriptor: GuestFunctionDescription): LogConfig {
	return descriptor.log ?? { request: descriptor.name };
}

// --- Factory ---

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups marshal helpers, framing transformation, anchor/ts, callId minting, sink wiring, the live-Callable registry, the makeCallable + unmarshalArgs + marshalResult + installDescriptor pipeline as one cohesive VM-host boundary unit
function createBridge(vm: QuickJS, anchor: AnchorCell): Bridge {
	let currentVm: QuickJS = vm;
	let nextCallId = 0;
	let runActive = false;
	let sink: EventSink | null = null;
	// Map preserves insertion order so leak-audit output is deterministic.
	const liveCallables = new Map<Callable, string>();

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
		json: (value: unknown) => currentVm.hostToHandle(value),
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

	function makeCallable(
		handle: JSValueHandle,
		descriptorName?: string,
	): Callable {
		const dup = handle.dup();
		let disposed = false;
		// Re-entry-safe disposal: see Bridge.makeCallable doc comment.
		let depth = 0;
		let pendingDispose = false;
		const invoke = async (
			...args: readonly GuestValue[]
		): Promise<GuestValue> => {
			if (disposed) {
				throw new CallableDisposedError();
			}
			const argHandles = args.map((a) => marshalArg(currentVm, a));
			depth++;
			try {
				const retHandle = callGuestFn(currentVm, dup, argHandles);
				return await awaitGuestResult(currentVm, retHandle);
			} finally {
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
		ctx: SandboxContext,
		descriptor: GuestFunctionDescription,
	): (...handles: JSValueHandle[]) => JSValueHandle {
		const log = resolveLog(descriptor);
		// Cast handler to a uniform unknown-arg signature — the descriptor's
		// typed ArgSpec shape is enforced by the test harness/author, not the
		// runtime, so the VM-side invocation path treats args as opaque values.
		type AnyHandler = (...args: readonly unknown[]) => unknown;
		const handler = descriptor.handler as unknown as AnyHandler;
		return (...handles) => {
			const args = unmarshalArgs(descriptor.name, descriptor.args, handles);
			const invoke = () => handler(...args);
			const eventName = descriptor.logName
				? descriptor.logName(args)
				: descriptor.name;
			const eventInput = descriptor.logInput ? descriptor.logInput(args) : args;
			if ("event" in log) {
				// Single-leaf event before handler invocation; handler result is
				// NOT wrapped so caller controls event shape explicitly via
				// ctx.emit.
				ctx.emit(log.event, { name: eventName, input: eventInput });
				const raw = invoke();
				return marshalResult(descriptor.name, descriptor.result, raw);
			}
			// request-style wrap: ctx.request emits prefix.request/response/error
			// around the handler. For sync handlers the raw value is available
			// immediately; the async variant is handled in a later PR when
			// Promise-returning guest functions become mainstream.
			const raw = ctx.request(
				log.request,
				{ name: eventName, input: eventInput },
				invoke,
			);
			return marshalResult(descriptor.name, descriptor.result, raw);
		};
	}

	function installDescriptor(
		ctx: SandboxContext,
		descriptor: GuestFunctionDescription,
	): void {
		const fn = currentVm.newFunction(
			descriptor.name,
			buildHandler(ctx, descriptor),
		);
		currentVm.setProp(currentVm.global, descriptor.name, fn);
		fn.dispose();
	}

	function rebindDescriptor(
		ctx: SandboxContext,
		descriptor: GuestFunctionDescription,
	): void {
		currentVm.registerHostCallback(
			descriptor.name,
			buildHandler(ctx, descriptor),
		);
	}

	function drainCallableLeaks(): readonly CallableLeak[] {
		const out: CallableLeak[] = [];
		for (const [callable, descriptor] of liveCallables) {
			out.push({ callable, descriptor });
		}
		liveCallables.clear();
		return out;
	}

	return {
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
	};
}

export type { Bridge, CallableLeak, EmitFraming, EventSink };
export { createBridge };
