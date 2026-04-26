import type {
	EventKind,
	InvocationEvent,
	InvocationEventError,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { EventBus } from "../event-bus/index.js";
import type { TriggerDescriptor } from "./types.js";

// ---------------------------------------------------------------------------
// trigger.exception emission primitive (executor-internal)
// ---------------------------------------------------------------------------
//
// `trigger.exception` is a leaf event for *author-fixable* trigger setup
// failures that happen host-side, before any handler runs. It bypasses the
// sandbox / RunSequencer entirely: there is no run, no frame, no paired
// `trigger.request`. This module is the single chokepoint where the
// SECURITY.md §2 R-8 host-side stamping carve-out is enforced — the
// `assertTriggerExceptionKind` guard prevents future contributors from
// extending the bypass to other event kinds.
//
// Consumed only by `executor.fail`. `TriggerSource` implementations and
// trigger-source factory modules MUST NOT import this file directly; they
// route through `entry.exception(params)` on the `TriggerEntry` they
// receive from the registry, which delegates to `executor.fail`, which
// owns this primitive.

interface TriggerExceptionParams {
	readonly name: string;
	readonly error: { readonly message: string };
	readonly details?: Readonly<Record<string, unknown>>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

function assertTriggerExceptionKind(kind: EventKind): void {
	if (kind !== "trigger.exception") {
		throw new Error(
			`emitTriggerException: kind must be "trigger.exception" (got ${JSON.stringify(kind)}); R-8 host-side carve-out covers this kind only`,
		);
	}
}

// biome-ignore lint/complexity/useMaxParams: identity bag is the same shape executor.invoke takes — flattening avoids an allocation per failure
async function emitTriggerException(
	bus: EventBus,
	owner: string,
	repo: string,
	workflow: WorkflowManifest,
	descriptor: TriggerDescriptor,
	params: TriggerExceptionParams,
): Promise<void> {
	const kind: EventKind = "trigger.exception";
	assertTriggerExceptionKind(kind);
	const error: InvocationEventError = { message: params.error.message };
	const event: InvocationEvent = {
		id: newInvocationId(),
		owner,
		repo,
		workflow: workflow.name,
		workflowSha: workflow.sha,
		kind,
		name: params.name,
		seq: 0,
		ref: 0,
		ts: 0,
		at: new Date().toISOString(),
		input: {
			trigger: descriptor.name,
			...(params.details ?? {}),
		},
		error,
	};
	await bus.emit(event);
}

export type { TriggerExceptionParams };
export { emitTriggerException };
