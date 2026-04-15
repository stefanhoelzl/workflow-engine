import type { LogEntry } from "./bridge-factory.js";

interface SerializedError {
	name: string;
	message: string;
	stack: string;
}

type RunResultPayload =
	| { ok: true; result: unknown; logs: LogEntry[] }
	| { ok: false; error: { message: string; stack: string }; logs: LogEntry[] };

type MainToWorker =
	| {
			type: "init";
			source: string;
			methodNames: string[];
			filename: string;
			forwardFetch: boolean;
	  }
	| {
			type: "run";
			exportName: string;
			ctx: unknown;
			extraNames: string[];
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
	| { type: "done"; payload: RunResultPayload };

export type { MainToWorker, RunResultPayload, SerializedError, WorkerToMain };
