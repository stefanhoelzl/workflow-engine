import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
} from "quickjs-emscripten";

interface LogEntry {
	method: string;
	args: unknown[];
	status: "ok" | "failed";
	result?: unknown;
	error?: string;
	ts: number;
	durationMs?: number | undefined;
}

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
	readonly logs: readonly LogEntry[];
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
	pushLog(entry: LogEntry): void;
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

// --- Factory ---

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: sync/async bridge closures share vm, runtime, and logs state
function createBridge(vm: QuickJSContext, runtime: QuickJSRuntime): Bridge {
	const logs: LogEntry[] = [];
	const opaqueStore = new Map<number, unknown>();
	let opaqueNextId = 1;

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
			const ts = Date.now();
			const start = performance.now();
			try {
				const result = opts.impl(...(extracted as InferArgs<Args>));
				const durationMs = Math.round(performance.now() - start);
				logs.push({
					method,
					args: extracted,
					status: "ok",
					result,
					ts,
					durationMs,
				});
				return opts.marshal(result);
			} catch (err) {
				const durationMs = Math.round(performance.now() - start);
				const msg = errorMessage(err);
				logs.push({
					method,
					args: extracted,
					status: "failed",
					error: msg,
					ts,
					durationMs,
				});
				return { error: vm.newError(msg) };
			}
		});
		vm.setProp(target, name, fn);
		fn.dispose();
	}

	function rejectDeferred(
		deferred: { reject(handle: QuickJSHandle): void },
		err: unknown,
		entry: Omit<LogEntry, "status" | "error">,
	): void {
		const msg = errorMessage(err);
		const errHandle = vm.newError(msg);
		deferred.reject(errHandle);
		errHandle.dispose();
		logs.push({ ...entry, status: "failed", error: msg });
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
			const deferred = vm.newPromise();
			const ts = Date.now();
			const start = performance.now();

			opts.impl(...(extracted as InferArgs<Args>)).then(
				(result) => {
					const durationMs = Math.round(performance.now() - start);
					try {
						const handle = opts.marshal(result);
						deferred.resolve(handle);
						handle.dispose();
						logs.push({
							method,
							args: extracted,
							status: "ok",
							result,
							ts,
							durationMs,
						});
					} catch (err) {
						rejectDeferred(deferred, err, {
							method,
							args: extracted,
							ts,
							durationMs,
						});
					}
					runtime.executePendingJobs();
				},
				(err) => {
					const durationMs = Math.round(performance.now() - start);
					rejectDeferred(deferred, err, {
						method,
						args: extracted,
						ts,
						durationMs,
					});
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
		get logs() {
			return logs as readonly LogEntry[];
		},
		arg: ARG_EXTRACTORS,
		marshal,
		sync,
		async: asyncBridge,
		storeOpaque,
		derefOpaque,
		opaqueRef: (value: unknown) => vm.newNumber(storeOpaque(value)),
		pushLog(entry: LogEntry) {
			logs.push(entry);
		},
		dispose() {
			opaqueStore.clear();
		},
	};
}

export { createBridge };
export type { Bridge, LogEntry };
