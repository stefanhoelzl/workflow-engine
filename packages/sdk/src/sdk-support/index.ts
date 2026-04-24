import type {
	Callable,
	DepsMap,
	GuestFunctionDescription,
	GuestValue,
	PluginSetup,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";

// The private dispatcher descriptor name. Phase-3 deletes it from globalThis
// after Phase-2 guest() has captured it into the locked `__sdk` object,
// so owner code never sees this binding.
const SDK_DISPATCH_DESCRIPTOR = "__sdkDispatchAction";

/**
 * Signatures exported by the `host-call-action` plugin.
 *
 * - `validateAction(name, input)` throws (with Ajv `issues`) when the input
 *   fails the manifest's JSON Schema for the given action name, and throws
 *   an unknown-action error when the name is not in the manifest.
 * - `validateActionOutput(name, output)` returns the validated output on
 *   success, or throws (with Ajv `issues`) when the output fails the
 *   manifest's output JSON Schema; also throws an unknown-action error when
 *   the name is not in the manifest.
 *
 * Output validation runs host-side: guest code is untrusted, so the
 * dispatcher does NOT accept a guest-supplied completer. The schema lives
 * entirely on the host.
 */
interface HostCallActionExports {
	readonly validateAction: (name: string, input: unknown) => void;
	readonly validateActionOutput: (name: string, output: unknown) => unknown;
}

function resolveHostCallActionDeps(deps: DepsMap): HostCallActionExports {
	const dep = deps["host-call-action"] as
		| { validateAction?: unknown; validateActionOutput?: unknown }
		| undefined;
	if (!dep || typeof dep.validateAction !== "function") {
		throw new Error(
			'sdk-support plugin: dependency "host-call-action" did not export validateAction',
		);
	}
	if (typeof dep.validateActionOutput !== "function") {
		throw new Error(
			'sdk-support plugin: dependency "host-call-action" did not export validateActionOutput',
		);
	}
	return {
		validateAction:
			dep.validateAction as HostCallActionExports["validateAction"],
		validateActionOutput:
			dep.validateActionOutput as HostCallActionExports["validateActionOutput"],
	};
}

const name = "sdk-support";
const dependsOn: readonly string[] = ["host-call-action"];

/**
 * Installs the locked `__sdk.dispatchAction` surface that every SDK-produced
 * `action()` callable routes through. The dispatcher body:
 *   1. Calls `deps["host-call-action"].validateAction(name, input)`.
 *   2. Invokes the guest handler callable → `raw`.
 *   3. Calls `deps["host-call-action"].validateActionOutput(name, raw)`
 *      host-side to enforce the declared output schema and return the
 *      validated value.
 *   4. Disposes the guest handler callable in `finally`.
 *
 * Any fourth positional argument passed by a stale owner bundle (whose
 * SDK still constructs a completer closure) is silently ignored — output
 * validation is host-side regardless, so the security property holds even
 * when the guest shape lags behind.
 */
function worker(_ctx: SandboxContext, deps: DepsMap): PluginSetup {
	const { validateAction, validateActionOutput } =
		resolveHostCallActionDeps(deps);

	const dispatcher: GuestFunctionDescription = {
		name: SDK_DISPATCH_DESCRIPTOR,
		args: [Guest.string(), Guest.raw(), Guest.callable()],
		result: Guest.raw(),
		handler: (async (actionName: string, input: unknown, handler: Callable) => {
			try {
				validateAction(actionName, input);
				// Guest-side input/output always cross the bridge as
				// JSON-shaped GuestValue — the SDK's Zod validation
				// produces plain JSON shapes. Cast is structural only.
				const raw = await handler(input as GuestValue);
				return validateActionOutput(actionName, raw);
			} finally {
				handler.dispose();
			}
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "action" },
		logName: (args) => String(args[0] ?? ""),
		logInput: (args) => args[1],
		public: false,
	};

	return {
		guestFunctions: [dispatcher],
	};
}

// Captures `__sdkDispatchAction` from globalThis into a locked `__sdk` object
// (non-writable, non-configurable via defineProperty) with a frozen inner
// shape, so owner code cannot replace the dispatcher with a stub that
// bypasses action.* emission or validateAction (SECURITY.md §2 R-2).
// Phase-3 deletes the raw `__sdkDispatchAction` binding after this runs,
// leaving only the reference captured into `raw` below.
//
// The bridge takes three args — name, input, handler — with no completer:
// output validation is host-side (via `validateActionOutput`), not a
// guest-supplied closure.
function guest(): void {
	type DispatchFn = (name: string, input: unknown, handler: unknown) => unknown;
	const g = globalThis as unknown as Record<string, unknown>;
	const raw = g[SDK_DISPATCH_DESCRIPTOR] as DispatchFn;
	const sdk = Object.freeze({
		dispatchAction: (name: string, input: unknown, handler: unknown) =>
			raw(name, input, handler),
	});
	Object.defineProperty(globalThis, "__sdk", {
		value: sdk,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

export type { HostCallActionExports };
export { dependsOn, guest, name, SDK_DISPATCH_DESCRIPTOR, worker };
