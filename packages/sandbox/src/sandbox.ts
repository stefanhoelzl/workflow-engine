import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SandboxEvent } from "@workflow-engine/core";
import { dispatchLog } from "./log-dispatch.js";
import type { Logger } from "./logger.js";
import type { PluginDescriptor } from "./plugin.js";
import { serializePluginDescriptors } from "./plugin-compose.js";
import type {
	MainToWorker,
	SerializedError,
	WorkerToMain,
} from "./protocol.js";
import { createRunSequencer, type RunSequencer } from "./run-sequencer.js";
import {
	createWorkerTermination,
	type TerminationCause,
} from "./worker-termination.js";

function resolveWorkerUrl(): URL {
	const here = dirname(fileURLToPath(import.meta.url));
	// When sandbox source is inlined into a runtime SSR bundle (the runtime's
	// vite plugin emits a sibling `worker.js` next to `dist/main.js`), prefer
	// that sibling. Otherwise resolve relative to sandbox's own source tree:
	// from `<sandbox>/src/sandbox.ts` (vite-node dev) or `<sandbox>/dist/src/
	// sandbox.js` (compiled) → `<sandbox>/dist/src/worker.js`.
	const sibling = resolve(here, "worker.js");
	if (existsSync(sibling)) {
		return pathToFileURL(sibling);
	}
	const distSrcDir = here.includes(`${resolve("/dist/src")}`)
		? here
		: resolve(here, "..", "dist", "src");
	return pathToFileURL(resolve(distSrcDir, "worker.js"));
}

type RunResult =
	| { ok: true; result: unknown }
	| { ok: false; error: { message: string; stack: string } };

// A single main-thread host-call handler: receives the JSON args a worker
// plugin passed to `ctx.callHost(method, args)` and resolves with a
// JSON-serializable result. Handlers are built per-sandbox by the runtime,
// closure-scoped to that sandbox's (owner, workflow), and validate their
// own args/result (e.g. via the runtime's `defineHostMethod` helper).
type HostHandler = (args: readonly unknown[]) => Promise<unknown>;
type HostHandlers = Readonly<Record<string, HostHandler>>;

