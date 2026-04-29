// ---------------------------------------------------------------------------
// Action + trigger descriptors (shared by executor + workflow-registry)
// ---------------------------------------------------------------------------

import type { z } from "@workflow-engine/core";

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
	// key their per-owner bookkeeping by `(owner, workflowName, name)` to
	// avoid collisions when two workflows in the same owner expose same-
	// named triggers. The registry fills this in during descriptor build.
	readonly workflowName: string;
	// JSON Schema (from manifest) describing the full input the shared
	// `validate(descriptor, rawInput)` helper parses against.
	readonly inputSchema: Record<string, unknown>;
	// JSON Schema (from manifest) describing the handler's return shape.
	readonly outputSchema: Record<string, unknown>;
	// Zod schema rehydrated from `inputSchema` once at WorkflowRegistry
	// registration time. Reused for every fire() invocation; per-request
	// rehydration is forbidden. See payload-validation/spec.md.
	readonly zodInputSchema: z.ZodType<unknown>;
	// Zod schema rehydrated from `outputSchema` once at registration time.
	readonly zodOutputSchema: z.ZodType<unknown>;
}

interface HttpTriggerDescriptor extends BaseTriggerDescriptor<"http"> {
	readonly type: "http";
	readonly method: string;
	// JSON Schemas for the request body and headers — the UI uses these to
	// render body and header form inputs on the HTTP trigger card (the HTTP
	// request itself fills in url and method).
	readonly request: {
		readonly body: Record<string, unknown>;
		readonly headers: Record<string, unknown>;
	};
	readonly response?: {
		readonly body?: Record<string, unknown>;
		readonly headers?: Record<string, unknown>;
	};
}

interface CronTriggerDescriptor extends BaseTriggerDescriptor<"cron"> {
	readonly type: "cron";
	readonly schedule: string;
	readonly tz: string;
}

interface ManualTriggerDescriptor extends BaseTriggerDescriptor<"manual"> {
	readonly type: "manual";
}

interface ImapTriggerDescriptor extends BaseTriggerDescriptor<"imap"> {
	readonly type: "imap";
	readonly host: string;
	readonly port: number;
	readonly tls: "required" | "starttls" | "none";
	readonly insecureSkipVerify: boolean;
	readonly user: string;
	readonly password: string;
	readonly folder: string;
	readonly search: string;
	readonly mode: "poll" | "idle";
	readonly onError: { readonly command?: readonly string[] };
}

interface WsTriggerDescriptor extends BaseTriggerDescriptor<"ws"> {
	readonly type: "ws";
	// JSON Schema for the inbound message data; the UI uses this to render the
	// request form on the WS trigger card.
	readonly request: Record<string, unknown>;
	// JSON Schema for the handler reply; defaults to JSON Schema for `z.any()`
	// (i.e. `{}`) when the author omits `response`.
	readonly response: Record<string, unknown>;
}

type TriggerDescriptor =
	| HttpTriggerDescriptor
	| CronTriggerDescriptor
	| ManualTriggerDescriptor
	| ImapTriggerDescriptor
	| WsTriggerDescriptor;

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
	ImapTriggerDescriptor,
	InvokeResult,
	ManualTriggerDescriptor,
	TriggerDescriptor,
	ValidationIssue,
	WsTriggerDescriptor,
};
