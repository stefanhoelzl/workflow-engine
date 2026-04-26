import type {
	HttpTriggerPayload,
	HttpTriggerResult,
	ImapMessage,
	ImapTriggerResult,
	RuntimeWorkflow,
} from "@workflow-engine/core";
// biome-ignore lint/style/noExportedImports: z and ManifestSchema are re-exported for workflow authors alongside locally defined exports
import { encodeSentinel, ManifestSchema, z } from "@workflow-engine/core";
import type { StandardCRON } from "ts-cron-validator";
// biome-ignore lint/style/noExportedImports: sendMail is re-exported from the unified @workflow-engine/sdk barrel so workflow authors get one entry point
import { sendMail } from "./mail.js";
// biome-ignore lint/style/noExportedImports: executeSql is re-exported from the unified @workflow-engine/sdk barrel so workflow authors get one entry point
import { executeSql } from "./sql.js";

// ---------------------------------------------------------------------------
// Action dispatch (routed through the sdk-support plugin's locked __sdk)
// ---------------------------------------------------------------------------

type SdkDispatcher = (
	name: string,
	input: unknown,
	handler: (input: unknown) => Promise<unknown>,
) => Promise<unknown>;

function dispatchViaSdk(
	name: string,
	input: unknown,
	handler: (input: unknown) => Promise<unknown>,
): Promise<unknown> {
	const sdk = (globalThis as Record<string, unknown>).__sdk as
		| { dispatchAction?: SdkDispatcher }
		| undefined;
	if (!sdk || typeof sdk.dispatchAction !== "function") {
		throw new Error(
			"No action dispatcher installed; actions can only run inside the workflow sandbox",
		);
	}
	return sdk.dispatchAction(name, input, handler);
}

// ---------------------------------------------------------------------------
// Brand symbols
// ---------------------------------------------------------------------------

const ACTION_BRAND: unique symbol = Symbol.for("@workflow-engine/action");
const HTTP_TRIGGER_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/http-trigger",
);
const CRON_TRIGGER_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/cron-trigger",
);
const MANUAL_TRIGGER_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/manual-trigger",
);
const IMAP_TRIGGER_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/imap-trigger",
);
const WORKFLOW_BRAND: unique symbol = Symbol.for("@workflow-engine/workflow");
const ENV_REF_BRAND: unique symbol = Symbol.for("@workflow-engine/env-ref");
// Carries the list of envNames declared with `env({secret: true})` on the
// returned Workflow at build-time discovery. Vite plugin reads this via
// the same symbol key (cross-context-safe because Symbol.for).
const WORKFLOW_SECRET_BINDINGS_KEY: unique symbol = Symbol.for(
	"@workflow-engine/workflow-secret-bindings",
);

// ---------------------------------------------------------------------------
// EnvRef — env-var binding. `secret === false`: plaintext, resolved at build
// time and stored in manifest.env. `secret === true`: sealed, routed to
// manifest.secretBindings; the CLI fetches the server public key, seals
// process.env[name], and writes the ciphertext into manifest.secrets at
// upload time.
// ---------------------------------------------------------------------------

interface EnvRef {
	readonly [ENV_REF_BRAND]: true;
	readonly name: string | undefined;
	readonly default: string | undefined;
	readonly secret: boolean;
}

// Overloads: `secret: true` is exclusive with `default`. The combined
// signature below is the implementation; callers only see the overloads.
function env(opts: { name?: string; secret: true }): EnvRef;
function env(opts?: { name?: string; default?: string }): EnvRef;
function env(
	opts?: { name?: string; default?: string } | { name?: string; secret: true },
): EnvRef {
	const secret = opts !== undefined && "secret" in opts && opts.secret === true;
	return {
		[ENV_REF_BRAND]: true,
		name: opts?.name,
		default: secret
			? undefined
			: (opts as { default?: string } | undefined)?.default,
		secret,
	};
}

function isEnvRef(value: unknown): value is EnvRef {
	return typeof value === "object" && value !== null && ENV_REF_BRAND in value;
}

function isSecret(ref: EnvRef): boolean {
	return ref.secret;
}

function getDefaultEnvSource(): Record<string, string | undefined> {
	const g = globalThis as Record<string, unknown>;
	return (
		(g.process as { env: Record<string, string | undefined> } | undefined)
			?.env ?? {}
	);
}

