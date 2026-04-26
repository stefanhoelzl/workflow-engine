import { performance } from "node:perf_hooks";
import type { EventKind, SandboxEvent } from "@workflow-engine/core";
import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import type { AnchorCell } from "./wasi.js";

const NS_PER_MS = 1_000_000;
const US_PER_MS = 1000;

// --- Event sink (worker installs to forward events to main thread) ---

type EventSink = (event: SandboxEvent) => void;

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

// The bridge emits `SandboxEvent` — the subset of event fields the sandbox
// owns (`kind`, `seq`, `ref`, `at`, `ts`, `name`, `input`/`output`/`error`).
// Runtime metadata (`id`, `owner`, `workflow`, `workflowSha`) is added by
// the runtime's `sb.onEvent` receiver in the executor before events reach
// the bus (SECURITY.md §2 R-8: no runtime metadata in sandbox).
//
// `runActive` is a boolean gate — `buildEvent` returns null when no run
// is in progress, matching the pre-refactor "silent pre-run emission"
// behaviour without requiring the bridge to know about run metadata.

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
	// Run-active lifecycle (boolean state, no metadata):
	setRunActive(): void;
	clearRunActive(): void;
	runActive(): boolean;
	resetSeq(): void;
	nextSeq(): number;
	currentRef(): number | null;
	pushRef(seq: number): void;
	popRef(): number | null;
	refStackDepth(): number;
	truncateRefStackTo(depth: number): number;
	buildEvent(
		kind: EventKind,
		seq: number,
		ref: number | null,
		name: string,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): SandboxEvent | null;
	emit(event: SandboxEvent): void;
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: bridge groups VM closures, sync/async wrappers, run-active state, and event emission as one cohesive unit
function createBridge(vm: QuickJS, anchor: AnchorCell): Bridge {
	let currentVm: QuickJS = vm;
	let runActive = false;
	let seq = 0;
	const refStack: number[] = [];
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

	function emit(event: SandboxEvent): void {
		if (sink) {
			sink(event);
		}
	}

	// biome-ignore lint/complexity/useMaxParams: pure constructor for the event payload — collapsing into an options object would just add boilerplate
	function buildEvent(
		kind: EventKind,
		seqValue: number,
		ref: number | null,
		method: string,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): SandboxEvent | null {
		if (!runActive) {
			return null;
		}
		const event: SandboxEvent = {
			kind,
			seq: seqValue,
			ref,
			at: new Date().toISOString(),
			ts: tsUs(),
			name: method,
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
		return event;
	}

	return {
		arg: ARG_EXTRACTORS,
		marshal,
		setRunActive() {
			runActive = true;
			seq = 0;
			refStack.length = 0;
		},
		clearRunActive() {
			runActive = false;
			seq = 0;
			refStack.length = 0;
		},
		runActive() {
			return runActive;
		},
		resetSeq() {
			seq = 0;
			refStack.length = 0;
		},
		nextSeq() {
			return seq++;
		},
		currentRef() {
			return refStack.at(-1) ?? null;
		},
		pushRef(s: number) {
			refStack.push(s);
		},
		popRef() {
			return refStack.pop() ?? null;
		},
		refStackDepth() {
			return refStack.length;
		},
		truncateRefStackTo(depth: number) {
			if (depth < 0 || depth > refStack.length) {
				return 0;
			}
			const dropped = refStack.length - depth;
			refStack.length = depth;
			return dropped;
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
			currentVm = newVm;
			runActive = false;
			seq = 0;
			refStack.length = 0;
		},
	};
}

export type { Bridge, EventSink };
export { createBridge };
