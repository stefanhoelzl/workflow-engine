import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SandboxEvent } from "@workflow-engine/core";
import { dispatchLog } from "./log-dispatch.js";
import type { PluginDescriptor } from "./plugin.js";
import { serializePluginDescriptors } from "./plugin-compose.js";
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

interface Logger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
}

interface SandboxOptions {
	readonly source: string;
	readonly plugins: readonly PluginDescriptor[];
	readonly filename?: string;
	// Maximum memory (in bytes) the QuickJS runtime is allowed to allocate.
	// Exceeding it triggers an OOM error inside the guest. Passed directly
	// to QuickJS.create({ memoryLimit }).
	readonly memoryLimit?: number;
	// Optional sink for WorkerToMain log messages (quickjs engine diagnostics
	// from fd_write + plugin dangling-frame warnings). Omit to silently drop
	// engine log lines.
	readonly logger?: Logger;
}

interface Sandbox {
	// `run()` rejects if another run is still in flight on this sandbox — the
	// sandbox serves one run at a time. Callers (the runtime executor) are
	// expected to serialize; a second call while one is active is a caller
	// bug.
	//
	// `extras` is an opaque per-run channel reserved for plugins that need
	// per-invocation payloads outside the `ctx` envelope. Currently unused
	// in-tree; see `RunInput.extras` in plugin.ts.
	run(name: string, ctx: unknown, extras?: unknown): Promise<RunResult>;
	// Subscriber receives `SandboxEvent` — the subset of event fields the
	// sandbox owns (no tenant/workflow/workflowSha/id). The runtime widens
	// to `InvocationEvent` by stamping invocation metadata in its own
	// `sb.onEvent` handler before forwarding to the bus (SECURITY.md §2 R-8).
	onEvent(cb: (event: SandboxEvent) => void): void;
	dispose(): void;
	onDied(cb: (err: Error) => void): void;
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups worker lifecycle, init handshake, run/dispose, event subscription
async function sandbox(options: SandboxOptions): Promise<Sandbox> {
	const {
		source,
		plugins,
		filename = "action.js",
		memoryLimit,
		logger,
	} = options;

	const worker = new Worker(resolveWorkerUrl());

	let onEventCb: ((event: SandboxEvent) => void) | null = null;

	// Events from the worker arrive as `SandboxEvent` (no tenant/workflow/
	// workflowSha/id). They flow straight to the subscriber — the runtime
	// widens by stamping invocation metadata in its `sb.onEvent` handler,
	// so the sandbox package stays ignorant of runtime identity.
	function dispatchEvent(event: SandboxEvent): void {
		if (!onEventCb) {
			return;
		}
		try {
			onEventCb(event);
		} catch {
			// Swallow callback errors so they don't kill the worker listener.
		}
	}

	const onPersistentMessage = (msg: WorkerToMain) => {
		if (msg.type === "event") {
			dispatchEvent(msg.event);
			return;
		}
		if (msg.type === "log") {
			dispatchLog(logger, msg);
			return;
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
		// Validate + freeze plugin descriptors before handing them to the
		// worker. `serializePluginDescriptors` enforces JSON-serializable
		// config, name uniqueness, dependsOn resolution — a bad descriptor
		// array rejects init here (before the worker is even spawned)
		// rather than inside the Phase-1a loader.
		const validatedPlugins = serializePluginDescriptors(plugins);
		const initMsg: MainToWorker = {
			type: "init",
			source,
			filename,
			pluginDescriptors: validatedPlugins,
			...(memoryLimit === undefined ? {} : { memoryLimit }),
		};
		worker.postMessage(initMsg);
	});

	// --- Run dispatch ---

	const pendingRunRejects = new Set<(err: Error) => void>();
	// Concurrent-run guard. The sandbox serves one run at a time; the
	// executor is expected to queue per-(tenant, sha). A second `run()`
	// while one is active rejects loudly rather than silently interleaving.
	let runActive = false;

	function run(
		name: string,
		ctx: unknown,
		extras?: unknown,
	): Promise<RunResult> {
		if (disposed) {
			return Promise.reject(new Error("Sandbox is disposed"));
		}
		if (deathRecorded) {
			return Promise.reject(
				new Error(`Sandbox worker has died: ${deathRecorded.message}`),
			);
		}
		if (runActive) {
			return Promise.reject(
				new Error(
					"sandbox.run: concurrent run not permitted; a previous run is still in flight",
				),
			);
		}

		return new Promise<RunResult>((resolve, reject) => {
			pendingRunRejects.add(reject);
			runActive = true;

			const onMessage = (msg: WorkerToMain) => {
				if (msg.type === "done") {
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
				runActive = false;
			};

			worker.on("message", onMessage);
			worker.on("error", onError);
			worker.on("exit", onExit);

			const runMsg: MainToWorker = {
				type: "run",
				exportName: name,
				ctx,
				...(extras === undefined ? {} : { extras }),
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

	function onEvent(cb: (event: SandboxEvent) => void): void {
		onEventCb = cb;
	}

	return { run, onEvent, dispose, onDied };
}

export type { Logger, RunResult, Sandbox, SandboxOptions };
export { sandbox };
