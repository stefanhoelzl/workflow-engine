import type {
	EventKind,
	InvocationEvent,
	InvocationEventError,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { EventStore } from "../event-store.js";
import type { TriggerDescriptor } from "./types.js";

// ---------------------------------------------------------------------------
// host-side fail emission primitive (executor-internal)
// ---------------------------------------------------------------------------
//
// Two leaf event kinds bypass the sandbox / RunSequencer entirely and emit
// directly onto the bus from the host: `trigger.exception` (author-fixable
// trigger setup failures — IMAP misconfig, cron schedule invalid) and
// `trigger.rejection` (HTTP webhook body schema validation rejected the
// caller's payload). Both are single-leaf, both have no paired
// `trigger.request`, neither carries `meta.dispatch`.
//
// This module is the single chokepoint where the SECURITY.md §2 R-8 host-side
// stamping carve-out is enforced — the `assertHostFailKind` guard prevents
// future contributors from extending the bypass to other event kinds.
//
// Consumed only by `executor.fail`. `TriggerSource` implementations and
// trigger-source factory modules MUST NOT import this file directly; they
// route through `entry.exception(params)` on the `TriggerEntry` they
// receive from the registry, which delegates to `executor.fail`, which
// owns this primitive.

type HostFailKind = "trigger.exception" | "trigger.rejection";

interface TriggerExceptionParams {
	// Defaults to `"trigger.exception"` when omitted.
	readonly kind?: HostFailKind;
	readonly name: string;
	readonly error?: { readonly message: string };
	// Kind-specific payload (e.g. trigger.exception → `{stage, failedUids}`,
	// trigger.rejection → `{issues, method, path}`). Merged into the event's
	// `input` slot alongside the `trigger` declaration name.
	readonly input?: Readonly<Record<string, unknown>>;
	// Back-compat alias for `input` retained so existing call sites that
	// still use `details` keep working without churn.
	readonly details?: Readonly<Record<string, unknown>>;
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

function assertHostFailKind(kind: EventKind): asserts kind is HostFailKind {
	if (kind !== "trigger.exception" && kind !== "trigger.rejection") {
		throw new Error(
			`emitHostFail: kind must be "trigger.exception" or "trigger.rejection" (got ${JSON.stringify(kind)}); R-8 host-side carve-out covers these kinds only`,
		);
	}
}

// biome-ignore lint/complexity/useMaxParams: identity bag is the same shape executor.invoke takes — flattening avoids an allocation per failure
async function emitTriggerException(
	eventStore: EventStore,
	owner: string,
	repo: string,
	workflow: WorkflowManifest,
	descriptor: TriggerDescriptor,
	params: TriggerExceptionParams,
): Promise<void> {
	const kind: EventKind = params.kind ?? "trigger.exception";
	assertHostFailKind(kind);
	const payload = params.input ?? params.details ?? {};
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
			...payload,
		},
		...(params.error
			? {
					error: {
						message: params.error.message,
					} satisfies InvocationEventError,
				}
			: {}),
	};
	await eventStore.record(event);
}

export type { HostFailKind, TriggerExceptionParams };
export { emitTriggerException };
