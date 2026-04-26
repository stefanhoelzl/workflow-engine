import { performance } from "node:perf_hooks";
import type { JSValueHandle, QuickJS } from "quickjs-wasi";
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

// The bridge's job is narrow: marshal/arg extractors, the WASI clock
// anchor, a per-run callId counter for SDK `type: "open"` minting, the
// event sink that posts WireEvents to main, and a runActive gate that
// suppresses emission outside an active run. seq, refStack, and ref
// attribution live on the main-thread RunSequencer (see
// `run-sequencer.ts`).
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

// --- Factory ---

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups marshal helpers, framing transformation, anchor/ts, callId minting, and sink wiring as one cohesive unit
function createBridge(vm: QuickJS, anchor: AnchorCell): Bridge {
	let currentVm: QuickJS = vm;
	let nextCallId = 0;
	let runActive = false;
	let sink: EventSink | null = null;

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
			// `sequencer.finish()` in the run lifecycle.
			currentVm = newVm;
			runActive = false;
			nextCallId = 0;
		},
	};
}

export type { Bridge, EmitFraming, EventSink };
export { createBridge };
