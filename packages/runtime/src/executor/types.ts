// ---------------------------------------------------------------------------
// Action + trigger descriptors (shared by executor + workflow-registry)
// ---------------------------------------------------------------------------

interface ActionDescriptor {
	readonly name: string;
	readonly input: { parse(data: unknown): unknown };
	readonly output: { parse(data: unknown): unknown };
}

interface BaseTriggerDescriptor<K extends string> {
	readonly kind: K;
	readonly name: string;
	// JSON Schema (from manifest) describing the full input the shared
	// `validate(descriptor, rawInput)` helper parses against.
	readonly inputSchema: Record<string, unknown>;
	// JSON Schema (from manifest) describing the handler's return shape.
	readonly outputSchema: Record<string, unknown>;
}

interface HttpTriggerDescriptor extends BaseTriggerDescriptor<"http"> {
	readonly type: "http";
	readonly path: string;
	readonly method: string;
	readonly params: readonly string[];
	// JSON Schema for the body only — the UI uses this to render a body-form
	// on the HTTP trigger card (the HTTP request itself fills in the other
	// composite fields: headers/url/method/params/query).
	readonly body: Record<string, unknown>;
	readonly query?: Record<string, unknown>;
}

type TriggerDescriptor = HttpTriggerDescriptor;

// Envelope for executor.invoke return value — kind-agnostic. Sources decide
// the protocol-level response from this envelope.
type InvokeResult<T = unknown> =
	| { readonly ok: true; readonly output: T }
	| {
			readonly ok: false;
			readonly error: { readonly message: string; readonly stack?: string };
	  };

export type {
	ActionDescriptor,
	BaseTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
	TriggerDescriptor,
};
