import type {
	GuestFunctionDescription,
	PluginSetup,
	SandboxContext,
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
	ctx: SandboxContext,
): GuestFunctionDescription {
	return {
		name: REPORT_ERROR_HOST,
		args: [Guest.object<ReportErrorPayload>()],
		result: Guest.void(),
		handler: ((payload: ReportErrorPayload) => {
			// Leaf event records the uncaught error in the invocation
			// archive. Consumers that want an additional side effect
			// (e.g. a logger in runtime) subscribe via `sb.onEvent`
			// rather than via a plugin option — plugin configs must be
			// JSON-serializable, so function callbacks are out.
			ctx.emit("uncaught-error", "reportError", { input: payload });
		}) as unknown as GuestFunctionDescription["handler"],
		// No log wrap — the ctx.emit above IS the single leaf; wrapping in
		// request/response would double-emit.
		log: { event: "uncaught-error.noop" },
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

function worker(ctx: SandboxContext): PluginSetup {
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
