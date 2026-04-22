import { JSException, type JSValueHandle, type QuickJS } from "quickjs-wasi";
import type {
	Callable,
	GuestFunctionDescription,
	LogConfig,
	SandboxContext,
} from "./plugin.js";
import type { ArgSpec, GuestValue, ResultSpec } from "./plugin-types.js";

/**
 * Guest-function installer — converts a PluginSetup.guestFunctions descriptor
 * into a `vm.newFunction(name, handler)` installation on the VM global.
 *
 * Arg/result vocabulary (plugin-types.ts `Guest`):
 *   - string / number / boolean: primitive marshal via vm.toString / toNumber / truthy
 *   - object / array / raw: deep marshal via vm.dump / vm.hostToHandle
 *   - void (result only): always returns vm.undefined
 *
 * Callable args (for guest-side callbacks passed back to host code) are
 * wrapped via `makeCallable`, so a host-thread handler can invoke the
 * guest closure multiple times and dispose it when finished.
 *
 * Log auto-wrap:
 *   - Default (no `log` field) → `{ request: name }`: handler runs inside
 *     `ctx.request(name, name, {input: args}, () => handler(...))`, which
 *     emits name.request / name.response / name.error around it.
 *   - `log: { event: "..." }`: emit a single leaf event before handler
 *     invocation; handler's result is NOT wrapped.
 *   - `log: { request: "..." }`: same as default but with a custom prefix
 *     (e.g. a descriptor named `$fetch/do` can emit as `fetch.*`).
 *
 * All guest-thrown errors are converted to host exceptions via
 * vm.newFunction's built-in trampoline; the descriptor's log wrap ensures
 * the `.error` event fires regardless.
 */

class GuestArgTypeMismatchError extends Error {
	// biome-ignore lint/security/noSecrets: Error subclass name literal, not a credential
	readonly name = "GuestArgTypeMismatchError";
	readonly descriptorName: string;
	readonly argIndex: number;
	readonly expected: string;
	readonly received: string;
	constructor(
		descriptorName: string,
		argIndex: number,
		expected: string,
		received: string,
	) {
		super(
			`guest function "${descriptorName}" arg[${argIndex}]: expected ${expected}, got ${received}`,
		);
		this.descriptorName = descriptorName;
		this.argIndex = argIndex;
		this.expected = expected;
		this.received = received;
	}
}

class GuestValidationError extends Error {
	readonly name = "GuestValidationError";
	readonly descriptorName: string;
	constructor(descriptorName: string, message: string) {
		super(`guest function "${descriptorName}": ${message}`);
		this.descriptorName = descriptorName;
	}
}

class CallableDisposedError extends Error {
	readonly name = "CallableDisposedError";
	constructor() {
		super("Callable has been disposed and can no longer be invoked");
	}
}

/**
 * Wraps a guest-side function handle as a host-side Callable. The handle
 * is `.dup()`ed immediately so the Callable outlives the synchronous call
 * that captured it — timer callbacks, SDK dispatchers, and any
 * deferred-invocation surface need this lifetime extension.
 *
 * Semantics:
 *  - `(...args)` marshals each arg via `vm.hostToHandle` (hosts → guest),
 *    calls the guest function, resolves the returned promise (if any),
 *    dumps the result, and returns it as a GuestValue. Guest-thrown
 *    JSExceptions are re-thrown as host `Error` objects with the dumped
 *    name/message/stack preserved.
 *  - `dispose()` is idempotent; further invocations throw
 *    CallableDisposedError. Plugins MUST call dispose() in a finally block
 *    when they're done to release the guest handle — forgetting leaks
 *    QuickJS memory until VM teardown.
 *
 * NOTE: invoking a Callable AFTER the run that created it has ended is
 * supported (timers fire after run-body return). The Bridge's refStack
 * reset on run-context clear means these emissions have no parent frame,
 * which matches the "run body finished but async work escaping" precedent
 * from legacy timer callbacks in globals.ts.
 */
