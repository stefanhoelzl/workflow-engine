import type {
	GuestFunctionDescription,
	PluginSetup,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";

// The set of console methods the sandbox provides. Matches the legacy
// `globals.ts` setupConsole catalog so tenant source-code that calls
// `console.log(...)` etc. behaves identically. `table`/`group`/`trace`
// etc. are deliberately absent — the minimum surface tenant code is
// expected to consume; adding more is a trivial extension once demand
// materialises.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/**
 * Builds a guest-function descriptor for one console method. The
 * descriptor is **private** — Phase 3 of the boot pipeline deletes each
 * `__console_<method>` binding from globalThis after Phase 2's IIFE has
 * captured them into a sealed `console` object. This keeps tenant source
 * from re-obtaining a bridge to the host emit path by reading, say,
 * `globalThis.__console_log` directly.
 *
 * Emission shape: one leaf event per call, kind `console.<method>`, with
 * `input: [...args]`. No request/response pair — `console.log` is a
 * one-shot side effect, not a request.
 */
function consoleDescriptor(method: ConsoleMethod): GuestFunctionDescription {
	return {
		name: `__console_${method}`,
		args: [Guest.raw()],
		result: Guest.void(),
		handler: () => {
			/* no-op — the leaf event is emitted by the log auto-wrap */
		},
		log: { event: `console.${method}` },
		public: false,
	};
}

// Plugin source: runs at Phase 2, after the private `__console_*` descriptors
// are installed and before Phase 3 deletes them. Captures each private
// descriptor into a `console` object via closure. Per WebIDL, the outer
// `globalThis.console` is a regular writable/configurable data property;
// we install it that way. Tenant source can reassign `globalThis.console`
// (losing host emission), but cannot re-bridge to the private descriptors —
// after Phase 3 the `__console_*` bindings are gone, so there's no way to
// reach the host emit path by reading `globalThis.__console_<method>`.
function buildConsoleSource(): string {
	const captures = CONSOLE_METHODS.map(
		(m) =>
			`${m}: (...args) => { const f = globalThis[${JSON.stringify(`__console_${m}`)}]; if (f) f(args); }`,
	).join(",\n\t");
	return `(() => {
	const con = {
		${captures}
	};
	// Per WebIDL, the console object itself is writable/configurable on the
	// global so user code can replace or shadow it; individual methods are
	// data properties. We install without defineProperty so default attrs
	// apply (writable, configurable, enumerable — matching Node/browser).
	globalThis.console = con;
})();`;
}

const name = "console";

function worker(): PluginSetup {
	return {
		guestFunctions: CONSOLE_METHODS.map(consoleDescriptor),
		source: buildConsoleSource(),
	};
}

export type { ConsoleMethod };
export { CONSOLE_METHODS, name, worker };
