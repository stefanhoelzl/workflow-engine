import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { LogEntry } from "./bridge-factory.js";
import type { MethodMap } from "./install-host-methods.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";

// Resolve the compiled worker.js regardless of whether this module was loaded
// from src/ (TS, via vitest/tsx) or dist/src/ (JS, production). The worker
// runs as a plain node:worker_threads Worker, which requires a .js file with
// matching .js imports — the tsc-built dist/src/worker.js fits that. This
// assumes `tsc --build` has run for the package.
function resolveWorkerUrl(): URL {
	const here = dirname(fileURLToPath(import.meta.url));
	// When loaded from dist/src/index.js, `./worker.js` is a sibling.
	// When loaded from src/index.ts, hop to ../dist/src/worker.js.
	const distSrcDir = here.includes(`${resolve("/dist/src")}`)
		? here
		: resolve(here, "..", "dist", "src");
	return pathToFileURL(resolve(distSrcDir, "worker.js"));
}

type RunResult =
	| { ok: true; result: unknown; logs: LogEntry[] }
	| {
			ok: false;
			error: { message: string; stack: string };
			logs: LogEntry[];
	  };

interface SandboxOptions {
	filename?: string;
	// Reserved for future use: a custom fetch impl that would need to cross the
	// worker boundary. Today fetch is the worker's native globalThis.fetch.
	fetch?: typeof globalThis.fetch;
}

interface Sandbox {
	run(name: string, ctx: unknown, extraMethods?: MethodMap): Promise<RunResult>;
	dispose(): void;
	onDied(cb: (err: Error) => void): void;
}

const RESERVED_BUILTIN_GLOBALS = new Set([
	"console",
	"performance",
	"crypto",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"__hostFetch",
]);

function collisionName(
	reserved: ReadonlySet<string>,
	extra: MethodMap,
): string | undefined {
	for (const key of Object.keys(extra)) {
		if (reserved.has(key)) {
			return key;
		}
	}
}

const RESERVED_ERROR_KEYS = new Set(["name", "message", "stack", "issues"]);

function isJsonSafe(value: unknown): boolean {
	try {
		JSON.stringify(value);
		return true;
	} catch {
		return false;
	}
}

