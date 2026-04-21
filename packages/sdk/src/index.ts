import type {
	HttpTriggerPayload,
	HttpTriggerResult,
} from "@workflow-engine/core";
// biome-ignore lint/style/noExportedImports: z and ManifestSchema are re-exported for workflow authors alongside locally defined exports
import { dispatchAction, ManifestSchema, z } from "@workflow-engine/core";
import type { StandardCRON } from "ts-cron-validator";

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
const WORKFLOW_BRAND: unique symbol = Symbol.for("@workflow-engine/workflow");
const ENV_REF_BRAND: unique symbol = Symbol.for("@workflow-engine/env-ref");

// ---------------------------------------------------------------------------
// EnvRef
// ---------------------------------------------------------------------------

interface EnvRef {
	readonly [ENV_REF_BRAND]: true;
	readonly name: string | undefined;
	readonly default: string | undefined;
}

function env(opts?: { name?: string; default?: string }): EnvRef {
	return {
		[ENV_REF_BRAND]: true,
		name: opts?.name,
		default: opts?.default,
	};
}

function isEnvRef(value: unknown): value is EnvRef {
	return typeof value === "object" && value !== null && ENV_REF_BRAND in value;
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
> {
	readonly [WORKFLOW_BRAND]: true;
	readonly name: string | undefined;
	readonly env: Env;
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
	const envSource = config?.envSource ?? getDefaultEnvSource();
	const resolved = config?.env
		? resolveEnvRecord(config.env as Record<string, string | EnvRef>, envSource)
		: {};
	const frozenEnv = Object.freeze(resolved) as Readonly<{
		[K in keyof E]: string;
	}>;
	const workflow: Workflow<Readonly<{ [K in keyof E]: string }>> = {
		[WORKFLOW_BRAND]: true,
		name: config?.name,
		env: frozenEnv,
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
 * every invocation through `dispatchAction(name, input, handler, outputSchema)`
 * — the host-side `__hostCallAction` bridge validates the input, the handler
 * runs in the same QuickJS context, and the output is validated against the
 * output schema before being returned.
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
	const outputSchema = config.output;
	const handler = config.handler;
	const callable = async function callAction(input: I): Promise<O> {
		if (assignedName === undefined || assignedName === "") {
			throw new Error(
				"Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/vite-plugin",
			);
		}
		return (await dispatchAction(
			assignedName,
			input,
			handler as (input: unknown) => Promise<unknown>,
			outputSchema,
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
// method, body, inputSchema, outputSchema are attached as readonly properties
// on the callable. There is no public `.handler` slot; the callable IS the
// handler invocation path. The webhook URL is mechanical — derived from the
// trigger's exported identifier as `/webhooks/<tenant>/<workflow>/<export-name>`
// — so no URL-shape config exists on this type.
interface HttpTrigger<Body extends z.ZodType = z.ZodType> {
	(payload: HttpTriggerPayload<z.infer<Body>>): Promise<HttpTriggerResult>;
	readonly [HTTP_TRIGGER_BRAND]: true;
	readonly method: string;
	readonly body: Body;
	// Composite input schema (body + headers + url + method). Serialized to
	// JSON Schema in the manifest for the UI + host-side shared validator.
	readonly inputSchema: z.ZodType;
	// Output schema (HttpTriggerResult shape). Serialized to JSON Schema in
	// the manifest for uniform output rendering.
	readonly outputSchema: z.ZodType;
}

const httpTriggerOutputSchema = z.object({
	status: z.number().optional(),
	body: z.unknown().optional(),
	headers: z.record(z.string(), z.string()).optional(),
});

function httpTrigger<B extends z.ZodType = z.ZodUnknown>(config: {
	method?: string;
	body?: B;
	handler: (
		payload: HttpTriggerPayload<B extends z.ZodType ? z.infer<B> : unknown>,
	) => Promise<HttpTriggerResult>;
}): HttpTrigger<B extends z.ZodType ? B : z.ZodUnknown> {
	if (typeof config.handler !== "function") {
		throw new Error("httpTrigger(...) is missing a handler function");
	}
	const bodySchema = (config.body ?? z.unknown()) as B extends z.ZodType
		? B
		: z.ZodUnknown;
	const method = config.method ?? "POST";

	const compositeSchema = z.object({
		body: bodySchema,
		headers: z.record(z.string(), z.string()),
		url: z.string(),
		method: z.string().default(method),
	});

	const handler = config.handler;
	const callable = function callTrigger(
		payload: Parameters<typeof handler>[0],
	): Promise<HttpTriggerResult> {
		return handler(payload);
	};
	attachTriggerMetadata(callable, {
		method,
		body: bodySchema,
		inputSchema: compositeSchema,
		outputSchema: httpTriggerOutputSchema,
	});
	return callable as unknown as HttpTrigger<
		B extends z.ZodType ? B : z.ZodUnknown
	>;
}

interface TriggerMetadata {
	method: string;
	body: z.ZodType;
	inputSchema: z.ZodType;
	outputSchema: z.ZodType;
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
	readonly inputSchema: z.ZodType;
	readonly outputSchema: z.ZodType;
}

const cronTriggerInputSchema = z.object({});
const cronTriggerOutputSchema = z.unknown();

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
	Object.defineProperty(callable, "inputSchema", {
		value: cronTriggerInputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "outputSchema", {
		value: cronTriggerOutputSchema,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	return callable as unknown as CronTrigger;
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
// Trigger union
// ---------------------------------------------------------------------------

type Trigger = HttpTrigger | CronTrigger;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	HttpTriggerPayload,
	HttpTriggerResult,
	Manifest,
} from "@workflow-engine/core";
export type { Action, CronTrigger, EnvRef, HttpTrigger, Trigger, Workflow };
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
	isHttpTrigger,
	isWorkflow,
	ManifestSchema,
	WORKFLOW_BRAND,
	z,
};
