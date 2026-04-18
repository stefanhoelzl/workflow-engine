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

export type { ActionDescriptor, HttpTriggerDescriptor, TriggerDescriptor };
