import type { InvocationEventError } from "@workflow-engine/core";
import type { Bridge } from "./bridge.js";
import type { GuestThrownError } from "./guest-errors.js";
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

/**
 * Brand symbol stamped on every `CallableResult` envelope returned by a
 * `Callable.invoke` call. Used by `pluginRequest` to discriminate envelopes
 * from non-envelope return values without shape-sniffing. Attached via
 * `Object.defineProperty` so the brand is non-enumerable: it does not appear
 * in `Object.keys`, `JSON.stringify`, or `structuredClone` clone trees.
 *
 * Registered via `Symbol.for(...)` so identical envelopes constructed in any
 * realm (in practice, only the sandbox worker thread) share the same brand.
 */
const CALLABLE_RESULT_BRAND = Symbol.for(
	"@workflow-engine/sandbox#callableResult",
);

/**
 * Serialised plain-object shape of a `GuestThrownError` for consumers that
 * need a JSON-clean payload — primarily the `system.error` event wire
 * shape produced by `pluginRequest`'s envelope auto-unwrap. Always carries
 * `name`, `message`, and `stack`; enumerable own-properties of the
 * originating guest exception (structured discriminants like `kind` /
 * `code`) are copied across alongside.
 *
 * Note: `CallableResult.error` is the live `GuestThrownError` instance
 * (an `Error` subclass), NOT this serialised payload. Plugin authors who
 * `throw result.error` in Pattern-2 (explicit-await) call sites benefit
 * from the bridge closure rule's `GuestThrownError` pass-through; passing
 * a plain object would route via the `BridgeError` catch-all and lose
 * `.name` / structured discriminants.
 */
type CallableErrorPayload = {
	readonly name: string;
	readonly message: string;
	readonly stack: string;
} & Readonly<Record<string, unknown>>;

/**
 * Discriminated-union envelope returned by `Callable.invoke`. Guest-
 * originated throws surface as `{ ok: false, error }` resolutions (not
 * rejections) so the host plugin boundary stays opaque to Node's
 * `unhandledRejection` escalation path. Engine-side errors
 * (`CallableDisposedError`, marshal failures, vm-disposed mid-call)
 * continue to reject — they signal engine bugs, not guest behaviour.
 *
 * See `openspec/specs/sandbox/spec.md` "Guest→host boundary opacity
 * (Callable envelope contract)".
 *
 * `error` is the live `GuestThrownError` instance so plugins can rethrow
 * it directly under the bridge closure rule's pass-through branch (R-12).
 * Wire serialisation to a plain `CallableErrorPayload` happens at the
 * `pluginRequest` emission boundary, not at the envelope's construction
 * site.
 */
type CallableResult =
	| { readonly ok: true; readonly value: GuestValue }
	| { readonly ok: false; readonly error: GuestThrownError };

interface Callable {
	(...args: readonly GuestValue[]): Promise<CallableResult>;
	dispose(): void;
}

/**
 * Predicate that detects whether a value is a Callable envelope. Used by
 * `pluginRequest`'s resolve handler to branch on envelope vs non-envelope
 * return values. The check is unambiguous because the brand is a
 * registered Symbol (`Symbol.for(...)`); shape-sniffing would mis-fire on
 * plugins legitimately returning `{ ok, value }` literals from non-Callable
 * code paths.
 */
function isCallableResult(value: unknown): value is CallableResult {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as Record<symbol, unknown>)[CALLABLE_RESULT_BRAND] === true
	);
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

/**
 * Serialise a live `GuestThrownError` to a wire-clean
 * `CallableErrorPayload`. Used by `pluginRequest`'s envelope-error path
 * to put the structured guest-throw on the `system.error` event.
 * Distinct from `serializeLifecycleError` (lossy on `.name` and
 * own-properties) by design: the envelope path preserves F-2's
 * extended-own-property work.
 */
function serializeCallableEnvelopeError(
	err: GuestThrownError,
): CallableErrorPayload {
	const payload: Record<string, unknown> = {
		name: err.name,
		message: err.message,
		stack: err.stack ?? "",
	};
	for (const key of Object.keys(err)) {
		if (key === "name" || key === "message" || key === "stack") {
			continue;
		}
		payload[key] = (err as unknown as Record<string, unknown>)[key];
	}
	return payload as CallableErrorPayload;
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
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: pluginRequest binds open/close emission helpers (emitResponse, emitErrorFromException, emitErrorFromEnvelope) to the request frame's captured callId, then dispatches the wrapped fn across sync/async/envelope/rejection paths — splitting would shuttle the callId closure across helpers and lose the open/close pairing invariant
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

	// Engine-bug / dispatcher-error path: the wrapped fn rejected with a
	// non-envelope error. Run through serializeLifecycleError, which
	// produces today's LifecycleError shape (lossy on `.name` and most
	// own-properties; widening tracked as the audit-trail symmetry follow-
	// up — see `openspec/changes/callable-envelope-contract/proposal.md`).
	function emitErrorFromException(err: unknown): void {
		pluginEmit(bridge, `${prefix}.error`, {
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
			error: serializeLifecycleError(err),
			type: { close: callId },
		});
	}

	// Envelope-error path: the wrapped fn resolved with a CallableResult
	// envelope whose `ok` is false. The envelope's `error` field is the
	// live `GuestThrownError` instance produced by awaitGuestResult /
	// callGuestFn; serialise to a wire-clean plain payload here so the
	// system.error event carries the curated {name, message, stack,
	// ...ownProps} surface (preserving F-2's structured-discriminant
	// work). The `GuestThrownError` itself remains on the envelope for
	// any awaiting plugin that wants to rethrow under the bridge closure
	// rule's pass-through branch.
	function emitErrorFromEnvelope(error: GuestThrownError): void {
		pluginEmit(bridge, `${prefix}.error`, {
			name: options.name,
			...(options.input === undefined ? {} : { input: options.input }),
			error: serializeCallableEnvelopeError(error),
			type: { close: callId },
		});
	}

	let maybeResult: T | Promise<T>;
	try {
		maybeResult = fn();
	} catch (err) {
		emitErrorFromException(err);
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
			// Auto-unwrap CallableResult envelopes (Guest→host boundary
			// opacity contract). Envelope-error MUST NOT rethrow — that
			// would re-create the chained-rejection escape path that is
			// the F-3 finding's root cause. Instead we resolve the outer
			// promise with the envelope; awaiting plugins inspect, fire-
			// and-forget plugins discard. See `openspec/specs/sandbox/
			// spec.md` "pluginRequest auto-unwraps Callable envelopes".
			if (isCallableResult(value)) {
				if (value.ok) {
					emitResponse(value.value);
				} else {
					emitErrorFromEnvelope(value.error);
				}
				return value;
			}
			emitResponse(value);
			return value;
		},
		(err: unknown) => {
			exitPendingCallable();
			// Engine-bug rejection (not a Callable envelope-error). Keep
			// the existing rethrow shape so callers that wrap pluginRequest
			// in their own try/catch (e.g. the bridge buildHandler closure)
			// continue to observe the rejection.
			emitErrorFromException(err);
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
	CallableErrorPayload,
	CallableResult,
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
export {
	CALLABLE_RESULT_BRAND,
	createPluginContext,
	isCallableResult,
	serializeLifecycleError,
};
