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
// after Phase-2 source eval has captured it into the locked `__sdk` object,
// so tenant code never sees this binding.
const SDK_DISPATCH_DESCRIPTOR = "__sdkDispatchAction";

/**
 * Signature exported by the `host-call-action` plugin. `validateAction`
 * throws (with Ajv `issues`) when the input fails the manifest's JSON Schema
 * for the given action name, and throws an unknown-action error when the
 * name is not in the manifest. The sdk-support plugin only needs this one
 * method from the peer.
 */
interface HostCallActionExports {
	readonly validateAction: (name: string, input: unknown) => void;
}

function resolveHostCallActionDeps(deps: DepsMap): HostCallActionExports {
	const dep = deps["host-call-action"] as
		| { validateAction?: unknown }
		| undefined;
	if (!dep || typeof dep.validateAction !== "function") {
		throw new Error(
			'sdk-support plugin: dependency "host-call-action" did not export validateAction',
		);
	}
	return {
		validateAction:
			dep.validateAction as HostCallActionExports["validateAction"],
	};
}

// Captures `__sdkDispatchAction` from globalThis into a locked `__sdk`
// object (non-writable, non-configurable via defineProperty) with a
// frozen inner shape, so tenant code cannot replace the dispatcher with
// a stub that bypasses action.* emission or validateAction. Phase-3
// deletes the raw `__sdkDispatchAction` binding after this source runs.
const SDK_SUPPORT_SOURCE = `(() => {
	const raw = globalThis[${JSON.stringify(SDK_DISPATCH_DESCRIPTOR)}];
	const sdk = Object.freeze({
		dispatchAction: (name, input, handler, completer) =>
			raw(name, input, handler, completer),
	});
	Object.defineProperty(globalThis, "__sdk", {
		value: sdk,
		writable: false,
		configurable: false,
		enumerable: false,
	});
})();`;

const name = "sdk-support";
const dependsOn: readonly string[] = ["host-call-action"];

/**
 * Installs the locked `__sdk.dispatchAction` surface that every SDK-produced
 * `action()` callable routes through. The dispatcher body:
 *   1. Calls `deps["host-call-action"].validateAction(name, input)`.
 *   2. Invokes the guest handler callable → `raw`.
 *   3. Invokes the guest completer callable (`(raw) => outputSchema.parse(raw)`)
 *      so output-schema validation happens inside QuickJS.
 *   4. Returns the parsed output and disposes both callables in `finally`.
 */
function worker(_ctx: SandboxContext, deps: DepsMap): PluginSetup {
	const { validateAction } = resolveHostCallActionDeps(deps);

	const dispatcher: GuestFunctionDescription = {
		name: SDK_DISPATCH_DESCRIPTOR,
		args: [Guest.string(), Guest.raw(), Guest.callable(), Guest.callable()],
		result: Guest.raw(),
		handler: (async (
			actionName: string,
			input: unknown,
			handler: Callable,
			completer: Callable,
		) => {
			try {
				validateAction(actionName, input);
				// Guest-side input/output always cross the bridge as
				// JSON-shaped GuestValue — the SDK's Zod validation
				// produces plain JSON shapes. Cast is structural only.
				const raw = await handler(input as GuestValue);
				return await completer(raw);
			} finally {
				handler.dispose();
				completer.dispose();
			}
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "action" },
		logName: (args) => String(args[0] ?? ""),
		logInput: (args) => args[1],
		public: false,
	};

	return {
		guestFunctions: [dispatcher],
		source: SDK_SUPPORT_SOURCE,
	};
}

export type { HostCallActionExports };
export { dependsOn, name, SDK_DISPATCH_DESCRIPTOR, SDK_SUPPORT_SOURCE, worker };
