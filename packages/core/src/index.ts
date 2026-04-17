import Ajv2020 from "ajv/dist/2020.js";
// biome-ignore lint/style/noExportedImports: z is re-exported for consumers alongside locally defined exports
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP trigger result
// ---------------------------------------------------------------------------

interface HttpTriggerResult {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

interface HttpTriggerPayload<
	Body = unknown,
	Params extends Record<string, string> = Record<string, string>,
	Query extends Record<string, unknown> = Record<string, never>,
> {
	body: Body;
	headers: Record<string, string>;
	url: string;
	method: string;
	params: Params;
	query: Query;
}

// ---------------------------------------------------------------------------
// Invocation events
// ---------------------------------------------------------------------------

/**
 * `system.call` is a single-record kind: the event carries both `input` and
 * `output` and has no paired counterpart. Used for instant synchronous
 * sub-bridge host reads (WASI clock/random). Every other kind follows the
 * paired `*.request` / `*.response` / `*.error` contract.
 */
type EventKind =
	| "trigger.request"
	| "trigger.response"
	| "trigger.error"
	| "action.request"
	| "action.response"
	| "action.error"
	| "system.request"
	| "system.response"
	| "system.error"
	| "system.call"
	| "timer.set"
	| "timer.request"
	| "timer.response"
	| "timer.error"
	| "timer.clear";

interface InvocationEventError {
	message: string;
	stack: string;
	issues?: unknown;
}

interface InvocationEvent {
	readonly kind: EventKind;
	readonly id: string;
	readonly seq: number;
	readonly ref: number | null;
	readonly at: string;
	readonly ts: number;
	readonly workflow: string;
	readonly workflowSha: string;
	readonly name: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: InvocationEventError;
}

// ---------------------------------------------------------------------------
// Action dispatch contract
// ---------------------------------------------------------------------------

type ActionDispatcher = (
	name: string,
	input: unknown,
	handler: (input: unknown) => Promise<unknown>,
	outputSchema: { parse(data: unknown): unknown },
) => Promise<unknown>;

function dispatchAction(
	name: string,
	input: unknown,
	handler: (input: unknown) => Promise<unknown>,
	outputSchema: { parse(data: unknown): unknown },
): Promise<unknown> {
	const fn = (globalThis as Record<string, unknown>).__dispatchAction;
	if (typeof fn !== "function") {
		throw new Error(
			"No action dispatcher installed; actions can only run inside the workflow sandbox",
		);
	}
	return (fn as ActionDispatcher)(name, input, handler, outputSchema);
}

// ---------------------------------------------------------------------------
// Manifest schema (v1)
// ---------------------------------------------------------------------------

const ajv = new Ajv2020.default();
// biome-ignore lint/style/noNonNullAssertion: meta-schema is always available in Ajv2020
const validateJsonSchema = ajv.getSchema(
	"https://json-schema.org/draft/2020-12/schema",
)!;

const jsonSchemaValidator = z.custom<Record<string, unknown>>((val) =>
	validateJsonSchema(val),
);

const actionManifestSchema = z.object({
	name: z.string(),
	input: jsonSchemaValidator,
	output: jsonSchemaValidator,
});

const httpTriggerManifestSchema = z.object({
	name: z.string(),
	type: z.literal("http"),
	path: z.string(),
	method: z.string(),
	body: jsonSchemaValidator,
	params: z.array(z.string()),
	query: z.exactOptional(jsonSchemaValidator),
	schema: jsonSchemaValidator,
});

const triggerManifestSchema = z.discriminatedUnion("type", [
	httpTriggerManifestSchema,
]);

const ManifestSchema = z.object({
	name: z.string(),
	module: z.string(),
	sha: z.string(),
	env: z.record(z.string(), z.string()),
	actions: z.array(actionManifestSchema),
	triggers: z.array(triggerManifestSchema),
});

type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// IIFE namespace
// ---------------------------------------------------------------------------
//
// Each sandbox worker evaluates exactly one workflow in an isolated VM, so
// the namespace need not be per-workflow. Plugin, runtime, and sandbox all
// import this single constant to agree on the global that Rollup's IIFE
// output assigns exports to.

const IIFE_NAMESPACE = "__wfe_exports__";

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	ActionDispatcher,
	EventKind,
	HttpTriggerPayload,
	HttpTriggerResult,
	InvocationEvent,
	InvocationEventError,
	Manifest,
};
export { dispatchAction, IIFE_NAMESPACE, ManifestSchema, z };
