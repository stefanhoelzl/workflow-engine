import type { EventKind, InvocationEvent } from "@workflow-engine/core";
import type { JSValueHandle, QuickJS } from "quickjs-wasi";

// --- Run context (set by worker before each run) ---

interface RunContext {
	readonly invocationId: string;
	readonly workflow: string;
	readonly workflowSha: string;
}

// --- Event sink (worker installs to forward events to main thread) ---

type EventSink = (event: InvocationEvent) => void;

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

type AnyExtractor =
	| RequiredExtractor<unknown>
	| OptionalExtractor<unknown>
	| RestExtractor<unknown>;

// --- Type inference ---

type InferArg<E> =
	E extends RequiredExtractor<infer T>
		? T
		: E extends OptionalExtractor<infer T>
			? T | undefined
			: E extends RestExtractor<infer T>
				? T[]
				: never;

type InferArgs<E extends readonly AnyExtractor[]> = E extends readonly [
	...infer Init extends AnyExtractor[],
	RestExtractor<infer T>,
]
	? [...{ [K in keyof Init]: InferArg<Init[K]> }, ...T[]]
	: { [K in keyof E]: InferArg<E[K]> };

// --- Bridge interface ---

interface Bridge {
	readonly vm: QuickJS;
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
	sync<Args extends readonly AnyExtractor[], R>(
		target: JSValueHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => JSValueHandle;
			impl: (...args: InferArgs<Args>) => R;
			method?: string;
		},
	): void;
	async<Args extends readonly AnyExtractor[], R>(
		target: JSValueHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => JSValueHandle;
			impl: (...args: InferArgs<Args>) => Promise<R>;
			method?: string;
		},
	): void;
	// Run-context lifecycle:
	setRunContext(ctx: RunContext): void;
	clearRunContext(): void;
	resetSeq(): void;
	nextSeq(): number;
	currentRef(): number | null;
	pushRef(seq: number): void;
	popRef(): number | null;
	getRunContext(): RunContext | null;
	buildEvent(
		kind: EventKind,
		seq: number,
		ref: number | null,
		name: string,
		extra: { input?: unknown; output?: unknown; error?: unknown },
	): InvocationEvent | null;
	emit(event: InvocationEvent): void;
	setSink(sink: EventSink | null): void;
	dispose(): void;
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

function extractArgValues(
	vm: QuickJS,
	extractors: readonly AnyExtractor[],
	handles: JSValueHandle[],
): unknown[] {
	const result: unknown[] = [];
	for (let i = 0; i < extractors.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: index is within bounds from loop condition
		const ext = extractors[i]!;
		if (ext.kind === "rest") {
			for (let j = i; j < handles.length; j++) {
				// biome-ignore lint/style/noNonNullAssertion: index is within bounds from loop condition
				result.push(ext.extractFn(vm, handles[j]!));
			}
			break;
		}
		const handle = handles[i];
		if (ext.kind === "optional" && handle === undefined) {
			result.push(undefined);
		} else {
			// biome-ignore lint/style/noNonNullAssertion: required/optional extractor with present handle
			result.push(ext.extractFn(vm, handle!));
		}
	}
	return result;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string {
	return err instanceof Error ? (err.stack ?? "") : "";
}

const RESERVED_HOST_ERROR_KEYS = new Set(["name", "message", "stack"]);

function isJsonSafe(value: unknown): boolean {
	try {
		JSON.stringify(value);
		return true;
	} catch {
		return false;
	}
}

function newGuestErrorFromHost(vm: QuickJS, err: unknown): JSValueHandle {
	if (!(err instanceof Error)) {
		return vm.newError(String(err));
	}
	const handle = vm.newError(err);
	const source = err as unknown as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (RESERVED_HOST_ERROR_KEYS.has(key)) {
			continue;
		}
		const value = source[key];
		if (!isJsonSafe(value)) {
			continue;
		}
		const valueHandle = vm.hostToHandle(value);
		vm.setProp(handle, key, valueHandle);
		valueHandle.dispose();
	}
	return handle;
}

