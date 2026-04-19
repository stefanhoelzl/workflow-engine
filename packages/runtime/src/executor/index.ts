import type { WorkflowManifest } from "@workflow-engine/core";
import type { Sandbox } from "@workflow-engine/sandbox";
import type { EventBus } from "../event-bus/index.js";
import type { SandboxStore } from "../sandbox-store.js";
import { createRunQueue, type RunQueue } from "./run-queue.js";
import type { InvokeResult, TriggerDescriptor } from "./types.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
//
// The executor resolves the sandbox via the injected SandboxStore,
// serializes invocations per (tenant, workflow.sha), wires the sandbox's
// onEvent stream to the bus, and calls sandbox.run. The sandbox emits
// trigger.request/response/error events itself — the executor does not
// construct lifecycle events.
//
// The executor is kind-agnostic: it returns a discriminated `InvokeResult`
// envelope. Each `TriggerSource` decides the protocol-level response on
// failure (HTTP 500 for the HTTP source; log-and-drop for cron; ...).

interface ExecutorOptions {
	readonly bus: EventBus;
	readonly sandboxStore: SandboxStore;
}

interface Executor {
	invoke(
		tenant: string,
		workflow: WorkflowManifest,
		descriptor: TriggerDescriptor,
		input: unknown,
		bundleSource: string,
	): Promise<InvokeResult<unknown>>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups runQueue management, onEvent wiring, sequential emit tail, and invocation dispatch
function createExecutor(options: ExecutorOptions): Executor {
	const { bus, sandboxStore } = options;
	const queues = new Map<string, RunQueue>();
	// Per-sandbox queue of pending bus.emit promises. The onEvent callback
	// chains each new emit onto this tail so emits stay sequential per
	// sandbox, and runInvocation awaits the tail before returning to give
	// callers a "events committed before response" guarantee.
	const emitTails = new WeakMap<Sandbox, Promise<void>>();
	const wired = new WeakSet<Sandbox>();

	function queueFor(key: string): RunQueue {
		let q = queues.get(key);
		if (!q) {
			q = createRunQueue();
			queues.set(key, q);
		}
		return q;
	}

	function ensureWired(sb: Sandbox): void {
		if (wired.has(sb)) {
			return;
		}
		emitTails.set(sb, Promise.resolve());
		sb.onEvent((event) => {
			const prev = emitTails.get(sb) ?? Promise.resolve();
			const next = prev.then(() =>
				bus.emit(event).catch(() => {
					/* swallow consumer errors — they shouldn't block the next emit */
				}),
			);
			emitTails.set(sb, next);
		});
		wired.add(sb);
	}

	// biome-ignore lint/complexity/useMaxParams: invocation fan-in — tenant + workflow + descriptor + input + bundleSource are orthogonal and already packaged by the caller
	async function runInvocation(
		tenant: string,
		workflow: WorkflowManifest,
		descriptor: TriggerDescriptor,
		input: unknown,
		bundleSource: string,
	): Promise<InvokeResult<unknown>> {
		const sb = await sandboxStore.get(tenant, workflow, bundleSource);
		ensureWired(sb);
		const invocationId = newInvocationId();
		let result: InvokeResult<unknown>;
		try {
			const runResult = await sb.run(descriptor.name, input, {
				invocationId,
				tenant,
				workflow: workflow.name,
				workflowSha: workflow.sha,
			});
			if (runResult.ok) {
				result = { ok: true, output: runResult.result };
			} else {
				result = {
					ok: false,
					error: {
						message: runResult.error.message,
						...(runResult.error.stack ? { stack: runResult.error.stack } : {}),
					},
				};
			}
		} catch (err) {
			result = {
				ok: false,
				error: {
					message: err instanceof Error ? err.message : String(err),
					...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
				},
			};
		}
		// Wait for all in-flight bus emits to settle so callers see a
		// "persistence committed before response" guarantee.
		await (emitTails.get(sb) ?? Promise.resolve());
		return result;
	}

	return {
		// biome-ignore lint/complexity/useMaxParams: matches Executor.invoke contract
		invoke(tenant, workflow, descriptor, input, bundleSource) {
			return queueFor(`${tenant}/${workflow.sha}`).run(() =>
				runInvocation(tenant, workflow, descriptor, input, bundleSource),
			);
		},
	};
}

export type { RunQueue } from "./run-queue.js";
// biome-ignore lint/performance/noBarrelFile: executor entry point re-exports its siblings (run-queue, descriptors) so consumers have a single module to import from
export { createRunQueue } from "./run-queue.js";
export type {
	ActionDescriptor,
	BaseTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
	TriggerDescriptor,
} from "./types.js";
export type { Executor, ExecutorOptions };
export { createExecutor };