function resolveEnvRecord(
	record: Record<string, string | EnvRef>,
	envSource: Record<string, string | undefined>,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!isEnvRef(value)) {
			resolved[key] = value;
			continue;
		}
		const envName = value.name ?? key;
		const envValue = envSource[envName] ?? value.default;
		if (envValue === undefined) {
			throw new Error(`Missing environment variable: ${envName}`);
		}
		// Secret bindings: the plaintext is only used by the CLI at upload
		// to seal against the server public key; it MUST NOT leak into the
		// build output. Emit a sentinel string so author code like
		// `cronTrigger({ schedule: wf.env.X })` and `` `Bearer ${wf.env.T}` ``
		// embeds a placeholder that survives through trigger descriptors
		// into the manifest. The workflow registry substitutes these for
		// decrypted plaintext before calling `TriggerSource.reconfigure`.
		// At runtime (sandbox), this branch is skipped — defineWorkflow
		// reads plaintext from `globalThis.workflow.env` directly.
		resolved[key] = isSecret(value) ? encodeSentinel(envName) : envValue;
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

interface Workflow<
	Env extends Readonly<Record<string, string>> = Readonly<
		Record<string, string>
	>,
> extends RuntimeWorkflow<Env> {
	readonly [WORKFLOW_BRAND]: true;
}

interface DefineWorkflowConfig<
	E extends Record<string, string | EnvRef> = Record<string, string | EnvRef>,
> {
	name?: string;
	env?: E;
	// Injection point for tests — not part of the public contract.
	envSource?: Record<string, string | undefined>;
}

function defineWorkflow<E extends Record<string, string | EnvRef>>(
	config?: DefineWorkflowConfig<E>,
): Workflow<Readonly<{ [K in keyof E]: string }>> {
	type ExpectedEnv = Readonly<{ [K in keyof E]: string }>;
	// Runtime path: the env-installer plugin installs globalThis.workflow at
	// Phase 2, before user source runs. Read it and return. This is what
	// authors see at invocation time.
	const raw = globalThis.workflow as RuntimeWorkflow<ExpectedEnv> | undefined;
	if (raw !== undefined) {
		const workflow: Workflow<ExpectedEnv> = {
			[WORKFLOW_BRAND]: true,
			name: raw.name || config?.name || "",
			env: raw.env,
		};
		return Object.freeze(workflow);
	}
	// Build-time discovery path: the Vite plugin evaluates the workflow IIFE
	// in a Node vm context where globalThis.workflow is not installed. In
	// that path we resolve config.env against process.env (or the injected
	// test source) so the plugin can read the resolved values off the
	// discovered workflow and write them into manifest.env.
	const envSource = config?.envSource ?? getDefaultEnvSource();
	const resolved = config?.env
		? resolveEnvRecord(config.env as Record<string, string | EnvRef>, envSource)
		: {};
	// Collect the envNames of every secret binding so the vite plugin can
	// route them into manifest.secretBindings. The name is either
	// `ref.name` (explicit) or the key the ref is assigned to.
	const secretBindings: string[] = [];
	if (config?.env) {
		for (const [key, value] of Object.entries(config.env)) {
			if (isEnvRef(value) && isSecret(value)) {
				secretBindings.push(value.name ?? key);
			}
		}
	}
	const workflow: Workflow<ExpectedEnv> & {
		[WORKFLOW_SECRET_BINDINGS_KEY]?: readonly string[];
	} = {
		[WORKFLOW_BRAND]: true,
		[WORKFLOW_SECRET_BINDINGS_KEY]: Object.freeze(secretBindings),
		name: config?.name ?? "",
		env: resolved as ExpectedEnv,
	};
	return Object.freeze(workflow);
}

