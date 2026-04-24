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
	| "timer.clear"
	| "mail.request"
	| "mail.response"
	| "mail.error";

interface InvocationEventError {
	message: string;
	stack: string;
	issues?: unknown;
	/**
	 * Recovery stamps `kind: "engine_crashed"` onto the synthetic `trigger.error`
	 * it emits for invocations whose pending events were found on disk at
	 * startup but never reached a terminal. See `recovery/spec.md` for the
	 * full shape and semantics.
	 */
	kind?: "engine_crashed";
}

/**
 * Dispatch provenance stamped onto `trigger.request` events by the runtime.
 * `source` is always populated; `user` is populated only for manual fires
 * that carried an authenticated session.
 */
interface DispatchMeta {
	readonly source: "trigger" | "manual";
	readonly user?: { readonly login: string; readonly mail: string };
}

// The subset of event fields the sandbox owns. Sandbox code (worker + main-
// thread factory) emits `SandboxEvent` — it has no knowledge of owner or
// invocation identity. The runtime widens each `SandboxEvent` to a full
// `InvocationEvent` by stamping runtime metadata (`id`, `owner`, `workflow`,
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
	readonly owner: string;
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

const SECRETS_KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

const workflowManifestSchema = z
	.object({
		name: z.string(),
		module: z.string(),
		sha: z.string(),
		env: z.record(z.string(), z.string()),
		// Sealed-box ciphertexts keyed by envName. Each value is a base64-
		// encoded `crypto_box_seal` output against the server public key
		// identified by `secretsKeyId`. When present, `secretsKeyId` is also
		// required (and vice versa).
		secrets: z.record(z.string(), z.string()).optional(),
		// 16-character lowercase hex fingerprint (first 8 bytes of
		// `sha256(publicKey)`) of the server public key that sealed the
		// `secrets` entries. See `computeKeyId`.
		secretsKeyId: z.string().regex(SECRETS_KEY_ID_PATTERN).optional(),
		// `secretBindings` is an intermediate build-artifact field the Vite
		// plugin emits and the CLI consumes (seals values + deletes the
		// field) before POSTing. A bundle arriving at the server with this
		// field present indicates a skipped or misconfigured CLI step; reject
		// explicitly with a clear message.
		secretBindings: z
			.never({
				error:
					"manifest contains `secretBindings` — this is an intermediate build-artifact field that MUST be consumed by `wfe upload` (sealed into `secrets`) before POSTing",
			})
			.optional(),
		actions: z.array(actionManifestSchema),
		triggers: z.array(triggerManifestSchema),
	})
	.refine((w) => (w.secrets === undefined) === (w.secretsKeyId === undefined), {
		error:
			"workflow `secrets` and `secretsKeyId` must both be present or both absent",
		path: ["secretsKeyId"],
	})
	.refine(
		(w) => {
			if (w.secrets === undefined) {
				return true;
			}
			for (const envName of Object.keys(w.secrets)) {
				if (envName in w.env) {
					return false;
				}
			}
			return true;
		},
		{
			error:
				"workflow `secrets` key names must be disjoint from `env` key names",
			path: ["secrets"],
		},
	);

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
		{ error: "workflow names must be unique within a owner" },
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

// ---------------------------------------------------------------------------
// Secrets key identifier (secrets-crypto-foundation)
// ---------------------------------------------------------------------------
//
// `keyId = sha256(publicKey).slice(0, 8)` as lowercase hex. 16 characters;
// 64 bits of fingerprint — collision risk is negligible at the scale of
// ~10 keys per environment. Shared helper so the runtime key-store, upload
// handler, public-key endpoint, and future CLI sealing path compute it
// identically.

const SECRETS_KEY_ID_BYTES = 8;

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

async function computeKeyId(publicKey: Uint8Array): Promise<string> {
	const digest = await (
		globalThis as unknown as { crypto: Crypto }
	).crypto.subtle.digest("SHA-256", publicKey as unknown as BufferSource);
	const bytes = new Uint8Array(digest).slice(0, SECRETS_KEY_ID_BYTES);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0");
	}
	return hex;
}

// ---------------------------------------------------------------------------
// Guest-globals contract (workflow-env-runtime-injection)
// ---------------------------------------------------------------------------
//
// Types installed onto the guest VM's `globalThis` by runtime plugins and
// read by SDK code (`defineWorkflow`, `secret()` factory). Inlined into
// index.ts rather than split into a separate module so the esbuild bundler
// used by the `?sandbox-plugin` transform can resolve the package without
// hitting a `.js` fallback on an `.ts`-only sibling.

interface RuntimeWorkflow<
	Env extends Readonly<Record<string, string>> = Readonly<
		Record<string, string>
	>,
> {
	readonly name: string;
	readonly env: Env;
}

interface RuntimeSecrets {
	addSecret(value: string): void;
}

interface GuestGlobals {
	workflow: RuntimeWorkflow;
	$secrets: RuntimeSecrets;
}

declare global {
	var workflow: GuestGlobals["workflow"];
	var $secrets: GuestGlobals["$secrets"];
}

function installGuestGlobals(globals: Partial<GuestGlobals>): void {
	for (const key of Object.keys(globals) as (keyof GuestGlobals)[]) {
		Object.defineProperty(globalThis, key, {
			value: globals[key],
			writable: false,
			configurable: false,
		});
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	ActionDispatcher,
	CronTriggerManifest,
	DispatchMeta,
	EventKind,
	GuestGlobals,
	HttpTriggerManifest,
	HttpTriggerPayload,
	HttpTriggerResult,
	InvocationEvent,
	InvocationEventError,
	Manifest,
	ManualTriggerManifest,
	RuntimeSecrets,
	RuntimeWorkflow,
	SandboxEvent,
	TriggerManifest,
	WorkflowManifest,
};

export {
	computeKeyId,
	dispatchAction,
	IIFE_NAMESPACE,
	installGuestGlobals,
	ManifestSchema,
	SECRETS_KEY_ID_BYTES,
	z,
};
