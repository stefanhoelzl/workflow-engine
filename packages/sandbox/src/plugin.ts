import type { InvocationEventError } from "@workflow-engine/core";
import type { Bridge } from "./bridge.js";
import { enterPendingCallable, exitPendingCallable } from "./limit-counters.js";
import type { ArgSpec, GuestValue, ResultSpec } from "./plugin-types.js";
import type { WorkerToMain } from "./protocol.js";

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
	readonly workerSource: string;
	/**
	 * Optional self-contained IIFE source string, evaluated as a top-level
	 * guest script inside the QuickJS VM at plugin boot Phase 2. Produced at
	 * build time by `sandboxPlugins()` when the plugin source file exports
	 * a `guest(): void` function; omitted when the file has no `guest`
	 * export. See SECURITY.md §2 R-1 / R-5.
	 */
	readonly guestSource?: string;
	readonly config?: Config;
	readonly dependsOn?: readonly string[];
}

type DepsMap = Record<string, Record<string, unknown>>;

interface Callable {
	(...args: readonly GuestValue[]): Promise<GuestValue>;
	dispose(): void;
}

type EventKind = string;

/** Worker-local pairing token. Minted by the bridge for `type: "open"`,
 * echoed by the SDK caller on `type: { close: callId }`. Not visible at the
 * Sandbox-Executor boundary. */
type CallId = number;

/**
 * SDK-input framing discriminator. Callers pass this on `ctx.emit` via
 * `options.type`. The bridge transforms `"open"` into wire `{ open: <id> }`
 * by minting a CallId from its per-run counter; `"leaf"` and `{ close }`
 * pass through unchanged on the wire (asymmetric SDK-input vs wire types).
 */
type EmitFraming = "leaf" | "open" | { readonly close: CallId };

interface EmitOptions {
	readonly name: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: InvocationEventError;
	/** Defaults to `"leaf"` when omitted. */
	readonly type?: EmitFraming;
}

interface RequestOptions {
	readonly name: string;
	readonly input?: unknown;
}

/**
 * Conditional return type for `PluginContext.emit`. The bridge only mints a
 * CallId on `type: "open"`; for leaves and closes there is no meaningful id
 * to return. Encoding that in the type means a caller writing
 * `const x = ctx.emit(k, {name})` against a leaf is a compile error rather
 * than a latent footgun (the runtime would otherwise return 0, which
 * collides with the first minted CallId).
 */
type EmitReturn<O extends { readonly type?: EmitFraming }> = O extends {
	readonly type: "open";
}
	? CallId
	: // biome-ignore lint/suspicious/noConfusingVoidType: `void` here is the conditional return for non-open framings — using `undefined` would force callers to write `void ctx.emit(...)` to discard, which is worse ergonomics
		void;

