// biome-ignore lint/style/noExportedImports: z is re-exported for consumers alongside locally defined exports
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP trigger result
// ---------------------------------------------------------------------------

interface HttpTriggerResult<
	Headers extends Record<string, string> = Record<string, string>,
> {
	status?: number;
	body?: unknown;
	headers?: Headers;
}

interface HttpTriggerPayload<
	Body = unknown,
	Headers extends Record<string, unknown> = Record<string, never>,
> {
	body: Body;
	headers: Headers;
	url: string;
	method: string;
}

// ---------------------------------------------------------------------------
// Invocation events
// ---------------------------------------------------------------------------

/**
 * Reserved event prefixes are `trigger.*`, `action.*`, and `system.*`. The
 * paired triplet (`*.request` / `*.response` / `*.error`) covers operations
 * with a request/response lifecycle. `system.call` is a leaf for fire-and-
 * forget host calls (e.g. `console.log`, `setTimeout` registration, WASI
 * clock/random reads). `system.exception` is a leaf for uncaught guest
 * exceptions bubbled via the `reportError` polyfill (replaces the previous
 * top-level `uncaught-error` kind).
 *
 * `trigger.exception` is a leaf for *author-fixable* trigger setup failures
 * that happen host-side before any handler runs (e.g. IMAP host wrong,
 * SEARCH expression rejected, server refuses connection). Unlike
 * `trigger.error`, it has no paired `trigger.request` and does not close any
 * frame — it mirrors `system.exception`'s leaf semantics but lives in the
 * `trigger.*` family because it carries trigger-scoped context (workflow,
 * trigger name, owner-stamped invocationId). Emitted ONLY by the runtime
 * helper `emitTriggerException`, never by sandbox or plugin code.
 *
 * Plugin authors disambiguate which underlying operation produced an event
 * via the event's `name` field — e.g. `system.request name="fetch"` versus
 * `system.request name="sendMail"` versus `system.call name="setTimeout"`.
 *
 * The bridge-main-sequencing change consolidated the previous distinct
 * `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*`, and
 * `uncaught-error` kinds into the `system.*` family.
 */
type EventKind =
	| "trigger.request"
	| "trigger.response"
	| "trigger.error"
	| "trigger.exception"
	// Host-side leaf for HTTP webhook body-validation failures. Single-leaf,
	// no paired trigger.request, no meta.dispatch. See
	// `openspec/specs/invocations/spec.md` under "Requirement:
	// trigger.rejection is a leaf event kind for HTTP body validation
	// failures".
	| "trigger.rejection"
	| "action.request"
	| "action.response"
	| "action.error"
	| "system.request"
	| "system.response"
	| "system.error"
	| "system.call"
	| "system.exception"
	// Sandbox-synthesised marker emitted once per invocation that terminated
	// via a sandbox resource-limit breach. Rides the existing reserved
	// `system.*` prefix per SECURITY.md §2 R-7. Payload shape in
	// `openspec/specs/invocations/spec.md` under "Requirement:
	// system.exhaustion event kind".
	| "system.exhaustion"
	// Host-side leaf emitted per-workflow on successful upload, sha-deduped.
	// Single-leaf, carries `meta.dispatch = { source: "upload", user }`. See
	// `openspec/specs/invocations/spec.md` under "Requirement:
	// system.upload event kind for workflow uploads".
	| "system.upload";

