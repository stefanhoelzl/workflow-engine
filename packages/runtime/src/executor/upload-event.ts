import type {
	DispatchMeta,
	EventKind,
	InvocationEvent,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { EventBus } from "../event-bus/index.js";

// ---------------------------------------------------------------------------
// system.upload emission primitive (executor-internal)
// ---------------------------------------------------------------------------
//
// Sibling to `emitTriggerException` — emits a single `system.upload` leaf
// event onto the bus, fully stamped, bypassing the sandbox / RunSequencer
// entirely (uploads do not go through the sandbox). Stamps
// `meta.dispatch = { source: "upload", user }` per SECURITY.md §2 R-9 carve-
// out.
//
// This module is the single chokepoint where the SECURITY.md §2 R-8 host-side
// stamping carve-out for `system.upload` is enforced — `assertSystemUploadKind`
// prevents a future contributor from extending the bypass to other event
// kinds.

interface SystemUploadParams {
	readonly owner: string;
	readonly repo: string;
	readonly workflow: WorkflowManifest;
	// Per-workflow manifest sub-snapshot to stamp into the event's `input`.
	readonly snapshot: Readonly<Record<string, unknown>>;
	// Authenticated uploader (always present — uploads are never anonymous).
	readonly user: { readonly login: string; readonly mail: string };
}

function newInvocationId(): string {
	return `evt_${crypto.randomUUID()}`;
}

function assertSystemUploadKind(
	kind: EventKind,
): asserts kind is "system.upload" {
	if (kind !== "system.upload") {
		throw new Error(
			`emitSystemUpload: kind must be "system.upload" (got ${JSON.stringify(kind)}); R-8 host-side carve-out covers this kind only`,
		);
	}
}

async function emitSystemUpload(
	bus: EventBus,
	params: SystemUploadParams,
): Promise<void> {
	const kind: EventKind = "system.upload";
	assertSystemUploadKind(kind);
	const dispatch: DispatchMeta = {
		source: "upload",
		user: { login: params.user.login, mail: params.user.mail },
	};
	const event: InvocationEvent = {
		id: newInvocationId(),
		owner: params.owner,
		repo: params.repo,
		workflow: params.workflow.name,
		workflowSha: params.workflow.sha,
		kind,
		name: params.workflow.name,
		seq: 0,
		ref: 0,
		ts: 0,
		at: new Date().toISOString(),
		input: params.snapshot,
		meta: { dispatch },
	};
	await bus.emit(event);
}

export type { SystemUploadParams };
export { emitSystemUpload };
