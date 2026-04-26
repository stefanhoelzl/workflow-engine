import type { InvocationEventError } from "@workflow-engine/core";
import type { PluginDescriptor } from "./plugin.js";

interface SerializedError {
	name: string;
	message: string;
	stack: string;
	// Optional structured fields copied from the host-side thrown Error.
	// `issues` preserves Zod `.issues` arrays across the bridge; other own
	// JSON-serializable properties are captured in `data`. Both are
	// reconstructed as own properties on the Error re-thrown into the guest.
	issues?: unknown;
	data?: Record<string, unknown>;
}

// Wire-level framing discriminator on every WireEvent. Sandbox's main-side
// RunSequencer reads `type` directly to decide framing — kind strings are
// free-form metadata and SHALL NOT be parsed for framing decisions.
//
// SDK callers pass `"leaf" | "open" | { close: CallId }`; the bridge
// transforms `"open"` into `{ open: <mintedCallId> }` before posting to main.
// See openspec/specs/sandbox `Explicit framing via the type field on wire events`.
type WireFraming =
	| "leaf"
	| { readonly open: number }
	| { readonly close: number };

// Worker → Sandbox wire payload. Carries the bridge-stamped intrinsic fields
// (`kind`, `name`, `ts`, `at`, payload) plus the typed framing discriminator.
// Sandbox stamps `seq` and `ref` from this, drops `type` and the embedded
// callId, and forwards a SandboxEvent to `sb.onEvent`.
interface WireEvent {
	readonly kind: string;
	readonly name: string;
	readonly ts: number;
	readonly at: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: InvocationEventError;
	readonly type: WireFraming;
}

type RunResultPayload =
	| { ok: true; result: unknown }
	| { ok: false; error: { message: string; stack: string } };

type MainToWorker =
	| {
			type: "init";
			source: string;
			filename: string;
			pluginDescriptors: readonly PluginDescriptor[];
			// Optional memoryLimit in bytes, passed to QuickJS.create.
			memoryLimit?: number;
	  }
	| {
			type: "run";
			exportName: string;
			ctx: unknown;
			// Opaque per-run plugin data; surfaced to plugins via
			// `RunInput.extras`. Reserved as a general-purpose channel —
			// no in-repo plugin consumes it today (see `RunInput.extras`
			// in plugin.ts for rationale).
			extras?: unknown;
	  };

type WorkerToMain =
	| { type: "ready" }
	| { type: "init-error"; error: SerializedError }
	| { type: "event"; event: WireEvent }
	| { type: "done"; payload: RunResultPayload }
	| {
			type: "log";
			level: "debug" | "info" | "warn" | "error";
			message: string;
			meta?: Record<string, unknown>;
	  };

export type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WireEvent,
	WireFraming,
	WorkerToMain,
};
