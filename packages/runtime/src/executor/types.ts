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
	// Workflow identity. The manifest nests triggers under workflows, so
	// `(workflowName, name)` uniqueness is enforced at build time. Backends
	// key their per-tenant bookkeeping by `(tenant, workflowName, name)` to
	// avoid collisions when two workflows in the same tenant expose same-
	// named triggers. The registry fills this in during descriptor build.
	readonly workflowName: string;
	// JSON Schema (from manifest) describing the full input the shared
	// `validate(descriptor, rawInput)` helper parses against.
	readonly inputSchema: Record<string, unknown>;
	// JSON Schema (from manifest) describing the handler's return shape.
	readonly outputSchema: Record<string, unknown>;
}

interface HttpTriggerDescriptor extends BaseTriggerDescriptor<"http"> {
	readonly type: "http";
	readonly method: string;
	// JSON Schema for the body only — the UI uses this to render a body-form
	// on the HTTP trigger card (the HTTP request itself fills in the other
	// composite fields: headers/url/method).
	readonly body: Record<string, unknown>;
}

interface CronTriggerDescriptor extends BaseTriggerDescriptor<"cron"> {
	readonly type: "cron";
	readonly schedule: string;
	readonly tz: string;
}

interface ManualTriggerDescriptor extends BaseTriggerDescriptor<"manual"> {
	readonly type: "manual";
}

type TriggerDescriptor =
	| HttpTriggerDescriptor
	| CronTriggerDescriptor
	| ManualTriggerDescriptor;

interface ValidationIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

// Envelope for executor.invoke / entry.fire return value — kind-agnostic.
// Sources decide the protocol-level response from this envelope.
//
// `error.issues` is populated when the failure came from input-schema
// validation inside the registry-built `fire` closure; backends that
// speak JSON (HTTP) surface these as 422 validation responses.
type InvokeResult<T = unknown> =
	| { readonly ok: true; readonly output: T }
	| {
			readonly ok: false;
			readonly error: {
				readonly message: string;
				readonly stack?: string;
				readonly issues?: readonly ValidationIssue[];
			};
	  };

export type {
	ActionDescriptor,
	BaseTriggerDescriptor,
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
	ManualTriggerDescriptor,
	TriggerDescriptor,
	ValidationIssue,
};
