import type { HttpTriggerResult } from "@workflow-engine/sdk";
import type { EventBus, SerializedErrorPayload } from "../event-bus/index.js";
import { newInvocation } from "./invocation.js";
import { createRunQueue, type RunQueue } from "./run-queue.js";
import type { WorkflowRunner } from "./types.js";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
//
// The executor owns the trigger-invocation lifecycle: allocate an id + start
// event, serialize per-workflow via a runQueue, dispatch the handler through
// the workflow's runner, shape the HTTP response, and emit completed/failed
// events to the bus. It is intentionally unaware of persistence; the bus is
// the single coordination point.
//
// The executor owns lifecycle emission (no separate EventSource). Bus dispatch
// is awaited so persistence commits before the executor returns — this gives
// the HTTP middleware a commit-before-observe guarantee for free.

const DEFAULT_STATUS = 200;
const DEFAULT_BODY = "";
const ERROR_STATUS = 500;

function defaultResult(): HttpTriggerResult {
	return { status: DEFAULT_STATUS, body: DEFAULT_BODY, headers: {} };
}

function shapeResult(value: unknown): HttpTriggerResult {
	// Handlers may return undefined, a partial { status?, body?, headers? }, or
	// a full HttpTriggerResult. Apply defaults per the executor spec.
	if (value === undefined || value === null) {
		return defaultResult();
	}
	if (typeof value !== "object") {
		// Primitive return — treat as body with defaults.
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

function serializeError(err: unknown): SerializedErrorPayload {
	if (err instanceof Error) {
		const base: SerializedErrorPayload = {
			message: err.message,
			stack: err.stack ?? "",
		};
		const source = err as unknown as Record<string, unknown>;
		if ("issues" in source) {
			return { ...base, issues: source.issues };
		}
		return base;
	}
	return { message: String(err), stack: "" };
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

function createExecutor(options: ExecutorOptions): Executor {
	const { bus } = options;
	// One runQueue per workflow — keyed by name. The registry is expected to
	// pass a stable WorkflowRunner reference for each workflow, so we could
	// key by identity; name-keying survives re-loads and keeps the executor
	// uncoupled from registry lifecycle semantics.
	const queues = new Map<string, RunQueue>();

	function queueFor(name: string): RunQueue {
		let q = queues.get(name);
		if (!q) {
			q = createRunQueue();
			queues.set(name, q);
		}
		return q;
	}

	async function runInvocation(
		workflow: WorkflowRunner,
		triggerName: string,
		payload: unknown,
	): Promise<HttpTriggerResult> {
		const invocation = newInvocation({
			workflow: workflow.name,
			trigger: triggerName,
			payload,
		});

		// Emit `started` BEFORE the handler runs so persistence has a pending
		// file if we crash mid-handler. Failures inside the started emit
		// propagate — the HTTP middleware turns them into 500.
		await bus.emit(invocation.startedEvent);

		let result: HttpTriggerResult;
		try {
			const raw = await workflow.invokeHandler(triggerName, payload);
			result = shapeResult(raw);
		} catch (err) {
			const failedEvent = invocation.fail(serializeError(err));
			await bus.emit(failedEvent);
			return ERROR_RESPONSE;
		}

		const completedEvent = invocation.complete(result);
		await bus.emit(completedEvent);
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

export type { Invocation } from "./invocation.js";
// biome-ignore lint/performance/noBarrelFile: executor entry point re-exports its siblings (invocation factory, run-queue, descriptors) so consumers have a single module to import from; the alternative — deep-path imports across the runtime — is worse for refactor safety
export { newInvocation } from "./invocation.js";
export type { RunQueue } from "./run-queue.js";
export { createRunQueue } from "./run-queue.js";
export type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	TriggerDescriptor,
	WorkflowRunner,
} from "./types.js";
export type { Executor, ExecutorOptions };
export { createExecutor };
