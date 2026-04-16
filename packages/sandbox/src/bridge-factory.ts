import type { EventKind, InvocationEvent } from "@workflow-engine/core";
import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
} from "quickjs-emscripten";

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
	readonly extractFn: (vm: QuickJSContext, handle: QuickJSHandle) => T;
	readonly optional: OptionalExtractor<T>;
	readonly rest: RestExtractor<T>;
}

interface OptionalExtractor<T> {
	readonly kind: "optional";
	readonly extractFn: (vm: QuickJSContext, handle: QuickJSHandle) => T;
}

interface RestExtractor<T> {
	readonly kind: "rest";
	readonly extractFn: (vm: QuickJSContext, handle: QuickJSHandle) => T;
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
	readonly vm: QuickJSContext;
	readonly runtime: QuickJSRuntime;
	readonly arg: {
		readonly string: RequiredExtractor<string>;
		readonly number: RequiredExtractor<number>;
		readonly json: RequiredExtractor<unknown>;
		readonly boolean: RequiredExtractor<unknown>;
	};
	readonly marshal: {
		readonly string: (value: string) => QuickJSHandle;
		readonly number: (value: number) => QuickJSHandle;
		readonly json: (value: unknown) => QuickJSHandle;
		readonly boolean: (value: unknown) => QuickJSHandle;
		// biome-ignore lint/suspicious/noConfusingVoidType: void marshal must accept void return values from impl
		readonly void: (value: void) => QuickJSHandle;
	};
	sync<Args extends readonly AnyExtractor[], R>(
		target: QuickJSHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => QuickJSHandle;
			impl: (...args: InferArgs<Args>) => R;
			method?: string;
		},
	): void;
	async<Args extends readonly AnyExtractor[], R>(
		target: QuickJSHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => QuickJSHandle;
			impl: (...args: InferArgs<Args>) => Promise<R>;
			method?: string;
		},
	): void;
	storeOpaque(value: unknown): number;
	derefOpaque<T>(ref: unknown): T;
	opaqueRef: (value: unknown) => QuickJSHandle;
	// Run-context lifecycle:
	setRunContext(ctx: RunContext): void;
	clearRunContext(): void;
	resetSeq(): void;
	nextSeq(): number;
	currentRef(): number | null;
	pushRef(seq: number): void;
	popRef(): number | null;
	getRunContext(): RunContext | null;
	emit(event: InvocationEvent): void;
	setSink(sink: EventSink | null): void;
	dispose(): void;
}

// --- Extractor construction ---

function makeExtractor<T>(
	extractFn: (vm: QuickJSContext, handle: QuickJSHandle) => T,
): RequiredExtractor<T> {
	const optional: OptionalExtractor<T> = { kind: "optional", extractFn };
	const rest: RestExtractor<T> = { kind: "rest", extractFn };
	return { kind: "required", extractFn, optional, rest };
}

const ARG_EXTRACTORS = {
	string: makeExtractor<string>((vm, h) => vm.getString(h)),
	number: makeExtractor<number>((vm, h) => vm.getNumber(h)),
	json: makeExtractor<unknown>((vm, h) => vm.dump(h)),
	boolean: makeExtractor<unknown>((vm, h) => vm.dump(h)),
};

function extractArgValues(
	vm: QuickJSContext,
	extractors: readonly AnyExtractor[],
	handles: QuickJSHandle[],
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

function newGuestErrorFromHost(
	vm: QuickJSContext,
	err: unknown,
): QuickJSHandle {
	const message = errorMessage(err);
	if (!(err instanceof Error)) {
		return vm.newError({ name: "Error", message });
	}
	const handle = vm.newError({ name: err.name, message });
	if (err.stack) {
		const stackHandle = vm.newString(err.stack);
		vm.setProp(handle, "stack", stackHandle);
		stackHandle.dispose();
	}
	const source = err as unknown as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (RESERVED_HOST_ERROR_KEYS.has(key)) {
			continue;
		}
		const value = source[key];
		if (!isJsonSafe(value)) {
			continue;
		}
		const result = vm.evalCode(`(${JSON.stringify(value)})`);
		if (result.error) {
			result.error.dispose();
			continue;
		}
		vm.setProp(handle, key, result.value);
		result.value.dispose();
	}
	return handle;
}

// --- Factory ---

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: bridge groups VM closures, sync/async wrappers, run-context state, and event emission as one cohesive unit
function createBridge(vm: QuickJSContext, runtime: QuickJSRuntime): Bridge {
	const opaqueStore = new Map<number, unknown>();
	let opaqueNextId = 1;

	let runContext: RunContext | null = null;
	let seq = 0;
	const refStack: number[] = [];
	let sink: EventSink | null = null;

	const marshal = {
		string: (value: string) => vm.newString(value),
		number: (value: number) => vm.newNumber(value),
		json: (value: unknown) => {
			const result = vm.evalCode(`(${JSON.stringify(value)})`);
			if (result.error) {
				result.error.dispose();
				throw new Error("Failed to marshal JSON value");
			}
			return result.value;
		},
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
	function buildSystemEvent(
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
		const evt = buildSystemEvent("system.request", requestSeq, ref, method, {
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
		const evt = buildSystemEvent("system.response", responseSeq, ref, method, {
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
		const evt = buildSystemEvent("system.error", errorSeq, ref, method, {
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
		target: QuickJSHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => QuickJSHandle;
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
				return { error: newGuestErrorFromHost(vm, err) };
			}
		});
		vm.setProp(target, name, fn);
		fn.dispose();
	}

	function asyncBridge<Args extends readonly AnyExtractor[], R>(
		target: QuickJSHandle,
		name: string,
		opts: {
			args: [...Args];
			marshal: (value: R) => QuickJSHandle;
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
					runtime.executePendingJobs();
				},
				(err) => {
					const errHandle = newGuestErrorFromHost(vm, err);
					deferred.reject(errHandle);
					errHandle.dispose();
					emitSystemError(method, requestSeq, err);
					runtime.executePendingJobs();
				},
			);

			return deferred.handle;
		});
		vm.setProp(target, name, fn);
		fn.dispose();
	}

	function storeOpaque(value: unknown): number {
		const id = opaqueNextId++;
		opaqueStore.set(id, value);
		return id;
	}

	function derefOpaque<T>(ref: unknown): T {
		const id =
			typeof ref === "number"
				? ref
				: (ref as { __opaqueId: number } | null)?.__opaqueId;
		if (typeof id !== "number") {
			throw new Error("Invalid opaque reference");
		}
		const stored = opaqueStore.get(id);
		if (stored === undefined) {
			throw new Error(`Opaque reference ${id} not found`);
		}
		return stored as T;
	}

	return {
		vm,
		runtime,
		arg: ARG_EXTRACTORS,
		marshal,
		sync,
		async: asyncBridge,
		storeOpaque,
		derefOpaque,
		opaqueRef: (value: unknown) => vm.newNumber(storeOpaque(value)),
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
		emit,
		setSink(s: EventSink | null) {
			sink = s;
		},
		dispose() {
			opaqueStore.clear();
		},
	};
}

export type { Bridge, EventSink, RunContext };
export { createBridge };
