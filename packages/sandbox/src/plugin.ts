import type { ArgSpec, GuestValue, ResultSpec } from "./plugin-types.js";

type SerializableConfig =
	| null
	| undefined
	| boolean
	| number
	| string
	| readonly SerializableConfig[]
	| { readonly [key: string]: SerializableConfig };

interface PluginDescriptor<
	Config extends SerializableConfig = SerializableConfig,
> {
	readonly name: string;
	/**
	 * Self-contained ESM module source string whose default export is the
	 * plugin's `worker(ctx, deps, config)` function. Produced at build time
	 * by `sandboxPlugins()`; the sandbox worker loads it via a `data:` URI
	 * dynamic import (no filesystem resolution, no package-exports surface).
	 */
	readonly source: string;
	readonly config?: Config;
	readonly dependsOn?: readonly string[];
}

type DepsMap = Record<string, Record<string, unknown>>;

interface Callable {
	(...args: readonly GuestValue[]): Promise<GuestValue>;
	dispose(): void;
}

type EventKind = string;

interface EventExtra {
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: unknown;
}

interface EmitOptions {
	readonly createsFrame?: boolean;
	readonly closesFrame?: boolean;
}

interface SandboxContext {
	emit(
		kind: EventKind,
		name: string,
		extra: EventExtra,
		options?: EmitOptions,
	): void;
	request<T>(
		prefix: string,
		name: string,
		extra: { readonly input?: unknown },
		fn: () => T | Promise<T>,
	): T | Promise<T>;
}

type LogConfig = { readonly event: string } | { readonly request: string };

interface GuestFunctionDescription<
	Args extends readonly ArgSpec<unknown>[] = readonly ArgSpec<unknown>[],
	Result extends ResultSpec<unknown> = ResultSpec<unknown>,
> {
	readonly name: string;
	readonly args: Args;
	readonly result: Result;
	readonly handler: GuestFunctionHandler<Args, Result>;
	readonly log?: LogConfig;
	readonly public?: boolean;
	/**
	 * Override the event `name` field emitted by the log auto-wrap. Receives
	 * the unmarshaled host-side args (Callables preserved) and returns the
	 * string to stamp on `emit()`/`request()`. Defaults to `descriptor.name`.
	 *
	 * Primary use case: a private dispatcher (e.g. `__sdkDispatchAction`) whose
	 * emitted events should be labelled with a domain name pulled from the
	 * args (e.g. the action name passed from the guest) rather than the
	 * bridge-internal descriptor name.
	 */
	readonly logName?: (args: readonly unknown[]) => string;
	/**
	 * Override the `input` carried on the log auto-wrap emission. Defaults to
	 * the full args tuple. Useful when some args are Callables (which cannot
	 * cross the worker postMessage boundary intact) or when a subset of args
	 * represents the semantic payload.
	 */
	readonly logInput?: (args: readonly unknown[]) => unknown;
}

type GuestFunctionHandler<
	Args extends readonly ArgSpec<unknown>[],
	Result extends ResultSpec<unknown>,
> = (
	...args: ArgTupleFromSpec<Args>
) => ResultValueFromSpec<Result> | Promise<ResultValueFromSpec<Result>>;

type ArgTupleFromSpec<Args extends readonly ArgSpec<unknown>[]> = {
	readonly [K in keyof Args]: Args[K] extends ArgSpec<infer T> ? T : never;
};

type ResultValueFromSpec<Result extends ResultSpec<unknown>> =
	Result extends ResultSpec<infer T> ? T : never;

interface WasiClockArgs {
	readonly label: "REALTIME" | "MONOTONIC";
	readonly defaultNs: number;
}

interface WasiClockResult {
	readonly ns?: number;
}

interface WasiRandomArgs {
	readonly bufLen: number;
	readonly defaultBytes: Uint8Array;
}

interface WasiRandomResult {
	readonly bytes?: Uint8Array;
}

interface WasiFdWriteArgs {
	readonly fd: number;
	readonly text: string;
}

interface WasiHooks {
	readonly clockTimeGet?: (args: WasiClockArgs) => WasiClockResult | undefined;
	readonly randomGet?: (args: WasiRandomArgs) => WasiRandomResult | undefined;
	readonly fdWrite?: (args: WasiFdWriteArgs) => void;
}

interface RunInput {
	readonly name: string;
	readonly input: unknown;
}

type RunResult =
	| { readonly ok: true; readonly output: unknown }
	| { readonly ok: false; readonly error: unknown };

interface PluginSetup {
	readonly source?: string;
	readonly exports?: Record<string, unknown>;
	readonly guestFunctions?: readonly GuestFunctionDescription<
		readonly ArgSpec<unknown>[],
		ResultSpec<unknown>
	>[];
	readonly wasiHooks?: WasiHooks;
	readonly onBeforeRunStarted?: (runInput: RunInput) => boolean | undefined;
	readonly onRunFinished?: (result: RunResult, runInput: RunInput) => void;
}

interface Plugin<Config extends SerializableConfig = SerializableConfig> {
	readonly name: string;
	readonly dependsOn?: readonly string[];
	worker(
		ctx: SandboxContext,
		deps: DepsMap,
		config: Config,
	): PluginSetup | undefined | Promise<PluginSetup | undefined>;
}

export type {
	Callable,
	DepsMap,
	EmitOptions,
	EventExtra,
	EventKind,
	GuestFunctionDescription,
	GuestFunctionHandler,
	LogConfig,
	Plugin,
	PluginDescriptor,
	PluginSetup,
	RunInput,
	RunResult,
	SandboxContext,
	SerializableConfig,
	WasiClockArgs,
	WasiClockResult,
	WasiFdWriteArgs,
	WasiHooks,
	WasiRandomArgs,
	WasiRandomResult,
};