interface PluginContext {
	/**
	 * Emit a single bus event. Returns a `CallId` only when
	 * `options.type === "open"` (capture it to pair with a future close).
	 * For leaves (default) and closes, the return type is `void` — assigning
	 * the result is a compile-time error.
	 */
	emit<O extends EmitOptions>(kind: EventKind, options: O): EmitReturn<O>;
	/**
	 * Wrap `fn` with paired open/close events. Emits `${prefix}.request` on
	 * entry, then `${prefix}.response` (success) or `${prefix}.error`
	 * (failure). Pairing is via a closure-captured CallId.
	 */
	request<T>(
		prefix: string,
		options: RequestOptions,
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
	 * Optional guest-facing alias used by the closure rule in `bridge.ts`'s
	 * `buildHandler` when constructing the synthetic `at <bridge:<publicName>>`
	 * stack frame and the `<publicName> failed: …` message prefix on errors
	 * that cross into the guest VM. Falls back to `name` when omitted. See
	 * `openspec/specs/sandbox/spec.md` — "GuestFunctionDescription publicName
	 * field".
	 */
	readonly publicName?: string;
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
	/**
	 * Per-run plugin data. Opaque to the sandbox core; reserved as a
	 * general-purpose channel for plugins that need per-invocation payloads
	 * outside the `input` envelope. Callers pass this via the 3rd argument
	 * to `sb.run(name, input, extras)`. Currently no in-repo plugin
	 * consumes it (the secrets plugin bakes its plaintextStore into the
	 * plugin config at sandbox construction instead).
	 */
	readonly extras?: unknown;
}

type RunResult =
	| { readonly ok: true; readonly output: unknown }
	| { readonly ok: false; readonly error: unknown };

interface PluginSetup {
	readonly exports?: Record<string, unknown>;
	readonly guestFunctions?: readonly GuestFunctionDescription<
		readonly ArgSpec<unknown>[],
		ResultSpec<unknown>
	>[];
	readonly wasiHooks?: WasiHooks;
	readonly onBeforeRunStarted?: (runInput: RunInput) => boolean | undefined;
	readonly onRunFinished?: (result: RunResult, runInput: RunInput) => void;
	/**
	 * Invoked in the worker for every outbound message crossing the
	 * worker→main boundary, before it is actually posted. Runs in plugin
	 * topological order (same as other lifecycle hooks). Each hook receives
	 * the (possibly already transformed) message from the previous hook and
	 * returns the message to pass to the next hook — or to the actual post.
	 *
	 * Cross-cutting hook: every plugin's `onPost` sees every other plugin's
	 * outbound traffic. Implementers MUST have a documented rationale
	 * (SECURITY.md R-10).
	 */
	readonly onPost?: (msg: WorkerToMain) => WorkerToMain;
}

interface Plugin<Config extends SerializableConfig = SerializableConfig> {
	readonly name: string;
	readonly dependsOn?: readonly string[];
	worker(
		ctx: PluginContext,
		deps: DepsMap,
		config: Config,
	): PluginSetup | undefined | Promise<PluginSetup | undefined>;
}

interface LifecycleError {
	readonly message: string;
	readonly stack: string;
	readonly issues?: unknown;
}

function serializeLifecycleError(err: unknown): LifecycleError {
	if (err instanceof Error) {
		const serialized: LifecycleError = {
			message: err.message,
			stack: err.stack ?? "",
		};
		const source = err as unknown as Record<string, unknown>;
		if ("issues" in source) {
			return { ...serialized, issues: source.issues };
		}
		return serialized;
	}
	return { message: String(err), stack: "" };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * Public emit — single SDK signature dispatching on `options.type` (default
 * `"leaf"`). Returns the worker-minted CallId for opens (so callers capture
 * it to pair with a future close); leaves and closes return an opaque
 * value callers ignore. Framing is explicit at the API boundary; `kind` is
 * free-form metadata that the worker→main pipeline does not parse.
 */
function pluginEmit(
	bridge: Bridge,
	kind: EventKind,
	options: EmitOptions,
): CallId {
	const framing = options.type ?? "leaf";
	const extra: { input?: unknown; output?: unknown; error?: unknown } = {};
	if (options.input !== undefined) {
		extra.input = options.input;
	}
	if (options.output !== undefined) {
		extra.output = options.output;
	}
	if (options.error !== undefined) {
		extra.error = options.error;
	}
	return bridge.buildEvent(kind, options.name, framing, extra);
}

/**
 * Wraps a unit of work in `<prefix>.request`/`<prefix>.response`/
 * `<prefix>.error` lifecycle events. Captures the open's CallId in closure
 * and passes it back on the matching close, so concurrent calls (Promise.all
 * shape) pair correctly via the explicit token.
 *
 * The original thrown exception (or rejected promise reason) is re-thrown
 * after emitting the error event, so callers see the same failure they
 * would without the wrap.
 */
function pluginRequest<T>(
	bridge: Bridge,
	prefix: string,
	options: RequestOptions,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	const callId = pluginEmit(bridge, `${prefix}.request`, {
		name: options.name,
		...(options.input === undefined ? {} : { input: options.input }),
		type: "open",
	});

	function emitResponse(output: unknown): void {
		pluginEmit(bridge, `${prefix}.response`, {
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
			...(output === undefined ? {} : { output }),
			type: { close: callId },
		});
	}

	function emitError(err: unknown): void {
		pluginEmit(bridge, `${prefix}.error`, {
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
			error: serializeLifecycleError(err),
			type: { close: callId },
		});
	}

	let maybeResult: T | Promise<T>;
	try {
		maybeResult = fn();
	} catch (err) {
		emitError(err);
		throw err;
	}
	if (!isPromiseLike(maybeResult)) {
		emitResponse(maybeResult as unknown);
		return maybeResult;
	}
	// Async path: this is a pending host-callable for the duration of the
	// await. Bound the in-flight count via the worker-side pending-callables
	// counter (see `limit-counters.ts`). Entering AFTER emitRequest matches
	// the intuitive "request visible on the wire before we claim a slot"
	// ordering; exiting on either resolve or reject.
	enterPendingCallable();
	return (maybeResult as Promise<T>).then(
		(value) => {
			exitPendingCallable();
			emitResponse(value);
			return value;
		},
		(err: unknown) => {
			exitPendingCallable();
			emitError(err);
			throw err;
		},
	);
}

/**
 * Builds the PluginContext exposed to plugin.worker(). Wraps the underlying
 * Bridge's emit primitives with the public ctx.emit / ctx.request surface.
 * The bridge mints CallIds for opens; the sequencer (on main) stamps seq/ref.
 */
function createPluginContext(bridge: Bridge): PluginContext {
	return {
		// The cast to `never` (then to the conditional return) is the
		// implementation-side acknowledgement that the type system narrows
		// the return per call site (`CallId` for opens, `void` otherwise);
		// the runtime always produces a number, but leaves/closes' callers
		// get `void` and cannot inspect it.
		emit(kind, options) {
			return pluginEmit(bridge, kind, options) as never;
		},
		request(prefix, options, fn) {
			return pluginRequest(bridge, prefix, options, fn);
		},
	};
}

export type {
	Callable,
	CallId,
	DepsMap,
	EmitFraming,
	EmitOptions,
	EventKind,
	GuestFunctionDescription,
	GuestFunctionHandler,
	LifecycleError,
	LogConfig,
	Plugin,
	PluginContext,
	PluginDescriptor,
	PluginSetup,
	RequestOptions,
	RunInput,
	RunResult,
	SerializableConfig,
	WasiClockArgs,
	WasiClockResult,
	WasiFdWriteArgs,
	WasiHooks,
	WasiRandomArgs,
	WasiRandomResult,
};
export { createPluginContext, serializeLifecycleError };
