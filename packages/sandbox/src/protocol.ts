import type { SandboxEvent } from "@workflow-engine/core";
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
	| { type: "event"; event: SandboxEvent }
	| { type: "done"; payload: RunResultPayload }
	| {
			type: "log";
			level: "debug" | "info" | "warn" | "error";
			message: string;
			meta?: Record<string, unknown>;
	  };

export type { MainToWorker, RunResultPayload, SerializedError, WorkerToMain };
