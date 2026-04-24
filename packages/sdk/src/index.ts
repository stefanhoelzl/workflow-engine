import type {
	HttpTriggerPayload,
	HttpTriggerResult,
	RuntimeWorkflow,
} from "@workflow-engine/core";
// biome-ignore lint/style/noExportedImports: z and ManifestSchema are re-exported for workflow authors alongside locally defined exports
import { ManifestSchema, z } from "@workflow-engine/core";
import type { StandardCRON } from "ts-cron-validator";
// biome-ignore lint/style/noExportedImports: sendMail is re-exported from the unified @workflow-engine/sdk barrel so workflow authors get one entry point
import { sendMail } from "./mail.js";

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
const WORKFLOW_BRAND: unique symbol = Symbol.for("@workflow-engine/workflow");
const ENV_REF_BRAND: unique symbol = Symbol.for("@workflow-engine/env-ref");
const SECRET_ENV_REF_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/secret-env-ref",
);
// Carries the list of envNames declared with `env({secret: true})` on the
// returned Workflow at build-time discovery. Vite plugin reads this via
// the same symbol key (cross-context-safe because Symbol.for).
const WORKFLOW_SECRET_BINDINGS_KEY: unique symbol = Symbol.for(
	"@workflow-engine/workflow-secret-bindings",
);

// ---------------------------------------------------------------------------
// EnvRef — plaintext env binding (resolved at build time, stored in manifest.env)
// SecretEnvRef — sealed env binding (routed to manifest.secretBindings; the CLI
//                fetches the server public key, seals process.env[name], and
//                writes the ciphertext into manifest.secrets at upload time).
// ---------------------------------------------------------------------------

interface EnvRef {
	readonly [ENV_REF_BRAND]: true;
	readonly name: string | undefined;
	readonly default: string | undefined;
}

interface SecretEnvRef {
	readonly [SECRET_ENV_REF_BRAND]: true;
	readonly name: string | undefined;
}

// Overloads: `secret: true` is exclusive with `default`. The combined
// signature below is the implementation; callers only see the overloads.
function env(opts: { name?: string; secret: true }): SecretEnvRef;
function env(opts?: { name?: string; default?: string }): EnvRef;
function env(
	opts?: { name?: string; default?: string } | { name?: string; secret: true },
): EnvRef | SecretEnvRef {
	if (opts && "secret" in opts && opts.secret === true) {
		return {
			[SECRET_ENV_REF_BRAND]: true,
			name: opts.name,
		};
	}
	const plainOpts = opts as { name?: string; default?: string } | undefined;
	return {
		[ENV_REF_BRAND]: true,
		name: plainOpts?.name,
		default: plainOpts?.default,
	};
}

function isEnvRef(value: unknown): value is EnvRef {
	return typeof value === "object" && value !== null && ENV_REF_BRAND in value;
}

function isSecretEnvRef(value: unknown): value is SecretEnvRef {
	return (
		typeof value === "object" && value !== null && SECRET_ENV_REF_BRAND in value
	);
}

function getDefaultEnvSource(): Record<string, string | undefined> {
	const g = globalThis as Record<string, unknown>;
	return (
		(g.process as { env: Record<string, string | undefined> } | undefined)
			?.env ?? {}
	);
}

function resolveEnvRecord(
	record: Record<string, string | EnvRef | SecretEnvRef>,
	envSource: Record<string, string | undefined>,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		// SecretEnvRef entries are NOT resolved at build time — their values
		// are sealed by the CLI at upload against the server public key.
		// Excluded from manifest.env; the vite plugin routes them to
		// manifest.secretBindings instead.
		if (isSecretEnvRef(value)) {
			continue;
		}
		if (!isEnvRef(value)) {
			resolved[key] = value;
			continue;
		}
		const envName = value.name ?? key;
		const envValue = envSource[envName] ?? value.default;
		if (envValue === undefined) {
			throw new Error(`Missing environment variable: ${envName}`);
		}
		resolved[key] = envValue;
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
	E extends Record<string, string | EnvRef | SecretEnvRef> = Record<
		string,
		string | EnvRef | SecretEnvRef
	>,
> {
	name?: string;
	env?: E;
	// Injection point for tests — not part of the public contract.
	envSource?: Record<string, string | undefined>;
}

function defineWorkflow<
	E extends Record<string, string | EnvRef | SecretEnvRef>,
>(
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
		? resolveEnvRecord(
				config.env as Record<string, string | EnvRef | SecretEnvRef>,
				envSource,
			)
		: {};
	// Collect the envNames of every SecretEnvRef so the vite plugin can
	// route them into manifest.secretBindings. The name is either
	// `ref.name` (explicit) or the key the ref is assigned to.
	const secretBindings: string[] = [];
	if (config?.env) {
		for (const [key, value] of Object.entries(config.env)) {
			if (isSecretEnvRef(value)) {
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

function action<I, O>(config: {
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	handler: (input: I) => Promise<O>;
	name?: string;
}): Action<I, O> {
	const assignedName = config.name;
	const handler = config.handler;
	const callable = async function callAction(input: I): Promise<O> {
		if (assignedName === undefined || assignedName === "") {
			throw new Error(
				"Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin",
			);
		}
		return (await dispatchViaSdk(
			assignedName,
			input,
			handler as (input: unknown) => Promise<unknown>,
		)) as O;
	};
	Object.defineProperty(callable, ACTION_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "input", {
		value: config.input,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "output", {
		value: config.output,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "name", {
		value: assignedName ?? "",
		writable: false,
		configurable: false,
	});
	return callable as unknown as Action<I, O>;
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
// trigger's exported identifier as `/webhooks/<tenant>/<workflow>/<export-name>`
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
	B extends z.ZodType = z.ZodUnknown,
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
}): HttpTrigger<B extends z.ZodType ? B : z.ZodUnknown> {
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
	return callable as unknown as HttpTrigger<
		B extends z.ZodType ? B : z.ZodUnknown
	>;
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

const manualTriggerDefaultInputSchema = z.object({});
const manualTriggerDefaultOutputSchema = z.unknown();

function manualTrigger<
	I extends z.ZodType = typeof manualTriggerDefaultInputSchema,
>(config: {
	input?: I;
	output?: z.ZodType;
	handler: (input: z.infer<I>) => Promise<unknown>;
}): ManualTrigger<I> {
	if (typeof config.handler !== "function") {
		throw new Error("manualTrigger(...) is missing a handler function");
	}
	const inputSchema = (config.input ?? manualTriggerDefaultInputSchema) as I;
	const outputSchema = config.output ?? manualTriggerDefaultOutputSchema;
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
// Trigger union
// ---------------------------------------------------------------------------

type Trigger = HttpTrigger | CronTrigger | ManualTrigger;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	HttpTriggerPayload,
	HttpTriggerResult,
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
	Action,
	CronTrigger,
	EnvRef,
	HttpTrigger,
	ManualTrigger,
	SecretEnvRef,
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
	HTTP_TRIGGER_BRAND,
	httpTrigger,
	isAction,
	isCronTrigger,
	isEnvRef,
	isHttpTrigger,
	isManualTrigger,
	isSecretEnvRef,
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
