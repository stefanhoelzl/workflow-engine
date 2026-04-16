import type { HttpTriggerResult, InvocationEvent } from "@workflow-engine/core";

// ---------------------------------------------------------------------------
// Action + trigger descriptors (shared by executor + workflow-registry)
// ---------------------------------------------------------------------------

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
	readonly body: { parse(data: unknown): unknown };
	readonly query?: { parse(data: unknown): unknown };
}

type TriggerDescriptor = HttpTriggerDescriptor;

// WorkflowRunner: invokes a trigger handler with an invocation id, and
// allows the executor to subscribe to events emitted from the sandbox.
interface WorkflowRunner {
	readonly name: string;
	readonly env: Readonly<Record<string, string>>;
	readonly actions: readonly ActionDescriptor[];
	readonly triggers: readonly TriggerDescriptor[];
	invokeHandler(
		invocationId: string,
		triggerName: string,
		payload: unknown,
	): Promise<HttpTriggerResult>;
	onEvent(cb: (event: InvocationEvent) => void): void;
}

export type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	TriggerDescriptor,
	WorkflowRunner,
};