function callGuestFn(
	vm: QuickJS,
	handle: JSValueHandle,
	argHandles: readonly JSValueHandle[],
): JSValueHandle {
	try {
		return vm.callFunction(handle, vm.undefined, ...argHandles);
	} catch (err) {
		if (err instanceof JSException) {
			// JSException is an Error instance, not a JSValueHandle — read
			// `.message` / `.stack` directly. The prior `vm.dump(err as
			// unknown as JSValueHandle)` cast returned `undefined` and
			// masked every guest-side error with the generic fallback
			// message below.
			const message = err.message || "guest function threw";
			const stack = err.stack ?? "";
			err.dispose();
			const rethrown = new Error(message);
			if (stack) {
				rethrown.stack = stack;
			}
			throw rethrown;
		}
		throw err;
	}
}

async function awaitGuestResult(
	vm: QuickJS,
	retHandle: JSValueHandle,
): Promise<GuestValue> {
	const resolved = vm.resolvePromise(retHandle);
	retHandle.dispose();
	vm.executePendingJobs();
	const outcome = await resolved;
	if ("error" in outcome) {
		const detail = vm.dump(outcome.error) as
			| { message?: string; stack?: string }
			| undefined;
		outcome.error.dispose();
		const e = new Error(detail?.message ?? "guest callable rejected");
		if (detail?.stack !== undefined) {
			e.stack = detail.stack;
		}
		throw e;
	}
	const value = vm.dump(outcome.value) as GuestValue;
	outcome.value.dispose();
	return value;
}

// quickjs-wasi's `vm.hostToHandle` returns shared singletons for null,
// undefined, true, and false — the same JSValueHandle instance the VM uses
// everywhere. Disposing one of those singletons decrements the shared
// refcount and corrupts subsequent use. Always dup singletons so the caller
// owns an independent handle whose dispose only affects the dup.
function marshalArg(vm: QuickJS, value: unknown): JSValueHandle {
	const handle = vm.hostToHandle(value);
	if (
		value === null ||
		value === undefined ||
		value === true ||
		value === false
	) {
		return handle.dup();
	}
	return handle;
}

function makeCallable(vm: QuickJS, handle: JSValueHandle): Callable {
	const dup = handle.dup();
	let disposed = false;
	const invoke = async (
		...args: readonly GuestValue[]
	): Promise<GuestValue> => {
		if (disposed) {
			throw new CallableDisposedError();
		}
		const argHandles = args.map((a) => marshalArg(vm, a));
		try {
			const retHandle = callGuestFn(vm, dup, argHandles);
			return await awaitGuestResult(vm, retHandle);
		} finally {
			for (const h of argHandles) {
				h.dispose();
			}
		}
	};
	const callable = invoke as Callable;
	callable.dispose = () => {
		if (disposed) {
			return;
		}
		disposed = true;
		dup.dispose();
	};
	return callable;
}

function classify(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

// Table-driven kind → type-test mapping. Returns the JS type-of string
// that satisfies the ArgSpec kind, or null when the kind is not a simple
// type check (raw accepts anything; callable is deferred).
const PRIMITIVE_KIND_TO_JS_TYPE: Record<string, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	object: "object",
	array: "array",
};

function assertMatchesKind(
	descriptorName: string,
	idx: number,
	kind: ArgSpec<unknown>["kind"],
	value: unknown,
): void {
	const received = classify(value);
	if (kind === "raw" || kind === "callable") {
		// callable args are dispatched via the handle path in unmarshalArgs
		// and don't reach this dumped-value check; raw accepts anything.
		return;
	}
	const expected = PRIMITIVE_KIND_TO_JS_TYPE[kind];
	if (expected === undefined) {
		throw new GuestValidationError(descriptorName, "unknown arg kind");
	}
	if (received !== expected) {
		throw new GuestArgTypeMismatchError(
			descriptorName,
			idx,
			expected,
			received,
		);
	}
}

function unmarshalArgs(
	vm: QuickJS,
	descriptorName: string,
	specs: readonly ArgSpec<unknown>[],
	handles: readonly JSValueHandle[],
): unknown[] {
	const out: unknown[] = [];
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i];
		if (spec === undefined) {
			continue;
		}
		const handle = handles[i];
		if (handle === undefined) {
			out.push(undefined);
			continue;
		}
		if (spec.kind === "callable") {
			// Callables are wrapped around the guest handle directly so the
			// underlying function can be re-invoked after the current sync
			// call returns. Plugins own disposal via callable.dispose().
			out.push(makeCallable(vm, handle));
			continue;
		}
		const dumped = vm.dump(handle);
		assertMatchesKind(descriptorName, i, spec.kind, dumped);
		out.push(dumped);
	}
	return out;
}

