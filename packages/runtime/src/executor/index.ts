import type {
	HttpTriggerResult,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { Sandbox } from "@workflow-engine/sandbox";
import type { EventBus } from "../event-bus/index.js";
import type { SandboxStore } from "../sandbox-store.js";
import { createRunQueue, type RunQueue } from "./run-queue.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
//
// The executor takes (tenant, workflow, triggerName, payload, bundleSource),
// resolves the sandbox via the injected SandboxStore, serializes invocations
// per (tenant, workflow.sha), wires the sandbox's onEvent stream to the bus,
// and calls sandbox.run. The sandbox emits trigger.request/response/error
// events itself — the executor does not construct lifecycle events.

const DEFAULT_STATUS = 200;
const DEFAULT_BODY = "";
const ERROR_STATUS = 500;

function defaultResult(): HttpTriggerResult {
	return { status: DEFAULT_STATUS, body: DEFAULT_BODY, headers: {} };
}

function shapeResult(value: unknown): HttpTriggerResult {
	if (value === undefined || value === null) {
		return defaultResult();
	}
	if (typeof value !== "object") {
		return { status: DEFAULT_STATUS, body: value, headers: {} };
	}
	const obj = value as Record<string, unknown>;
	const status =
		typeof obj.status === "number" ? (obj.status as number) : DEFAULT_STATUS;
	const body = "body" in obj ? obj.body : DEFAULT_BODY;
	const headers =
		obj.headers && typeof obj.headers === "object"
			? (obj.headers as Record<string, string>)
			: {};
	return { status, body, headers };
}

const ERROR_RESPONSE: HttpTriggerResult = {
	status: ERROR_STATUS,
	body: { error: "internal_error" },
	headers: {},
};

interface ExecutorOptions {
	readonly bus: EventBus;
	readonly sandboxStore: SandboxStore;
}

interface Executor {
	invoke(
		tenant: string,
		workflow: WorkflowManifest,
		triggerName: string,
		payload: unknown,
		bundleSource: string,
	): Promise<HttpTriggerResult>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups runQueue management, onEvent wiring, sequential emit tail, and HTTP-result shaping
function createExecutor(options: ExecutorOptions): Executor {
	const { bus, sandboxStore } = options;
	const queues = new Map<string, RunQueue>();
	// Per-sandbox queue of pending bus.emit promises. The onEvent callback
	// chains each new emit onto this tail so emits stay sequential per
	// sandbox, and runInvocation awaits the tail before returning to give
	// callers a "events committed before HTTP response" guarantee.
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

	// biome-ignore lint/complexity/useMaxParams: invocation fan-in — tenant + workflow metadata + trigger name + payload + bundle source are orthogonal and already packaged by the caller
	async function runInvocation(
		tenant: string,
		workflow: WorkflowManifest,
		triggerName: string,
		payload: unknown,
		bundleSource: string,
	): Promise<HttpTriggerResult> {
		const sb = await sandboxStore.get(tenant, workflow, bundleSource);
		ensureWired(sb);
		const invocationId = newInvocationId();
		let result: HttpTriggerResult;
		try {
			const runResult = await sb.run(triggerName, payload, {
				invocationId,
				tenant,
				workflow: workflow.name,
				workflowSha: workflow.sha,
			});
			if (!runResult.ok) {
				const err = new Error(runResult.error.message);
				err.stack = runResult.error.stack;
				throw err;
			}
			result = shapeResult(runResult.result);
		} catch {
			result = ERROR_RESPONSE;
		}
		// Wait for all in-flight bus emits to settle so callers see a
		// "persistence committed before response" guarantee.
		await (emitTails.get(sb) ?? Promise.resolve());
		return result;
	}

	return {
		// biome-ignore lint/complexity/useMaxParams: matches Executor.invoke contract
		invoke(tenant, workflow, triggerName, payload, bundleSource) {
			return queueFor(`${tenant}/${workflow.sha}`).run(() =>
				runInvocation(tenant, workflow, triggerName, payload, bundleSource),
			);
		},
	};
}

export type { RunQueue } from "./run-queue.js";
// biome-ignore lint/performance/noBarrelFile: executor entry point re-exports its siblings (run-queue, descriptors) so consumers have a single module to import from
export { createRunQueue } from "./run-queue.js";
export type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	TriggerDescriptor,
} from "./types.js";
export type { Executor, ExecutorOptions };
export { createExecutor };