interface SandboxOptions {
	readonly source: string;
	readonly plugins: readonly PluginDescriptor[];
	readonly filename?: string;
	// Main-thread handlers for the worker→main host-call channel. A worker
	// plugin's `ctx.callHost(method, args)` is routed to `hostHandlers[method]`
	// here. Omitted (or absent method) ⇒ the call rejects as an unknown
	// method. The sandbox core never interprets method names or payloads
	// beyond this lookup.
	readonly hostHandlers?: HostHandlers;
	// Resource limits. All required positive integers; see
	// `openspec/specs/sandbox/spec.md` "Sandbox resource limits —
	// termination contract" for the enforcement pipeline.
	readonly memoryBytes: number;
	readonly stackBytes: number;
	readonly cpuMs: number;
	readonly outputBytes: number;
	readonly pendingCallables: number;
	// Optional sink for WorkerToMain log messages (quickjs engine diagnostics
	// from fd_write + plugin dangling-frame warnings) and main-side
	// RunSequencer warnings (close-without-open, event-outside-run, etc).
	// Omit to silently drop log lines.
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
	// sandbox owns (no owner/workflow/workflowSha/id). The runtime widens
	// to `InvocationEvent` by stamping invocation metadata in its own
	// `sb.onEvent` handler before forwarding to the bus (SECURITY.md §2 R-8).
	onEvent(cb: (event: SandboxEvent) => void): void;
	dispose(): Promise<void>;
	// Fired exactly once per worker lifecycle with a structured cause:
	// `{kind:"limit", dim, observed?}` for the five resource-limit
	// dimensions (memory/stack/cpu/output/pending), or `{kind:"crash", err}`
	// for anything else (including unknown worker exits). Suppressed when
	// `dispose()` was called first. See
	// `packages/sandbox/src/worker-termination.ts`.
	onTerminated(cb: (cause: TerminationCause) => void): void;
	// True iff a `run()` is currently in flight. Exposed so out-of-band
	// callers (e.g. the runtime's sandbox cache deciding whether to evict
	// an entry) can skip sandboxes that would race a live run. Host-side
	// read only; there is no guest-visible counterpart.
	readonly isActive: boolean;
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

// Serialize a host-side thrown error for the host-call-response channel.
// Preserves a Zod `.issues` array when present so a main-side `args`/`result`
// validation failure surfaces structured issues to the guest, mirroring the
// bridge's error round-trip.
function serializeHostError(err: unknown): SerializedError {
	if (err instanceof Error) {
		const out: SerializedError = {
			name: err.name,
			message: err.message,
			stack: err.stack ?? "",
		};
		const issues = (err as Error & { issues?: unknown }).issues;
		if (issues !== undefined) {
			out.issues = issues;
		}
		return out;
	}
	return { name: "Error", message: String(err), stack: "" };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups worker lifecycle, init handshake, run/dispose, event subscription, sequencer wiring
async function sandbox(options: SandboxOptions): Promise<Sandbox> {
	const {
		source,
		plugins,
		filename = "action.js",
		memoryBytes,
		stackBytes,
		cpuMs,
		outputBytes,
		pendingCallables,
		logger,
		hostHandlers = {},
	} = options;

	const worker = new Worker(resolveWorkerUrl());
	const termination = createWorkerTermination(worker);

	// Per-dimension budget lookup table; used when synthesising the
	// `system.exhaustion` leaf on a limit termination so the marker's
	// hover title can carry the configured cap alongside the observed
	// value (when measurable).
	const budgets: Record<"cpu" | "output" | "pending", number> = {
		cpu: cpuMs,
		output: outputBytes,
		pending: pendingCallables,
	};

	let onEventCb: ((event: SandboxEvent) => void) | null = null;
	let terminatedCause: TerminationCause | null = null;
	let terminatedCb: ((cause: TerminationCause) => void) | null = null;
	termination.onTerminated((cause) => {
		terminatedCause = cause;
		if (terminatedCb) {
			terminatedCb(cause);
		}
	});

	// Main-side RunSequencer owns seq/ref stamping. One per Sandbox; reused
	// across runs (start() opens the window; finish() zeroes state).
	const sequencer: RunSequencer = createRunSequencer(logger);

	// Forward an already-stamped SandboxEvent (from sequencer.next or
	// sequencer.finish synthesis) to the consumer.
	function forwardSandboxEvent(event: SandboxEvent): void {
		if (!onEventCb) {
			return;
		}
		try {
			onEventCb(event);
		} catch (err) {
			// Swallow callback errors so they don't kill the worker listener,
			// but surface via logger so a buggy bus consumer is visible to
			// operators rather than failing silently.
			logger?.error("sandbox.onEvent_callback_failed", {
				kind: event.kind,
				name: event.name,
				seq: event.seq,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Stamp an incoming WireEvent via the sequencer and forward the
	// resulting SandboxEvent (or drop if sequencer returned null:
	// out-of-window or close-without-matching-open — both already logged
	// by the sequencer).
	function dispatchWireEvent(wire: WorkerToMain & { type: "event" }): void {
		try {
			const stamped = sequencer.next(wire.event);
			if (stamped !== null) {
				forwardSandboxEvent(stamped);
			}
		} catch (err) {
			logger?.error("sandbox.stamp_failed", {
				kind: wire.event.kind,
				name: wire.event.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Service a worker→main host-call. Looks up `method` in `hostHandlers`,
	// awaits it, and posts the typed reply. Unknown method / handler throw both
	// reply `ok: false`. If the worker is gone (disposed/terminated) by the time
	// the handler settles, the reply is dropped — the worker-side pending call
	// was already rejected at run end / dispose.
	async function handleHostCallRequest(
		msg: WorkerToMain & { type: "host-call-request" },
	): Promise<void> {
		const handler = hostHandlers[msg.method];
		let response: MainToWorker;
		if (handler) {
			try {
				const result = await handler(msg.args);
				response = {
					type: "host-call-response",
					id: msg.id,
					ok: true,
					result,
				};
			} catch (err) {
				response = {
					type: "host-call-response",
					id: msg.id,
					ok: false,
					error: serializeHostError(err),
				};
			}
		} else {
			response = {
				type: "host-call-response",
				id: msg.id,
				ok: false,
				error: serializeHostError(
					new Error(`unknown host-call method: ${msg.method}`),
				),
			};
		}
		if (disposed) {
			return;
		}
		try {
			worker.postMessage(response);
		} catch {
			// Worker terminated between settle and post — drop.
		}
	}

	const onPersistentMessage = (msg: WorkerToMain) => {
		if (msg.type === "event") {
			dispatchWireEvent(msg);
			return;
		}
		if (msg.type === "host-call-request") {
			// Fire-and-forget: handleHostCallRequest catches its own errors and
			// posts the reply (or drops it if the worker is gone), so it never
			// rejects. Matches the bare-call style of `startRestore`.
			handleHostCallRequest(msg);
			return;
		}
		if (msg.type === "log") {
			dispatchLog(logger, msg);
			return;
		}
		if (msg.type === "restore-failed") {
			// Worker reported a structured snapshot-restore failure — typed
			// MessagePort message, ordered AFTER `done` for the just-finished
			// run. Route through termination so `onTerminated` fires with
			// `kind:"restore-failed"`. The in-flight `sb.run()` (if any) has
			// already resolved via `done`; subsequent runs reject through the
			// `terminatedCause` guard.
			termination.markRestoreFailed(errorFromSerialized(msg.error));
			return;
		}
	};
	worker.on("message", onPersistentMessage);

	let disposed = false;

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
			memoryBytes,
			stackBytes,
			outputBytes,
			pendingCallables,
		};
		worker.postMessage(initMsg);
	});

	// --- Run dispatch ---

	const pendingRunRejects = new Set<(err: Error) => void>();
	// In-flight tracker for concurrency control + isActive surface. Distinct
	// from the sequencer's internal `runActive` (which gates stamping).
	let runInFlight = false;

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: run() encapsulates the full run-dispatch lifecycle (precondition checks, cpu watchdog arm/disarm, sequencer start, worker postMessage, message/error/exit listeners, finalize with limit-aware death synthesis) as one cohesive promise — splitting would shuttle mutable state across helpers.
	function run(
		name: string,
		ctx: unknown,
		extras?: unknown,
	): Promise<RunResult> {
		if (disposed) {
			return Promise.reject(new Error("Sandbox is disposed"));
		}
		if (terminatedCause) {
			let msg: string;
			if (terminatedCause.kind === "crash") {
				msg = terminatedCause.err.message;
			} else if (terminatedCause.kind === "restore-failed") {
				msg = `restore-failed: ${terminatedCause.err.message}`;
			} else {
				msg = `limit ${terminatedCause.dim}`;
			}
			return Promise.reject(new Error(`Sandbox worker has died: ${msg}`));
		}
		if (runInFlight) {
			return Promise.reject(
				new Error(
					"sandbox.run: concurrent run not permitted; a previous run is still in flight",
				),
			);
		}

		// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Promise executor binds the per-run state machine (cpu watchdog arm/disarm, sequencer start, finalize, limit-aware death synthesis, one-shot message/error/exit listeners) into one closure — extracting helpers would shuttle the same mutable state across call frames.
		return new Promise<RunResult>((resolve, reject) => {
			pendingRunRejects.add(reject);
			runInFlight = true;
			// Open the sequencer window BEFORE posting the run message —
			// any wire events that arrive while the run is starting will
			// be stamped against a fresh seq=0/empty refStack/empty callMap.
			sequencer.start();
			termination.armCpuBudget(cpuMs);

			let finished = false;

			function finalize(synth: SandboxEvent[], settle: () => void): void {
				if (finished) {
					return;
				}
				finished = true;
				pendingRunRejects.delete(reject);
				worker.off("message", onMessage);
				worker.off("error", onError);
				worker.off("exit", onExit);
				termination.disarmCpuBudget();
				for (const evt of synth) {
					forwardSandboxEvent(evt);
				}
				runInFlight = false;
				settle();
			}

			function buildLimitLeaf(
				cause: Extract<TerminationCause, { kind: "limit" }>,
			): SandboxEvent | null {
				const now = Date.now();
				const wireLeaf = {
					kind: "system.exhaustion",
					name: cause.dim,
					ts: now,
					at: new Date(now).toISOString(),
					input: {
						budget: budgets[cause.dim],
						...(cause.observed === undefined
							? {}
							: { observed: cause.observed }),
					},
					type: "leaf" as const,
				};
				return sequencer.next(wireLeaf);
			}

			function handleDeath(fallbackErr: Error): void {
				const cause = termination.cause();
				if (cause?.kind === "limit") {
					const leaf = buildLimitLeaf(cause);
					if (leaf !== null) {
						forwardSandboxEvent(leaf);
					}
					const synth = sequencer.finish({
						closeReason: `limit:${cause.dim}`,
					});
					const limitErr = new Error(`sandbox limit exceeded: ${cause.dim}`);
					finalize(synth, () => reject(limitErr));
					return;
				}
				let closeReason: string;
				if (cause?.kind === "crash") {
					closeReason = `crash:${cause.err.message}`;
				} else if (cause?.kind === "restore-failed") {
					closeReason = `restore-failed:${cause.err.message}`;
				} else {
					closeReason = fallbackErr.message;
				}
				finalize(sequencer.finish({ closeReason }), () => reject(fallbackErr));
			}

			const onMessage = (msg: WorkerToMain) => {
				if (msg.type === "done") {
					finalize(sequencer.finish(), () => resolve(msg.payload));
				}
			};

			const onError = (err: Error) => {
				handleDeath(err);
			};

			const onExit = (code: number) => {
				handleDeath(new Error(`worker exited with code ${code}`));
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

	let terminatePromise: Promise<void> | null = null;
	function dispose(): Promise<void> {
		if (terminatePromise) {
			return terminatePromise;
		}
		disposed = true;
		termination.markDisposing();
		for (const reject of pendingRunRejects) {
			reject(new Error("Sandbox is disposed"));
		}
		pendingRunRejects.clear();
		terminatePromise = worker.terminate().then(() => undefined);
		return terminatePromise;
	}

	function onTerminated(cb: (cause: TerminationCause) => void): void {
		terminatedCb = cb;
		if (terminatedCause) {
			cb(terminatedCause);
		}
	}

	function onEvent(cb: (event: SandboxEvent) => void): void {
		onEventCb = cb;
	}

	return {
		run,
		onEvent,
		dispose,
		onTerminated,
		get isActive() {
			return runInFlight;
		},
	};
}

export type { HostHandler, HostHandlers, RunResult, Sandbox, SandboxOptions };
export { sandbox };
