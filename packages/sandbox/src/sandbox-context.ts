import type { Bridge } from "./bridge-factory.js";
import { enterPendingCallable, exitPendingCallable } from "./limit-counters.js";
import type {
	CallId,
	EmitOptions,
	EventKind,
	RequestOptions,
	SandboxContext,
} from "./plugin.js";

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
 * Builds the SandboxContext exposed to plugin.worker(). Wraps the underlying
 * Bridge's emit primitives with the public ctx.emit / ctx.request surface.
 * The bridge mints CallIds for opens; the sequencer (on main) stamps seq/ref.
 */
function createSandboxContext(bridge: Bridge): SandboxContext {
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

export type { LifecycleError };
export { createSandboxContext, serializeLifecycleError };
