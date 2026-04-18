import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { IIFE_NAMESPACE, type InvocationEvent } from "@workflow-engine/core";
import type { MethodMap } from "./install-host-methods.js";
import { dispatchLog } from "./log-dispatch.js";
import type {
	MainToWorker,
	RunResultPayload,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";

function resolveWorkerUrl(): URL {
	const here = dirname(fileURLToPath(import.meta.url));
	const distSrcDir = here.includes(`${resolve("/dist/src")}`)
		? here
		: resolve(here, "..", "dist", "src");
	return pathToFileURL(resolve(distSrcDir, "worker.js"));
}

type RunResult =
	| { ok: true; result: unknown }
	| { ok: false; error: { message: string; stack: string } };

interface RunOptions {
	readonly invocationId: string;
	readonly workflow: string;
	readonly workflowSha: string;
	readonly extraMethods?: MethodMap;
}

interface Logger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
}

interface SandboxOptions {
	filename?: string;
	fetch?: typeof globalThis.fetch;
	// Optional event-name overrides for construction-time methods. The bridge
	// uses these to label `system.*` events (e.g. `__hostCallAction` →
	// `host.validateAction`). Without an entry, the method name itself is used.
	methodEventNames?: Record<string, string>;
	// Maximum memory (in bytes) the QuickJS runtime is allowed to allocate.
	// Exceeding it triggers an OOM error inside the guest. Passed directly
	// to QuickJS.create({ memoryLimit }).
	memoryLimit?: number;
	// Optional sink for WorkerToMain log messages (quickjs engine diagnostics
	// from fd_write). Omit to silently drop engine log lines.
	logger?: Logger;
}

interface Sandbox {
	run(name: string, ctx: unknown, options?: RunOptions): Promise<RunResult>;
	onEvent(cb: (event: InvocationEvent) => void): void;
	dispose(): void;
	onDied(cb: (err: Error) => void): void;
}

const DEFAULT_RUN_OPTIONS: RunOptions = {
	invocationId: "evt_test",
	workflow: "test",
	workflowSha: "",
};

// Hiding of sandbox-internal bridges (__hostFetch, __emitEvent) is enforced
// by capture-and-delete shims in globals.ts / worker.ts — not by this list.
// A host that deliberately passes `extraMethods: { __hostFetch: ... }` is
// honoring their conscious choice to reinstall the name for the duration of
// a single run; the sandbox's shim-captured reference from init is invariant
// regardless.
const RESERVED_BUILTIN_GLOBALS = new Set([
	"console",
	"performance",
	"crypto",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"fetch",
	"reportError",
	"self",
	"navigator",
	"URL",
	"URLSearchParams",
	"URLPattern",
	"TextEncoder",
	"TextDecoder",
	"atob",
	"btoa",
	"structuredClone",
	"Headers",
	"EventTarget",
	"Event",
	"ErrorEvent",
	"AbortController",
	"AbortSignal",
	"DOMException",
	"PerformanceEntry",
	"PerformanceMark",
	"PerformanceMeasure",
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups worker lifecycle, init handshake, run/dispose, event subscription
async function sandbox(
	source: string,
	methods: MethodMap,
	options?: SandboxOptions,
): Promise<Sandbox> {
	const filename = options?.filename ?? "action.js";
	const methodNames = Object.keys(methods);
	// extraMethods collision set contains only true built-ins + the IIFE
	// namespace. Extra-methods MAY override construction-time methods (the
	// per-run override pattern used by __reportError in tests).
	const extraMethodsReserved = new Set<string>(RESERVED_BUILTIN_GLOBALS);
	extraMethodsReserved.add(IIFE_NAMESPACE);

	// Check construction-time method names against the same built-in set.
	for (const name of methodNames) {
		if (extraMethodsReserved.has(name)) {
			throw new Error(
				`method name '${name}' collides with a reserved global or the IIFE namespace`,
			);
		}
	}

	const worker = new Worker(resolveWorkerUrl());

	let onEventCb: ((event: InvocationEvent) => void) | null = null;
	const logger = options?.logger;

	function dispatchEvent(event: InvocationEvent): void {
		if (!onEventCb) {
			return;
		}
		try {
			onEventCb(event);
		} catch {
			// Swallow callback errors so they don't kill the worker listener.
		}
	}

	// Persistent listener: forwards events from worker to onEvent callback
	// AND forwards __hostFetchForward requests when forwardFetch is set.
	const forwardFetch = options?.fetch;
	const onPersistentMessage = async (msg: WorkerToMain) => {
		if (msg.type === "event") {
			dispatchEvent(msg.event);
			return;
		}
		if (msg.type === "log") {
			dispatchLog(logger, msg);
			return;
		}
		if (
			forwardFetch &&
			msg.type === "request" &&
			msg.method === "__hostFetchForward"
		) {
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
		}
	};
	worker.on("message", onPersistentMessage);

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
			...(options?.methodEventNames
				? { methodEventNames: options.methodEventNames }
				: {}),
			filename,
			forwardFetch: forwardFetch !== undefined,
			...(options?.memoryLimit === undefined
				? {}
				: { memoryLimit: options.memoryLimit }),
		};
		worker.postMessage(initMsg);
	});

	// --- Per-run dispatch ---

	const pendingRunRejects = new Set<(err: Error) => void>();

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run validates args then sets up message/error/exit listeners and their cleanup inline
	function run(
		name: string,
		ctx: unknown,
		runOptions: RunOptions = DEFAULT_RUN_OPTIONS,
	): Promise<RunResult> {
		if (disposed) {
			return Promise.reject(new Error("Sandbox is disposed"));
		}
		if (deathRecorded) {
			return Promise.reject(
				new Error(`Sandbox worker has died: ${deathRecorded.message}`),
			);
		}

		const extraMethods = runOptions.extraMethods ?? {};
		const collision = collisionName(extraMethodsReserved, extraMethods);
		if (collision) {
			return Promise.reject(
				new Error(
					`extraMethods name '${collision}' collides with a reserved global or the IIFE namespace`,
				),
			);
		}

		const allMethods: MethodMap = { ...methods, ...extraMethods };
		const extraNames = Object.keys(extraMethods);

		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Promise executor sets up message/error/exit listeners and their shared cleanup as one unit
		return new Promise<RunResult>((resolve, reject) => {
			pendingRunRejects.add(reject);

			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branches handle request, done, error, exit paths
			const onMessage = async (msg: WorkerToMain) => {
				if (msg.type === "request") {
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
				invocationId: runOptions.invocationId,
				workflow: runOptions.workflow,
				workflowSha: runOptions.workflowSha,
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

	function onEvent(cb: (event: InvocationEvent) => void): void {
		onEventCb = cb;
	}

	return { run, onEvent, dispose, onDied };
}

export type { SandboxFactory } from "./factory.js";
// biome-ignore lint/performance/noBarrelFile: public package entry surfaces the factory alongside sandbox(), intentionally a single module
export { createSandboxFactory } from "./factory.js";
export type { MethodMap } from "./install-host-methods.js";
export type { Logger, RunOptions, RunResult, Sandbox, SandboxOptions };
export { sandbox };
