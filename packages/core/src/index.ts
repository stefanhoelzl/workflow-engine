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

interface HttpTriggerPayload<Body = unknown> {
	body: Body;
	headers: Record<string, string>;
	url: string;
	method: string;
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

/**
 * Dispatch provenance stamped onto `trigger.request` events by the runtime.
 * `source` is always populated; `user` is populated only for manual fires
 * that carried an authenticated session.
 */
interface DispatchMeta {
	readonly source: "trigger" | "manual";
	readonly user?: { readonly name: string; readonly mail: string };
}

// The subset of event fields the sandbox owns. Sandbox code (worker + main-
// thread factory) emits `SandboxEvent` — it has no knowledge of tenant or
// invocation identity. The runtime widens each `SandboxEvent` to a full
// `InvocationEvent` by stamping runtime metadata (`id`, `tenant`, `workflow`,
// `workflowSha`) at the `sb.onEvent` boundary in the executor, before
// forwarding to the bus. See SECURITY.md §2 R-8.
interface SandboxEvent {
	readonly kind: EventKind;
	readonly seq: number;
	readonly ref: number | null;
	readonly at: string;
	readonly ts: number;
	readonly name: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly error?: InvocationEventError;
}

interface InvocationEvent extends SandboxEvent {
	readonly id: string;
	readonly tenant: string;
	readonly workflow: string;
	readonly workflowSha: string;
	// Runtime-only metadata stamped by the executor's onEvent widener.
	// Populated on `trigger.request` with `{ dispatch }`; absent on every
	// other event kind. Sandbox and plugin code MUST NOT emit or read `meta`.
	readonly meta?: { readonly dispatch?: DispatchMeta };
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

const TRIGGER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const httpTriggerManifestSchema = z.object({
	name: z.string().regex(TRIGGER_NAME_RE),
	type: z.literal("http"),
	method: z.string(),
	body: jsonSchemaValidator,
	inputSchema: jsonSchemaValidator,
	outputSchema: jsonSchemaValidator,
});

// Standard 5-field cron grammar: each field is one or more of the allowed
// chars (digit, `*`, `,`, `-`, `/`). Non-standard extensions (L, W, #, ?,
// named months/days, 6-field) are rejected here.
const STANDARD_CRON_RE = /^[0-9*,\-/]+(\s+[0-9*,\-/]+){4}$/;

// `Intl.supportedValuesOf('timeZone')` returns only the "preferred" IANA zones
// and omits aliases like `UTC`, `Etc/UTC`, `GMT`. The authoritative validator
// is `new Intl.DateTimeFormat({timeZone: v})`, which accepts anything the ICU
// database knows (preferred + aliases) and throws on unknown zones.
const tzValidationCache = new Map<string, boolean>();
function isValidTimezone(tz: string): boolean {
	if (tz === "") {
		return false;
	}
	const cached = tzValidationCache.get(tz);
	if (cached !== undefined) {
		return cached;
	}
	let ok: boolean;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		ok = true;
	} catch {
		ok = false;
	}
	tzValidationCache.set(tz, ok);
	return ok;
}

const cronTriggerManifestSchema = z.object({
	name: z.string(),
	type: z.literal("cron"),
	schedule: z.string().regex(STANDARD_CRON_RE, {
		error: "must be a standard 5-field cron expression",
	}),
	tz: z.string().refine(isValidTimezone, {
		error: "must be a supported IANA timezone",
	}),
	inputSchema: jsonSchemaValidator,
	outputSchema: jsonSchemaValidator,
});

const manualTriggerManifestSchema = z.object({
	name: z.string().regex(TRIGGER_NAME_RE),
	type: z.literal("manual"),
	inputSchema: jsonSchemaValidator,
	outputSchema: jsonSchemaValidator,
});

const triggerManifestSchema = z.discriminatedUnion("type", [
	httpTriggerManifestSchema,
	cronTriggerManifestSchema,
	manualTriggerManifestSchema,
]);

type HttpTriggerManifest = z.infer<typeof httpTriggerManifestSchema>;
type CronTriggerManifest = z.infer<typeof cronTriggerManifestSchema>;
type ManualTriggerManifest = z.infer<typeof manualTriggerManifestSchema>;
type TriggerManifest = z.infer<typeof triggerManifestSchema>;

const workflowManifestSchema = z.object({
	name: z.string(),
	module: z.string(),
	sha: z.string(),
	env: z.record(z.string(), z.string()),
	actions: z.array(actionManifestSchema),
	triggers: z.array(triggerManifestSchema),
});

const ManifestSchema = z
	.object({
		workflows: z.array(workflowManifestSchema),
	})
	.refine(
		(m) => {
			const seen = new Set<string>();
			for (const w of m.workflows) {
				if (seen.has(w.name)) {
					return false;
				}
				seen.add(w.name);
			}
			return true;
		},
		{ error: "workflow names must be unique within a tenant" },
	);

type Manifest = z.infer<typeof ManifestSchema>;
type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

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
	CronTriggerManifest,
	DispatchMeta,
	EventKind,
	HttpTriggerManifest,
	HttpTriggerPayload,
	HttpTriggerResult,
	InvocationEvent,
	InvocationEventError,
	Manifest,
	ManualTriggerManifest,
	SandboxEvent,
	TriggerManifest,
	WorkflowManifest,
};

export { dispatchAction, IIFE_NAMESPACE, ManifestSchema, z };
