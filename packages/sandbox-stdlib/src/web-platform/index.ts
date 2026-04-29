import type {
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import { install } from "./guest/install.js";

// Name of the private descriptor the reportError polyfill captures in its
// IIFE and then deletes from globalThis. See SECURITY.md §2 capture-and-
// delete discipline.
const REPORT_ERROR_HOST = "__reportErrorHost";

interface ReportErrorPayload {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
	readonly cause?: unknown;
}

function reportErrorHostDescriptor(
	_ctx: PluginContext,
): GuestFunctionDescription {
	return {
		name: REPORT_ERROR_HOST,
		args: [Guest.object<ReportErrorPayload>()],
		result: Guest.void(),
		handler: (() => {
			/* no-op — the leaf event is emitted by the log auto-wrap */
		}) as unknown as GuestFunctionDescription["handler"],
		// Auto-wrap emits one `system.exception` leaf event per invocation,
		// carrying the report payload as `input`. Consumers that want a
		// side effect (e.g. a logger in runtime) subscribe via `sb.onEvent`.
		// Per the bridge-main-sequencing change, the `uncaught-error` reserved
		// prefix is folded into `system.exception` (a leaf under the `system.*`
		// family). The classname / message / stack remain in `input` for
		// consumers that want them.
		log: { event: "system.exception" },
		// Override the default name (descriptor.name = "__reportErrorHost").
		// Use the reported error's class name for visual disambiguation
		// in the dashboard.
		logName: (args) => {
			const payload = args[0] as ReportErrorPayload | undefined;
			return payload?.name ?? "Error";
		},
		// The args tuple is `[payload]`; emit the payload directly as input.
		logInput: (args) => args[0],
		public: false,
	};
}

/**
 * Bundles the full suite of sandbox polyfills (EventTarget, ErrorEvent,
 * Observable, Streams, URLPattern, CompressionStream, scheduler, indexedDB,
 * performance.mark, reportError, microtask, fetch WHATWG shape,
 * structuredClone, etc.) plus the private `__reportErrorHost` descriptor
 * the reportError polyfill captures.
 */
const name = "web-platform";

function worker(ctx: PluginContext): PluginSetup {
	return {
		guestFunctions: [reportErrorHostDescriptor(ctx)],
	};
}

/**
 * Guest-side entry point. The `?sandbox-plugin` vite transform bundles this
 * zero-arg function into a standalone IIFE that evaluates inside QuickJS at
 * Phase 2. Every polyfill in `./guest/entry.ts` is installed transitively
 * via the `install()` import chain, in the exact order documented there.
 */
function guest(): void {
	install();
}

export type { ReportErrorPayload };
export { guest, name, REPORT_ERROR_HOST, worker };