interface InvocationEventError {
	message: string;
	// Optional: real Errors usually carry a stack, but synthetic terminals
	// (worker-death close synthesis in `RunSequencer.finish`, recovery's
	// `engine_crashed` synthetic terminal) have no JS stack to capture.
	// Omitting beats emitting a meaningless `""`.
	stack?: string;
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
 * Dispatch provenance stamped onto `trigger.request` and `system.upload`
 * events by the runtime. `source` is always populated; `user` is populated
 * for manual fires that carried an authenticated session, and is always
 * present on `system.upload` (uploads are always authenticated).
 */
interface DispatchMeta {
	readonly source: "trigger" | "manual" | "upload";
	readonly user?: { readonly login: string; readonly mail: string };
}

// The subset of event fields the sandbox owns. Sandbox code (worker + main-
// thread factory) emits `SandboxEvent` — it has no knowledge of owner/repo or
// invocation identity. The runtime widens each `SandboxEvent` to a full
// `InvocationEvent` by stamping runtime metadata (`id`, `owner`, `repo`,
// `workflow`, `workflowSha`) at the `sb.onEvent` boundary in the executor,
// before forwarding to the bus. See SECURITY.md §2 R-8.
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
	readonly repo: string;
	readonly workflow: string;
	readonly workflowSha: string;
	// Runtime-only metadata stamped by the runtime. Populated on
	// `trigger.request` (by the executor's `sb.onEvent` widener) and on
	// `system.upload` (by the upload handler's host-side emission path) with
	// `{ dispatch }`; absent on every other event kind. Sandbox and plugin
	// code MUST NOT emit or read `meta`.
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

// JSON-Schema-shape gate at upload time. We trust `z.fromJSONSchema` to
// throw on values that aren't structurally valid JSON Schema; if it
// rehydrates without throwing, we treat the value as a valid JSON Schema
// for the purposes of `ManifestSchema`. Engine-name detail lives here, not
// in the spec text — see `unify-schema-validation-on-zod`.
const jsonSchemaValidator = z.custom<Record<string, unknown>>((val) => {
	if (typeof val !== "object" || val === null) {
		return false;
	}
	try {
		z.fromJSONSchema(val as Record<string, unknown>);
		return true;
	} catch {
		return false;
	}
});

const actionManifestSchema = z.object({
	name: z.string(),
	input: jsonSchemaValidator,
	output: jsonSchemaValidator,
});

const OWNER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const REPO_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const TRIGGER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const httpTriggerManifestSchema = z.object({
	name: z.string().regex(TRIGGER_NAME_RE),
	type: z.literal("http"),
	method: z.string(),
	request: z.object({
		body: jsonSchemaValidator,
		headers: jsonSchemaValidator,
	}),
	response: z
		.object({
			body: jsonSchemaValidator.optional(),
			headers: jsonSchemaValidator.optional(),
		})
		.optional(),
	inputSchema: jsonSchemaValidator,
	outputSchema: jsonSchemaValidator,
});

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

// A string that either matches its inner validator directly OR contains at
// least one `\x00secret:NAME\x00` sentinel substring. Sentinel-bearing
// values are accepted at schema time because the workflow registry
// resolves them to plaintext before handing the descriptor to the trigger
// source, which performs its own format validation on the resolved value
// (e.g. the cron source re-parses the schedule via
// `CronExpressionParser.parse`).
//
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL bytes are the intentional sentinel terminators (see `encodeSentinel` below); the regex matches them by design
const CONTAINS_SENTINEL_RE = /\x00secret:[A-Za-z_][A-Za-z0-9_]*\x00/;
function containsSentinel(value: string): boolean {
	return CONTAINS_SENTINEL_RE.test(value);
}

const cronTriggerManifestSchema = z.object({
	name: z.string(),
	type: z.literal("cron"),
	schedule: z
		.string()
		.refine((v) => containsSentinel(v) || v.trim().length > 0, {
			error:
				"must be a non-empty cron expression, or a workflow-secret reference",
		}),
	tz: z.string().refine((v) => containsSentinel(v) || isValidTimezone(v), {
		error: "must be a supported IANA timezone, or a workflow-secret reference",
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

// Disposition envelope returned from an imap handler (and declared on
// imapTrigger.onError). Each string in `command` is a raw IMAP command
// suffix that the runtime passes verbatim to imapflow's connection.exec()
// against the current IMAP session after the handler completes. Authors
// write the full UID-scoped command (e.g. `UID STORE 42 +FLAGS (\Seen)`);
// the runtime does not bind UIDs for them.
const imapTriggerResultSchema = z.object({
	command: z.array(z.string()).optional(),
});

const imapAddressSchema = z.object({
	name: z.string().optional(),
	address: z.string(),
});

// Parsed message payload delivered to the imap handler. Attachments are
// base64-inline because the main/sandbox bridge is JSON-only — File/Blob
// objects do not survive the crossing.
const imapMessageSchema = z.object({
	uid: z.number(),
	messageId: z.string().optional(),
	inReplyTo: z.string().optional(),
	references: z.array(z.string()),
	from: imapAddressSchema,
	to: z.array(imapAddressSchema),
	cc: z.array(imapAddressSchema),
	bcc: z.array(imapAddressSchema),
	replyTo: z.array(imapAddressSchema).optional(),
	subject: z.string(),
	date: z.string(),
	text: z.string().optional(),
	html: z.string().optional(),
	headers: z.record(z.string(), z.array(z.string())),
	attachments: z.array(
		z.object({
			filename: z.string().optional(),
			contentType: z.string(),
			size: z.number(),
			contentId: z.string().optional(),
			contentDisposition: z.enum(["inline", "attachment"]).optional(),
			content: z.string(),
		}),
	),
});

const imapTriggerManifestSchema = z.object({
	name: z.string().regex(TRIGGER_NAME_RE),
	type: z.literal("imap"),
	host: z.string(),
	port: z.number(),
	tls: z.enum(["required", "starttls", "none"]),
	insecureSkipVerify: z.boolean(),
	user: z.string(),
	password: z.string(),
	folder: z.string(),
	search: z.string(),
	onError: imapTriggerResultSchema,
	inputSchema: jsonSchemaValidator,
	outputSchema: jsonSchemaValidator,
});

const triggerManifestSchema = z.discriminatedUnion("type", [
	httpTriggerManifestSchema,
	cronTriggerManifestSchema,
	manualTriggerManifestSchema,
	imapTriggerManifestSchema,
]);

type HttpTriggerManifest = z.infer<typeof httpTriggerManifestSchema>;
type CronTriggerManifest = z.infer<typeof cronTriggerManifestSchema>;
type ManualTriggerManifest = z.infer<typeof manualTriggerManifestSchema>;
type ImapTriggerManifest = z.infer<typeof imapTriggerManifestSchema>;
type ImapMessage = z.infer<typeof imapMessageSchema>;
type ImapTriggerResult = z.infer<typeof imapTriggerResultSchema>;
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
		{ error: "workflow names must be unique within a repo" },
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
// Secret sentinels (trigger-config secrets)
// ---------------------------------------------------------------------------
//
// `\x00secret:NAME\x00` sentinel strings reference a workflow-declared secret
// by name inside trigger descriptor string fields. The SDK's build-time env
// resolver emits them (via `encodeSentinel`); the runtime's workflow registry
// substitutes them for decrypted plaintext (via `SENTINEL_SUBSTRING_RE`)
// before handing descriptors to `TriggerSource.reconfigure`. No other code
// path produces or consumes this format — scrubbing of plaintext literals on
// outbound worker messages is a separate mechanism keyed on plaintext bytes,
// not sentinels.
//
// Inlined here (rather than a sibling module) because the `?sandbox-plugin`
// esbuild transform resolves `@workflow-engine/core` directly to `index.ts`
// and does not reliably pick up sibling `.ts` files — same reason the
// guest-globals contract above lives here.

const SECRET_SENTINEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL bytes are the intentional sentinel terminators — the whole point of this regex is to match them
const SENTINEL_SUBSTRING_RE = /\x00secret:([A-Za-z_][A-Za-z0-9_]*)\x00/g;

function encodeSentinel(name: string): string {
	if (!SECRET_SENTINEL_NAME_RE.test(name)) {
		throw new Error(
			`invalid secret name (must match ${SECRET_SENTINEL_NAME_RE.source}): ${JSON.stringify(name)}`,
		);
	}
	return `\x00secret:${name}\x00`;
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
	ImapMessage,
	ImapTriggerManifest,
	ImapTriggerResult,
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
	encodeSentinel,
	IIFE_NAMESPACE,
	installGuestGlobals,
	ManifestSchema,
	OWNER_NAME_RE,
	REPO_NAME_RE,
	SECRETS_KEY_ID_BYTES,
	SENTINEL_SUBSTRING_RE,
	TRIGGER_NAME_RE,
	z,
};
