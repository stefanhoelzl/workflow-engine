import type { InvocationEvent } from "@workflow-engine/core";

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
			methodNames: string[];
			methodEventNames?: Record<string, string>;
			filename: string;
			forwardFetch: boolean;
			// Optional memoryLimit in bytes, passed to QuickJS.create.
			memoryLimit?: number;
			// TODO(quickjs-wasi): clock (WASI clock_time_get) and random
			// (WASI random_get) overrides cannot be sent via postMessage because
			// they're host functions that need access to the WASM memory at
			// VM-creation time. Future work: sandbox-side factories that
			// construct these from simple parameters (fixed time, seed, etc.).
			// TODO(quickjs-wasi): interruptHandler also cannot cross postMessage
			// — same limitation. Will require a sandbox-side factory (e.g. a
			// deadline value that the worker turns into a real handler).
	  }
	| {
			type: "run";
			exportName: string;
			ctx: unknown;
			extraNames: string[];
			invocationId: string;
			workflow: string;
			workflowSha: string;
	  }
	| {
			type: "response";
			requestId: number;
			ok: true;
			result: unknown;
	  }
	| {
			type: "response";
			requestId: number;
			ok: false;
			error: SerializedError;
	  };

type WorkerToMain =
	| { type: "ready" }
	| { type: "init-error"; error: SerializedError }
	| {
			type: "request";
			requestId: number;
			method: string;
			args: unknown[];
	  }
	| { type: "event"; event: InvocationEvent }
	| { type: "done"; payload: RunResultPayload };

export type { MainToWorker, RunResultPayload, SerializedError, WorkerToMain };
