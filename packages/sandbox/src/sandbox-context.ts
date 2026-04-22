import type { EventKind as CoreEventKind } from "@workflow-engine/core";
import type { Bridge } from "./bridge-factory.js";
import type {
	EmitOptions,
	EventExtra,
	EventKind,
	SandboxContext,
} from "./plugin.js";

// Bridge.buildEvent expects the narrow core EventKind union; plugin kinds are
// open-ended strings. Narrow at the boundary — kinds that don't match the
// core union still flow through the bridge as opaque strings (at runtime,
// EventKind is just a string label on the emitted event).
function asCoreKind(kind: EventKind): CoreEventKind {
	return kind as CoreEventKind;
}

interface EmitArgs {
	readonly kind: EventKind;
	readonly name: string;
	readonly extra: EventExtra;
	readonly options?: EmitOptions;
}

/**
 * Public emit — frame-aware event emission exposed via `ctx.emit`.
 *
 * - No options or both flags false: emits a leaf event (ref = current refStack top).
 * - createsFrame: emits with ref = current top, then pushes this event's seq onto
 *   the stack so subsequent sibling emissions nest under it.
 * - closesFrame: emits with ref = current top (the matching "open" event's seq),
 *   then pops the stack.
 * - Both flags true: treated as a leaf (no stack change); a plugin emitting an
 *   "instant" span that opens and closes in one event is just a leaf.
 */
function pluginEmit(bridge: Bridge, args: EmitArgs): void {
	const { kind, name, extra, options } = args;
	const seq = bridge.nextSeq();
	const ref = bridge.currentRef();
	const event = bridge.buildEvent(asCoreKind(kind), seq, ref, name, extra);
	if (event !== null) {
		bridge.emit(event);
	}
	if (options === undefined) {
		return;
	}
	const creates = options.createsFrame === true;
	const closes = options.closesFrame === true;
	if (creates && !closes) {
		bridge.pushRef(seq);
	} else if (closes && !creates) {
		bridge.popRef();
	}
	// Both flags set or both false: no stack change (leaf semantics).
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

interface RequestEmission {
	readonly prefix: string;
	readonly name: string;
	readonly input: unknown;
}

interface TerminalEmission extends RequestEmission {
	readonly reqSeq: number;
}

/**
 * Emits a `<prefix>.request` event, returns its seq, and pushes the seq onto
 * the refStack. Subsequent emissions (from inside fn's body or from async work
 * escaping fn) can nest under the request via the stack OR via the returned seq
 * being passed explicitly as ref.
 */
function emitRequest(bridge: Bridge, args: RequestEmission): number {
	const reqSeq = bridge.nextSeq();
	const parentRef = bridge.currentRef();
	const extra = args.input === undefined ? {} : { input: args.input };
	const event = bridge.buildEvent(
		asCoreKind(`${args.prefix}.request`),
		reqSeq,
		parentRef,
		args.name,
		extra,
	);
	if (event !== null) {
		bridge.emit(event);
	}
	bridge.pushRef(reqSeq);
	return reqSeq;
}

/**
 * Emits a `<prefix>.response` event with ref = reqSeq (explicit — so async work
 * that resumes after other frames have been pushed/popped still correctly
 * parents to the matching request) and pops the stack (removing reqSeq).
 */
function emitResponse(
	bridge: Bridge,
	args: TerminalEmission,
	output: unknown,
): void {
	const resSeq = bridge.nextSeq();
	const extra: { input?: unknown; output?: unknown } = {};
	if (args.input !== undefined) {
		extra.input = args.input;
	}
	if (output !== undefined) {
		extra.output = output;
	}
	const event = bridge.buildEvent(
		asCoreKind(`${args.prefix}.response`),
		resSeq,
		args.reqSeq,
		args.name,
		extra,
	);
	if (event !== null) {
		bridge.emit(event);
	}
	bridge.popRef();
}

/**
 * Emits a `<prefix>.error` event with ref = reqSeq and pops the stack. The
 * thrown error is serialized into the event's `error` field; the caller is
 * responsible for rethrowing the original exception.
 */
function emitError(bridge: Bridge, args: TerminalEmission, err: unknown): void {
	const errSeq = bridge.nextSeq();
	const extra: { input?: unknown; error?: unknown } = {
		error: serializeLifecycleError(err),
	};
	if (args.input !== undefined) {
		extra.input = args.input;
	}
	const event = bridge.buildEvent(
		asCoreKind(`${args.prefix}.error`),
		errSeq,
		args.reqSeq,
		args.name,
		extra,
	);
	if (event !== null) {
		bridge.emit(event);
	}
	bridge.popRef();
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

interface RequestCall<T> {
	readonly prefix: string;
	readonly name: string;
	readonly extra: { readonly input?: unknown };
	readonly fn: () => T | Promise<T>;
}

/**
 * Wraps a unit of work in `<prefix>.request`/`<prefix>.response`/`<prefix>.error`
 * lifecycle events. The request event is emitted synchronously before `fn` runs;
 * response (on success) or error (on throw/reject) is emitted after.
 *
 * For sync `fn`, the stack push from the request event is still on top when
 * response/error fires, so stack state remains clean. For async `fn`, the
 * captured `reqSeq` is used as the explicit `ref` for response/error events,
 * so other frames pushed during the await don't interfere with parenting.
 *
 * The original thrown exception (or rejected promise reason) is re-thrown after
 * emitting the error event, so callers see the same failure they would without
 * the wrap.
 */
function pluginRequest<T>(
	bridge: Bridge,
	call: RequestCall<T>,
): T | Promise<T> {
	const { prefix, name, extra, fn } = call;
	const input = extra.input;
	const reqSeq = emitRequest(bridge, { prefix, name, input });
	const terminal: TerminalEmission = { prefix, name, input, reqSeq };
	let maybeResult: T | Promise<T>;
	try {
		maybeResult = fn();
	} catch (err) {
		emitError(bridge, terminal, err);
		throw err;
	}
	if (!isPromiseLike(maybeResult)) {
		emitResponse(bridge, terminal, maybeResult as unknown);
		return maybeResult;
	}
	return (maybeResult as Promise<T>).then(
		(value) => {
			emitResponse(bridge, terminal, value);
			return value;
		},
		(err: unknown) => {
			emitError(bridge, terminal, err);
			throw err;
		},
	);
}

/**
 * Builds the SandboxContext exposed to plugin.worker(). Wraps the underlying
 * Bridge's emit/stamp primitives with the public ctx.emit / ctx.request surface.
 * Seq and refStack state stays inside the bridge; the ctx has no primitives for
 * reading or mutating it directly.
 */
function createSandboxContext(bridge: Bridge): SandboxContext {
	return {
		emit(kind, name, extra, options) {
			pluginEmit(bridge, {
				kind,
				name,
				extra,
				...(options === undefined ? {} : { options }),
			});
		},
		request(prefix, name, extra, fn) {
			return pluginRequest(bridge, { prefix, name, extra, fn });
		},
	};
}

export type { LifecycleError };
export { createSandboxContext, serializeLifecycleError };
