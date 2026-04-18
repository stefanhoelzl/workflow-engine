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
	  }
	| {
			type: "run";
			exportName: string;
			ctx: unknown;
			invocationId: string;
			tenant: string;
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
	| { type: "done"; payload: RunResultPayload }
	| {
			type: "log";
			level: "debug" | "info" | "warn" | "error";
			message: string;
			meta?: Record<string, unknown>;
	  };

export type { MainToWorker, RunResultPayload, SerializedError, WorkerToMain };