function marshalResult(
	vm: QuickJS,
	descriptorName: string,
	spec: ResultSpec<unknown>,
	value: unknown,
): JSValueHandle {
	switch (spec.kind) {
		case "void":
			return vm.undefined;
		case "string":
			if (typeof value !== "string") {
				throw new GuestValidationError(
					descriptorName,
					`result: expected string, got ${classify(value)}`,
				);
			}
			return vm.newString(value);
		case "number":
			if (typeof value !== "number") {
				throw new GuestValidationError(
					descriptorName,
					`result: expected number, got ${classify(value)}`,
				);
			}
			return vm.newNumber(value);
		case "boolean":
			if (typeof value !== "boolean") {
				throw new GuestValidationError(
					descriptorName,
					`result: expected boolean, got ${classify(value)}`,
				);
			}
			return value ? vm.true : vm.false;
		case "object":
		case "array":
		case "raw":
			// See marshalArg: singleton null/undefined/true/false from
			// hostToHandle must be duplicated before being returned to
			// QuickJS as a function result, otherwise the shared singleton
			// refcount is corrupted when QuickJS releases its hold.
			return marshalArg(vm, value);
		default:
			throw new GuestValidationError(descriptorName, "unknown result kind");
	}
}

function resolveLog(descriptor: GuestFunctionDescription): LogConfig {
	return descriptor.log ?? { request: descriptor.name };
}

/**
 * Installs one guest function descriptor on the VM's global.
 *
 * - The `name` property is used verbatim as the VM global key. Callers may
 *   register descriptors with colliding names only via different plugins;
 *   collision detection happens upstream in plugin-compose.
 * - Phase-3 (private-delete) runs AFTER this install, so non-public
 *   descriptors end up invisible to user source even though they were
 *   installed here. Plugin `source` (Phase 2) runs between — the capture
 *   window for private bindings.
 */
function installGuestFunction(
	vm: QuickJS,
	ctx: SandboxContext,
	descriptor: GuestFunctionDescription,
	target: JSValueHandle = vm.global,
): void {
	const log = resolveLog(descriptor);
	// Cast handler to a uniform unknown-arg signature — the descriptor's
	// typed ArgSpec shape is enforced by the test harness/author, not the
	// runtime, so the VM-side invocation path treats args as opaque values.
	type AnyHandler = (...args: readonly unknown[]) => unknown;
	const handler = descriptor.handler as unknown as AnyHandler;
	const fn = vm.newFunction(descriptor.name, (...handles) => {
		const args = unmarshalArgs(vm, descriptor.name, descriptor.args, handles);
		const invoke = () => handler(...args);
		const eventName = descriptor.logName
			? descriptor.logName(args)
			: descriptor.name;
		const eventInput = descriptor.logInput ? descriptor.logInput(args) : args;
		if ("event" in log) {
			// Single-leaf event before handler invocation; handler result is
			// NOT wrapped so caller controls event shape explicitly via
			// ctx.emit.
			ctx.emit(log.event, eventName, { input: eventInput });
			const raw = invoke();
			return marshalResult(vm, descriptor.name, descriptor.result, raw);
		}
		// request-style wrap: ctx.request emits prefix.request/response/error
		// around the handler. For sync handlers the raw value is available
		// immediately; the async variant is handled in a later PR when
		// Promise-returning guest functions become mainstream.
		const raw = ctx.request(
			log.request,
			eventName,
			{ input: eventInput },
			invoke,
		);
		return marshalResult(vm, descriptor.name, descriptor.result, raw);
	});
	vm.setProp(target, descriptor.name, fn);
	fn.dispose();
}

/**
 * Installs every descriptor in Phase-1 order onto the VM global. Uses the
 * descriptors collected by `collectGuestFunctions`. Returns the count
 * installed for observability / tests.
 */
function installGuestFunctions(
	vm: QuickJS,
	ctx: SandboxContext,
	entries: readonly {
		readonly pluginName: string;
		readonly descriptor: GuestFunctionDescription;
	}[],
): number {
	for (const { descriptor } of entries) {
		installGuestFunction(vm, ctx, descriptor);
	}
	return entries.length;
}

export {
	CallableDisposedError,
	GuestArgTypeMismatchError,
	GuestValidationError,
	installGuestFunction,
	installGuestFunctions,
	makeCallable,
	marshalResult,
	unmarshalArgs,
};