// --- Factory ---

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: bridge groups VM closures, sync/async wrappers, run-context state, and event emission as one cohesive unit
function createBridge(vm: QuickJS): Bridge {
	let runContext: RunContext | null = null;
	let seq = 0;
	const refStack: number[] = [];
	let sink: EventSink | null = null;

	const marshal = {
		string: (value: string) => vm.newString(value),
		number: (value: number) => vm.newNumber(value),
		json: (value: unknown) => vm.hostToHandle(value),
		boolean: (value: unknown) => (value ? vm.true : vm.false),
		// biome-ignore lint/suspicious/noConfusingVoidType: must accept void return values from impl
		void: (_value: void) => vm.undefined,
	};

	function emit(event: InvocationEvent): void {
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
	): InvocationEvent | null {
		if (!runContext) {
			return null;
		}
		const event: InvocationEvent = {
			kind,
			id: runContext.invocationId,
			seq: seqValue,
			ref,
			ts: Date.now(),
			workflow: runContext.workflow,
			workflowSha: runContext.workflowSha,
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

	function emitSystemRequest(method: string, args: unknown[]): number {
		const requestSeq = seq++;
		const ref = refStack.at(-1) ?? null;
		refStack.push(requestSeq);
		const evt = buildEvent("system.request", requestSeq, ref, method, {
			input: args,
		});
		if (evt) {
			emit(evt);
		}
		return requestSeq;
	}

	function emitSystemResponse(
		method: string,
		requestSeq: number,
		result: unknown,
	): void {
		const responseSeq = seq++;
		// Pop the matching request from the stack.
		const popped = refStack.pop();
		const ref = popped ?? requestSeq;
		const evt = buildEvent("system.response", responseSeq, ref, method, {
			output: result,
		});
		if (evt) {
			emit(evt);
		}
	}

	function emitSystemError(
		method: string,
		requestSeq: number,
		err: unknown,
	): void {
		const errorSeq = seq++;
		const popped = refStack.pop();
		const ref = popped ?? requestSeq;
		const evt = buildEvent("system.error", errorSeq, ref, method, {
			error: {
				message: errorMessage(err),
				stack: errorStack(err),
			},
		});
		if (evt) {
			emit(evt);
		}
	}

	function sync<Args extends readonly AnyExtractor[], R>(
		target: JSValueHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => JSValueHandle;
			impl: (...args: InferArgs<Args>) => R;
			method?: string;
		},
	): void {
		const method = opts.method ?? name;
		const fn = vm.newFunction(name, (...handles) => {
			const extracted = extractArgValues(vm, opts.args, handles);
			const requestSeq = emitSystemRequest(method, extracted);
			try {
				const result = opts.impl(...(extracted as InferArgs<Args>));
				emitSystemResponse(method, requestSeq, result);
				return opts.marshal(result);
			} catch (err) {
				emitSystemError(method, requestSeq, err);
				// newFunction's trampoline catches thrown host errors and
				// converts them to QuickJS exceptions via vm.newError() —
				// that preserves name/message/stack but strips custom props
				// (e.g. Zod .issues). For sync bridges this is acceptable
				// because the run loop primarily reports error.message and
				// error.stack. Async bridges (the common path) preserve
				// custom props via deferred.reject(newGuestErrorFromHost(...)).
				throw err;
			}
		});
		vm.setProp(target, name, fn);
		fn.dispose();
	}

	function asyncBridge<Args extends readonly AnyExtractor[], R>(
		target: JSValueHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => JSValueHandle;
			impl: (...args: InferArgs<Args>) => Promise<R>;
			method?: string;
		},
	): void {
		const method = opts.method ?? name;
		const fn = vm.newFunction(name, (...handles) => {
			const extracted = extractArgValues(vm, opts.args, handles);
			const requestSeq = emitSystemRequest(method, extracted);
			const deferred = vm.newPromise();

			opts.impl(...(extracted as InferArgs<Args>)).then(
				(result) => {
					try {
						const handle = opts.marshal(result);
						deferred.resolve(handle);
						handle.dispose();
						emitSystemResponse(method, requestSeq, result);
					} catch (err) {
						const errHandle = newGuestErrorFromHost(vm, err);
						deferred.reject(errHandle);
						errHandle.dispose();
						emitSystemError(method, requestSeq, err);
					}
					vm.executePendingJobs();
				},
				(err) => {
					const errHandle = newGuestErrorFromHost(vm, err);
					deferred.reject(errHandle);
					errHandle.dispose();
					emitSystemError(method, requestSeq, err);
					vm.executePendingJobs();
				},
			);

			return deferred.handle;
		});
		vm.setProp(target, name, fn);
		fn.dispose();
	}

	return {
		vm,
		arg: ARG_EXTRACTORS,
		marshal,
		sync,
		async: asyncBridge,
		setRunContext(ctx: RunContext) {
			runContext = ctx;
			seq = 0;
			refStack.length = 0;
		},
		clearRunContext() {
			runContext = null;
			seq = 0;
			refStack.length = 0;
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
		getRunContext() {
			return runContext;
		},
		buildEvent,
		emit,
		setSink(s: EventSink | null) {
			sink = s;
		},
		dispose() {
			/* nothing to release — keys live in WASM, not on the host */
		},
	};
}

export type { Bridge, EventSink, RunContext };
export { createBridge };
