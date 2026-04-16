import type { HttpTriggerResult } from "@workflow-engine/core";
import type { EventBus } from "../event-bus/index.js";
import { createRunQueue, type RunQueue } from "./run-queue.js";
import type { WorkflowRunner } from "./types.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
//
// The executor generates an invocation id, wires the workflow's onEvent stream
// to the bus, and calls invokeHandler. The sandbox emits trigger.request /
// trigger.response / trigger.error events itself — the executor no longer
// constructs lifecycle events.

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
}

interface Executor {
	invoke(
		workflow: WorkflowRunner,
		triggerName: string,
		payload: unknown,
	): Promise<HttpTriggerResult>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups runQueue management, onEvent wiring, sequential emit tail, and HTTP-result shaping
function createExecutor(options: ExecutorOptions): Executor {
	const { bus } = options;
	const queues = new Map<string, RunQueue>();
	// Per-workflow queue of pending bus.emit promises. The onEvent callback
	// chains each new emit onto this tail so emits stay sequential per
	// workflow, and runInvocation awaits the tail before returning to give
	// callers a "events committed before HTTP response" guarantee.
	const emitTails = new WeakMap<WorkflowRunner, Promise<void>>();
	const wired = new WeakSet<WorkflowRunner>();

	function queueFor(name: string): RunQueue {
		let q = queues.get(name);
		if (!q) {
			q = createRunQueue();
			queues.set(name, q);
		}
		return q;
	}

	function ensureWired(workflow: WorkflowRunner): void {
		if (wired.has(workflow)) {
			return;
		}
		emitTails.set(workflow, Promise.resolve());
		workflow.onEvent((event) => {
			const prev = emitTails.get(workflow) ?? Promise.resolve();
			const next = prev.then(() =>
				bus.emit(event).catch(() => {
					/* swallow consumer errors — they shouldn't block the next emit */
				}),
			);
			emitTails.set(workflow, next);
		});
		wired.add(workflow);
	}

	async function runInvocation(
		workflow: WorkflowRunner,
		triggerName: string,
		payload: unknown,
	): Promise<HttpTriggerResult> {
		ensureWired(workflow);
		const invocationId = newInvocationId();
		let result: HttpTriggerResult;
		try {
			const raw = await workflow.invokeHandler(
				invocationId,
				triggerName,
				payload,
			);
			result = shapeResult(raw);
		} catch {
			result = ERROR_RESPONSE;
		}
		// Wait for all in-flight bus emits to settle so callers see a
		// "persistence committed before response" guarantee.
		await (emitTails.get(workflow) ?? Promise.resolve());
		return result;
	}

	return {
		invoke(workflow, triggerName, payload) {
			return queueFor(workflow.name).run(() =>
				runInvocation(workflow, triggerName, payload),
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
	WorkflowRunner,
} from "./types.js";
export type { Executor, ExecutorOptions };
export { createExecutor };
