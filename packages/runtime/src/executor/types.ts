import type { HttpTriggerResult } from "@workflow-engine/core";

// ---------------------------------------------------------------------------
// Action + trigger descriptors (shared by executor + workflow-registry)
// ---------------------------------------------------------------------------
//
// The executor only needs enough of each workflow to route a trigger call to
// its handler. Richer per-workflow state (sandbox instance, manifest, env)
// lives inside the runner implementation and is opaque to the executor.

interface ActionDescriptor {
	readonly name: string;
	readonly input: { parse(data: unknown): unknown };
	readonly output: { parse(data: unknown): unknown };
}

interface HttpTriggerDescriptor {
	readonly name: string;
	readonly type: "http";
	readonly path: string;
	readonly method: string;
	readonly params: readonly string[];
	// Schemas kept as `unknown` containers so the workflow-registry can wire
	// them from the manifest's JSON-Schema representation without forcing a
	// Zod dependency here.
	readonly body: { parse(data: unknown): unknown };
	readonly query?: { parse(data: unknown): unknown };
}

type TriggerDescriptor = HttpTriggerDescriptor;

// The executor treats WorkflowRunner as a black box that can:
//   - be identified (name, env — exposed for observability and middleware
//     convenience)
//   - invoke a trigger handler given a name + payload
//
// Everything else (sandbox lifecycle, __hostCallAction wiring, manifest
// validation) is internal to the runner implementation owned by the
// workflow-registry in Phase 4.
interface WorkflowRunner {
	readonly name: string;
	readonly env: Readonly<Record<string, string>>;
	readonly actions: readonly ActionDescriptor[];
	readonly triggers: readonly TriggerDescriptor[];
	invokeHandler(
		triggerName: string,
		payload: unknown,
	): Promise<HttpTriggerResult>;
}

export type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	TriggerDescriptor,
	WorkflowRunner,
};
