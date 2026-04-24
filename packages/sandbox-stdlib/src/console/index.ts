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
 * `__console_<method>` binding from globalThis after Phase 2's guest()
 * has captured them into a `console` object. This keeps tenant source
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
		// Guest bridge packs the tenant's variadic args into a single array
		// (see `guest()` below). The log auto-wrap's default `input = args`
		// would therefore emit `input: [[...]]` — a pointless extra level of
		// wrapping. Unwrap so the audit shape matches the spec scenario:
		// `console.log("hello", { x: 1 })` → `input: ["hello", { x: 1 }]`.
		logInput: (args) => args[0],
		public: false,
	};
}

const name = "console";

function worker(): PluginSetup {
	return {
		guestFunctions: CONSOLE_METHODS.map(consoleDescriptor),
	};
}

// Runs at Phase 2, after the private `__console_*` descriptors are installed
// and before Phase 3 deletes them. Captures each private descriptor into a
// `console` object via closure. Per WebIDL, the outer `globalThis.console` is
// a regular writable/configurable data property; we install it via plain
// assignment (no defineProperty/freeze) so tenant source can reassign
// `globalThis.console` (losing host emission). Tenant source cannot re-bridge
// to the private descriptors — after Phase 3 the `__console_*` bindings are
// gone, so the only live references are the ones captured here.
function guest(): void {
	const con: Record<string, (...args: unknown[]) => void> = {};
	const g = globalThis as unknown as Record<string, unknown>;
	for (const method of CONSOLE_METHODS) {
		const f = g[`__console_${method}`];
		con[method] = (...args: unknown[]) => {
			if (typeof f === "function") {
				(f as (a: unknown[]) => void)(args);
			}
		};
	}
	(globalThis as { console?: unknown }).console = con;
}

export type { ConsoleMethod };
export { CONSOLE_METHODS, guest, name, worker };