function errorFromSerialized(err: SerializedError): Error {
	const e = new Error(err.message);
	e.name = err.name;
	e.stack = err.stack;
	if (err.issues !== undefined) {
		(e as Error & { issues?: unknown }).issues = err.issues;
	}
	if (err.data) {
		for (const [key, value] of Object.entries(err.data)) {
			(e as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return e;
}

function serializeError(err: unknown): SerializedError {
	if (err instanceof Error) {
		const base: SerializedError = {
			name: err.name,
			message: err.message,
			stack: err.stack ?? "",
		};
		const source = err as unknown as Record<string, unknown>;
		if ("issues" in source && isJsonSafe(source.issues)) {
			base.issues = source.issues;
		}
		const extras: Record<string, unknown> = {};
		let hasExtras = false;
		for (const key of Object.keys(source)) {
			if (RESERVED_ERROR_KEYS.has(key)) {
				continue;
			}
			const value = source[key];
			if (!isJsonSafe(value)) {
				continue;
			}
			extras[key] = value;
			hasExtras = true;
		}
		if (hasExtras) {
			base.data = extras;
		}
		return base;
	}
	const msg = String(err);
	return { name: "Error", message: msg, stack: "" };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups worker lifecycle, init handshake, and run/dispose orchestration
async function sandbox(
	source: string,
	methods: MethodMap,
	options?: SandboxOptions,
): Promise<Sandbox> {
	const filename = options?.filename ?? "action.js";
	const methodNames = Object.keys(methods);
	const reserved = new Set<string>(methodNames);
	for (const name of RESERVED_BUILTIN_GLOBALS) {
		reserved.add(name);
	}

	const worker = new Worker(resolveWorkerUrl());

	// Persistent listener for __hostFetchForward requests when a custom
	// options.fetch is provided. Lives for the worker's lifetime because fetch
	// may be invoked at module-eval time (polyfills) before any run() is in
	// flight, and per-run listeners don't cover that window.
	const forwardFetch = options?.fetch;
	if (forwardFetch) {
		const onForwardRequest = async (msg: WorkerToMain) => {
			if (msg.type !== "request" || msg.method !== "__hostFetchForward") {
				return;
			}
			try {
				const [method, url, headers, body] = msg.args as [
					string,
					string,
					Record<string, string>,
					string | null,
				];
				const response = await forwardFetch(url, {
					method,
					headers,
					body,
				});
				const respHeaders: Record<string, string> = {};
				response.headers.forEach((v, k) => {
					respHeaders[k] = v;
				});
				const reply: MainToWorker = {
					type: "response",
					requestId: msg.requestId,
					ok: true,
					result: {
						status: response.status,
						statusText: response.statusText,
						headers: respHeaders,
						body: await response.text(),
					},
				};
				worker.postMessage(reply);
			} catch (err) {
				const reply: MainToWorker = {
					type: "response",
					requestId: msg.requestId,
					ok: false,
					error: serializeError(err),
				};
				worker.postMessage(reply);
			}
		};
		worker.on("message", onForwardRequest);
	}

	let disposed = false;
	let deathRecorded: Error | null = null;
	let onDiedCb: ((err: Error) => void) | null = null;

	function fireOnDied(err: Error): void {
		if (deathRecorded) {
			return;
		}
		deathRecorded = err;
		if (onDiedCb) {
			onDiedCb(err);
		}
	}

	// Worker-level error/exit hooks. Dispose suppresses onDied via `disposed`.
	worker.on("error", (err) => {
		if (!disposed) {
			fireOnDied(err instanceof Error ? err : new Error(String(err)));
		}
	});
	worker.on("exit", (code) => {
		if (!disposed && code !== 0) {
			fireOnDied(new Error(`worker exited with code ${code}`));
		}
	});

	// --- Init handshake ---
	await new Promise<void>((resolve, reject) => {
		const onMessage = (msg: WorkerToMain) => {
			if (msg.type === "ready") {
				worker.off("message", onMessage);
				worker.off("error", onInitError);
				worker.off("exit", onInitExit);
				resolve();
			} else if (msg.type === "init-error") {
				worker.off("message", onMessage);
				worker.off("error", onInitError);
				worker.off("exit", onInitExit);
				worker.terminate().catch(() => {
					/* ignore */
				});
				reject(errorFromSerialized(msg.error));
			}
		};
		const onInitError = (err: Error) => {
			worker.off("message", onMessage);
			worker.off("error", onInitError);
			worker.off("exit", onInitExit);
			reject(err);
		};
		const onInitExit = (code: number) => {
			worker.off("message", onMessage);
			worker.off("error", onInitError);
			worker.off("exit", onInitExit);
			reject(new Error(`worker exited during init with code ${code}`));
		};
		worker.on("message", onMessage);
		worker.on("error", onInitError);
		worker.on("exit", onInitExit);
		const initMsg: MainToWorker = {
			type: "init",
			source,
			methodNames,
			filename,
			forwardFetch: forwardFetch !== undefined,
		};
		worker.postMessage(initMsg);
	});

	// --- Per-run dispatch ---

	const pendingRunRejects = new Set<(err: Error) => void>();

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run validates args then spins up message/error/exit listeners and their cleanup inline
	function run(
		name: string,
		ctx: unknown,
		extraMethods: MethodMap = {},
	): Promise<RunResult> {
		if (disposed) {
			return Promise.reject(new Error("Sandbox is disposed"));
		}
		if (deathRecorded) {
			return Promise.reject(
				new Error(`Sandbox worker has died: ${deathRecorded.message}`),
			);
		}

		const collision = collisionName(reserved, extraMethods);
		if (collision) {
			return Promise.reject(
				new Error(
					`extraMethods name '${collision}' collides with a reserved global or construction-time method`,
				),
			);
		}

		const allMethods: MethodMap = { ...methods, ...extraMethods };
		const extraNames = Object.keys(extraMethods);

		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Promise executor sets up message/error/exit listeners and their shared cleanup as one unit
		return new Promise<RunResult>((resolve, reject) => {
			pendingRunRejects.add(reject);

			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branches handle request (method lookup + reply), response, done, error, exit paths
			const onMessage = async (msg: WorkerToMain) => {
				if (msg.type === "request") {
					// Requests handled by a persistent listener elsewhere must
					// not be answered here.
					if (msg.method === "__hostFetchForward") {
						return;
					}
					const fn = allMethods[msg.method];
					if (!fn) {
						const errMsg: MainToWorker = {
							type: "response",
							requestId: msg.requestId,
							ok: false,
							error: {
								name: "TypeError",
								message: `unknown host method: ${msg.method}`,
								stack: "",
							},
						};
						worker.postMessage(errMsg);
						return;
					}
					try {
						const result = await fn(...msg.args);
						const okMsg: MainToWorker = {
							type: "response",
							requestId: msg.requestId,
							ok: true,
							result,
						};
						worker.postMessage(okMsg);
					} catch (err) {
						const failMsg: MainToWorker = {
							type: "response",
							requestId: msg.requestId,
							ok: false,
							error: serializeError(err),
						};
						worker.postMessage(failMsg);
					}
				} else if (msg.type === "done") {
					cleanup();
					const payload: RunResultPayload = msg.payload;
					resolve(payload);
				}
			};

			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};

			const onExit = (code: number) => {
				cleanup();
				reject(new Error(`worker exited with code ${code}`));
			};

			const cleanup = () => {
				pendingRunRejects.delete(reject);
				worker.off("message", onMessage);
				worker.off("error", onError);
				worker.off("exit", onExit);
			};

			worker.on("message", onMessage);
			worker.on("error", onError);
			worker.on("exit", onExit);

			const runMsg: MainToWorker = {
				type: "run",
				exportName: name,
				ctx,
				extraNames,
			};
			worker.postMessage(runMsg);
		});
	}

	function dispose(): void {
		if (disposed) {
			return;
		}
		disposed = true;
		for (const reject of pendingRunRejects) {
			reject(new Error("Sandbox is disposed"));
		}
		pendingRunRejects.clear();
		worker.terminate().catch(() => {
			/* ignore */
		});
	}

	function onDied(cb: (err: Error) => void): void {
		onDiedCb = cb;
		if (deathRecorded) {
			cb(deathRecorded);
		}
	}

	return { run, dispose, onDied };
}

export type { LogEntry } from "./bridge-factory.js";
export type { Logger, SandboxFactory } from "./factory.js";
// biome-ignore lint/performance/noBarrelFile: public package entry surfaces the factory alongside sandbox(), intentionally a single module
export { createSandboxFactory } from "./factory.js";
export type { MethodMap } from "./install-host-methods.js";
export type { RunResult, Sandbox, SandboxOptions };
export { sandbox };