function isWorkflow(value: unknown): value is Workflow {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[WORKFLOW_BRAND] === true
	);
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * `action({input, output, handler, name})` returns a callable that routes
 * every invocation through `globalThis.__sdk.dispatchAction(name, input,
 * handler)` — installed by the sdk-support plugin as a locked global during
 * sandbox boot. The sdk-support plugin validates the input host-side via
 * the host-call-action plugin, invokes the handler in-sandbox, and validates
 * the returned value host-side against the declared output schema before
 * returning to the caller. The SDK itself contains zero bridge logic.
 *
 * `name` is required. The vite-plugin injects it into each `action({...})`
 * call expression at build time by AST-transforming `export const X =
 * action({...})` declarations to `export const X = action({..., name: "X"})`.
 * Hand-rolled bundles (test fixtures, etc.) must pass `name` explicitly.
 * Invoking an action constructed without a name throws.
 *
 * The captured `handler` is closed over the callable but NOT exposed as a
 * public property — the only way to invoke the handler is through the
 * callable, which always routes through the dispatcher.
 *
 * `config.output` is stored on the callable as the `output` readonly
 * property (for the vite-plugin's `toJSONSchema()` emission + UI rendering)
 * but is NOT invoked at runtime: output validation lives host-side, keyed
 * on the action name and the manifest's declared output schema.
 */

interface Action<I = unknown, O = unknown> {
	(input: I): Promise<O>;
	readonly [ACTION_BRAND]: true;
	readonly input: z.ZodType<I>;
	readonly output: z.ZodType<O>;
	readonly name: string;
}

function action<
	Input extends z.ZodType = z.ZodAny,
	Output extends z.ZodType = z.ZodAny,
>(config: {
	input?: Input;
	output?: Output;
	handler: (input: z.infer<Input>) => Promise<z.infer<Output>>;
	name?: string;
}): Action<z.infer<Input>, z.infer<Output>> {
	const assignedName = config.name;
	const handler = config.handler;
	const inputSchema = (config.input ?? z.any()) as Input;
	const outputSchema = (config.output ?? z.any()) as Output;
	const callable = async function callAction(
		input: z.infer<Input>,
	): Promise<z.infer<Output>> {
		if (assignedName === undefined || assignedName === "") {
			throw new Error(
				"Action constructed without a name; build via the wfe CLI (which name-injects via AST transform)",
			);
		}
		return (await dispatchViaSdk(
			assignedName,
			input,
			handler as (input: unknown) => Promise<unknown>,
		)) as z.infer<Output>;
	};
	Object.defineProperty(callable, ACTION_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "input", {
		value: inputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "output", {
		value: outputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "name", {
		value: assignedName ?? "",
		writable: false,
		configurable: false,
	});
	return callable as unknown as Action<z.infer<Input>, z.infer<Output>>;
}

function isAction(value: unknown): value is Action {
	return (
		typeof value === "function" &&
		(value as unknown as Record<symbol, unknown>)[ACTION_BRAND] === true
	);
}

// ---------------------------------------------------------------------------
// HTTP trigger
// ---------------------------------------------------------------------------

// HttpTrigger is a callable: invoking it runs the user's handler. Brand,
// method, body, and responseBody are attached as readonly properties on the
// callable. There is no public `.handler` slot; the callable IS the handler
// invocation path. The webhook URL is mechanical — derived from the
// trigger's exported identifier as `/webhooks/<owner>/<workflow>/<export-name>`
// — so no URL-shape config exists on this type.
//
// The composed input/output JSON Schemas (envelope with body + headers + url
// + method) live in the manifest only — the vite-plugin synthesises them on
// the host at build time. No zod composition happens at bundle load.
interface HttpTrigger<Body extends z.ZodType = z.ZodType> {
	(payload: HttpTriggerPayload<z.infer<Body>>): Promise<HttpTriggerResult>;
	readonly [HTTP_TRIGGER_BRAND]: true;
	readonly method: string;
	readonly body: Body | undefined;
	readonly responseBody: z.ZodType | undefined;
}

function httpTrigger<
	B extends z.ZodType = z.ZodAny,
	R extends z.ZodType | undefined = undefined,
>(config: {
	method?: string;
	body?: B;
	responseBody?: R;
	handler: (
		payload: HttpTriggerPayload<B extends z.ZodType ? z.infer<B> : unknown>,
	) => Promise<
		R extends z.ZodType
			? {
					status?: number;
					body: z.infer<R>;
					headers?: Record<string, string>;
				}
			: HttpTriggerResult
	>;
}): HttpTrigger<B extends z.ZodType ? B : z.ZodAny> {
	if (typeof config.handler !== "function") {
		throw new Error("httpTrigger(...) is missing a handler function");
	}
	const method = config.method ?? "POST";
	const handler = config.handler;
	const callable = function callTrigger(
		payload: Parameters<typeof handler>[0],
	): Promise<HttpTriggerResult> {
		return handler(payload);
	};
	attachTriggerMetadata(callable, {
		method,
		body: config.body,
		responseBody: config.responseBody,
	});
	return callable as unknown as HttpTrigger<B extends z.ZodType ? B : z.ZodAny>;
}

interface TriggerMetadata {
	method: string;
	body: z.ZodType | undefined;
	responseBody: z.ZodType | undefined;
}

function attachTriggerMetadata(callable: object, meta: TriggerMetadata): void {
	Object.defineProperty(callable, HTTP_TRIGGER_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	for (const [key, value] of Object.entries(meta)) {
		Object.defineProperty(callable, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}
}

function isHttpTrigger(value: unknown): value is HttpTrigger {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		return false;
	}
	return (value as Record<symbol, unknown>)[HTTP_TRIGGER_BRAND] === true;
}

// ---------------------------------------------------------------------------
// Cron trigger
// ---------------------------------------------------------------------------

interface CronTrigger {
	(): Promise<unknown>;
	readonly [CRON_TRIGGER_BRAND]: true;
	readonly schedule: string;
	readonly tz: string;
}

// The factory runs in two environments:
//   - On the build host (Node), where `Intl.DateTimeFormat()` returns the
//     host's IANA zone. The vite-plugin evaluates the bundle here and reads
//     the resolved `.tz` off the branded export for the manifest.
//   - Inside QuickJS at workflow load time, where `Intl` is not available
//     and accessing `Intl.DateTimeFormat()` throws `ReferenceError`. The
//     sandbox never reads the trigger's `.tz` (the runtime uses the
//     manifest-derived descriptor's `tz` instead), so fall back to "UTC"
//     when Intl is unavailable rather than crash on bundle load.
const DEFAULT_TIME_ZONE: string = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return "UTC";
	}
})();

function cronTrigger<const S extends string>(config: {
	schedule: StandardCRON<S> extends never ? never : S;
	tz?: string;
	handler: () => Promise<unknown>;
}): CronTrigger {
	if (typeof config.handler !== "function") {
		throw new Error(
			`cronTrigger({ schedule: ${JSON.stringify(config.schedule)} }) is missing a handler function`,
		);
	}
	const resolvedTz = config.tz ?? DEFAULT_TIME_ZONE;
	const handler = config.handler;
	const callable = function callCronTrigger(): Promise<unknown> {
		return handler();
	};
	Object.defineProperty(callable, CRON_TRIGGER_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "schedule", {
		value: config.schedule,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "tz", {
		value: resolvedTz,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	return callable as unknown as CronTrigger;
}

// ---------------------------------------------------------------------------
// secret(): runtime plaintext registration for the scrubber
// ---------------------------------------------------------------------------
//
// Registers an author-computed string with the runtime's plaintext
// scrubber so subsequent `WorkerToMain` messages have the literal value
// replaced with "[secret]" before archive. Returns the input unchanged so
// callers can inline it: `const sig = secret(computeSig(...))`.
//
// Behaviour depends on whether the runtime's `secrets` plugin has
// installed `globalThis.$secrets`:
//   - At invocation time in a production sandbox: $secrets is present;
//     registration takes effect immediately for subsequent messages.
//   - At build-time discovery (Node-VM context): $secrets is absent;
//     the call is a no-op and returns the input unchanged.

function secret(value: string): string {
	const bridge = (globalThis as { $secrets?: { addSecret(v: string): void } })
		.$secrets;
	bridge?.addSecret(value);
	return value;
}

function isCronTrigger(value: unknown): value is CronTrigger {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		return false;
	}
	return (value as Record<symbol, unknown>)[CRON_TRIGGER_BRAND] === true;
}

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

interface ManualTrigger<I extends z.ZodType = z.ZodType> {
	(input: z.infer<I>): Promise<unknown>;
	readonly [MANUAL_TRIGGER_BRAND]: true;
	readonly inputSchema: I;
	readonly outputSchema: z.ZodType;
}

function manualTrigger<I extends z.ZodType = z.ZodAny>(config: {
	input?: I;
	output?: z.ZodType;
	handler: (input: z.infer<I>) => Promise<unknown>;
}): ManualTrigger<I> {
	if (typeof config.handler !== "function") {
		throw new Error("manualTrigger(...) is missing a handler function");
	}
	const inputSchema = (config.input ?? z.any()) as I;
	const outputSchema = config.output ?? z.any();
	const handler = config.handler;
	const callable = function callManualTrigger(
		input: z.infer<I>,
	): Promise<unknown> {
		return handler(input);
	};
	Object.defineProperty(callable, MANUAL_TRIGGER_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "inputSchema", {
		value: inputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "outputSchema", {
		value: outputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	return callable as unknown as ManualTrigger<I>;
}

function isManualTrigger(value: unknown): value is ManualTrigger {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		return false;
	}
	return (value as Record<symbol, unknown>)[MANUAL_TRIGGER_BRAND] === true;
}

// ---------------------------------------------------------------------------
// IMAP trigger
// ---------------------------------------------------------------------------

type ImapTls = "required" | "starttls" | "none";

interface ImapTrigger {
	(msg: ImapMessage): Promise<ImapTriggerResult>;
	readonly [IMAP_TRIGGER_BRAND]: true;
	readonly host: string;
	readonly port: number;
	readonly tls: ImapTls;
	readonly insecureSkipVerify: boolean;
	readonly user: string;
	readonly password: string;
	readonly folder: string;
	readonly search: string;
	readonly onError: ImapTriggerResult;
	readonly inputSchema: z.ZodType;
	readonly outputSchema: z.ZodType;
}

// Structural schema constants reused by every imapTrigger() call. Kept as
// module-level constants (not per-call closures) so reference equality
// holds across triggers and zod's `.parse` caches stay warm.
const imapAddressSchema = z.object({
	name: z.string().optional(),
	address: z.string(),
});
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
const imapTriggerResultSchema = z.object({
	command: z.array(z.string()).optional(),
});

function imapTrigger(config: {
	host: string;
	port: number;
	tls?: ImapTls;
	insecureSkipVerify?: boolean;
	user: string;
	password: string;
	folder: string;
	search: string;
	onError?: ImapTriggerResult;
	handler: (msg: ImapMessage) => Promise<ImapTriggerResult>;
}): ImapTrigger {
	if (typeof config.handler !== "function") {
		throw new Error("imapTrigger(...) is missing a handler function");
	}
	const resolvedTls: ImapTls = config.tls ?? "required";
	const resolvedInsecure = config.insecureSkipVerify ?? false;
	const resolvedOnError: ImapTriggerResult = config.onError ?? {};
	const handler = config.handler;
	const callable = function callImapTrigger(
		msg: ImapMessage,
	): Promise<ImapTriggerResult> {
		return handler(msg);
	};
	Object.defineProperty(callable, IMAP_TRIGGER_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	for (const [key, value] of Object.entries({
		host: config.host,
		port: config.port,
		tls: resolvedTls,
		insecureSkipVerify: resolvedInsecure,
		user: config.user,
		password: config.password,
		folder: config.folder,
		search: config.search,
		onError: resolvedOnError,
		inputSchema: imapMessageSchema,
		outputSchema: imapTriggerResultSchema,
	})) {
		Object.defineProperty(callable, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}
	return callable as unknown as ImapTrigger;
}

function isImapTrigger(value: unknown): value is ImapTrigger {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		return false;
	}
	return (value as Record<symbol, unknown>)[IMAP_TRIGGER_BRAND] === true;
}

// ---------------------------------------------------------------------------
// Trigger union
// ---------------------------------------------------------------------------

type Trigger = HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	HttpTriggerPayload,
	HttpTriggerResult,
	ImapMessage,
	ImapTriggerResult,
	Manifest,
} from "@workflow-engine/core";
export type {
	AttachmentContent,
	MailError,
	MailErrorKind,
	SendMailAttachment,
	SendMailOptions,
	SendMailResult,
	SendMailSmtp,
} from "./mail.js";
export type {
	SqlColumnMeta,
	SqlConnection,
	SqlConnectionObject,
	SqlError,
	SqlOptions,
	SqlParam,
	SqlResult,
	SqlRow,
	SqlSsl,
	SqlValue,
} from "./sql.js";
export type {
	Action,
	CronTrigger,
	EnvRef,
	HttpTrigger,
	ImapTrigger,
	ManualTrigger,
	Trigger,
	Workflow,
};
export {
	ACTION_BRAND,
	action,
	CRON_TRIGGER_BRAND,
	cronTrigger,
	defineWorkflow,
	env,
	executeSql,
	HTTP_TRIGGER_BRAND,
	httpTrigger,
	IMAP_TRIGGER_BRAND,
	imapTrigger,
	isAction,
	isCronTrigger,
	isEnvRef,
	isHttpTrigger,
	isImapTrigger,
	isManualTrigger,
	isSecret,
	isWorkflow,
	MANUAL_TRIGGER_BRAND,
	ManifestSchema,
	manualTrigger,
	secret,
	sendMail,
	WORKFLOW_BRAND,
	WORKFLOW_SECRET_BINDINGS_KEY,
	z,
};
