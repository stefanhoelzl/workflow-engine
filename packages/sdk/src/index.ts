import type {
	HttpTriggerPayload,
	HttpTriggerResult,
} from "@workflow-engine/core";
// biome-ignore lint/style/noExportedImports: z and ManifestSchema are re-exported for workflow authors alongside locally defined exports
import { dispatchAction, ManifestSchema, z } from "@workflow-engine/core";

// ---------------------------------------------------------------------------
// Brand symbols
// ---------------------------------------------------------------------------

const ACTION_BRAND: unique symbol = Symbol.for("@workflow-engine/action");
const HTTP_TRIGGER_BRAND: unique symbol = Symbol.for(
	"@workflow-engine/http-trigger",
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

type ExtractParams<T extends string> =
	T extends `${string}:${infer Param}/${infer Rest}`
		? Param | ExtractParams<Rest>
		: T extends `${string}:${infer Param}`
			? Param
			: T extends `${string}*${infer Param}`
				? Param
				: never;

type ParamsSchemaFor<P extends string> = string extends P
	? z.ZodRecord<z.ZodString, z.ZodString>
	: [ExtractParams<P>] extends [never]
		? z.ZodObject<Record<never, never>>
		: z.ZodObject<{ [K in ExtractParams<P>]: z.ZodString }>;

function extractParamNames(path: string): string[] {
	const names: string[] = [];
	for (const segment of path.split("/")) {
		if (segment.startsWith(":")) {
			names.push(segment.slice(1));
		} else if (segment.startsWith("*")) {
			names.push(segment.slice(1));
		}
	}
	return names;
}

// HttpTrigger is a callable: invoking it runs the user's handler. Brand,
// path, method, body, params, query, schema are attached as readonly
// properties on the callable. There is no public `.handler` slot; the
// callable IS the handler invocation path.
interface HttpTrigger<
	Path extends string = string,
	Body extends z.ZodType = z.ZodType,
	Params extends z.ZodType = z.ZodType,
	Query extends z.ZodType = z.ZodType,
> {
	(
		payload: HttpTriggerPayload<
			z.infer<Body>,
			z.infer<Params> & Record<string, string>,
			z.infer<Query> & Record<string, unknown>
		>,
	): Promise<HttpTriggerResult>;
	readonly [HTTP_TRIGGER_BRAND]: true;
	readonly path: Path;
	readonly method: string;
	readonly body: Body;
	readonly params: Params;
	readonly query: Query | undefined;
	readonly schema: z.ZodType;
}

function httpTrigger<
	const P extends string,
	B extends z.ZodType = z.ZodUnknown,
	Q extends z.ZodObject<z.ZodRawShape> | undefined = undefined,
>(config: {
	path: P;
	method?: string;
	body?: B;
	query?: Q;
	params?: z.ZodObject<{ [K in ExtractParams<P>]: z.ZodType }>;
	handler: (
		payload: HttpTriggerPayload<
			B extends z.ZodType ? z.infer<B> : unknown,
			z.infer<ParamsSchemaFor<P>> & Record<string, string>,
			Q extends z.ZodObject<z.ZodRawShape>
				? z.infer<Q> & Record<string, unknown>
				: Record<string, never>
		>,
	) => Promise<HttpTriggerResult>;
}): HttpTrigger<
	P,
	B extends z.ZodType ? B : z.ZodUnknown,
	ParamsSchemaFor<P>,
	Q extends z.ZodObject<z.ZodRawShape> ? Q : z.ZodObject<Record<never, never>>
> {
	if (typeof config.handler !== "function") {
		throw new Error(
			`httpTrigger({ path: ${JSON.stringify(config.path)} }) is missing a handler function`,
		);
	}
	const bodySchema = (config.body ?? z.unknown()) as B extends z.ZodType
		? B
		: z.ZodUnknown;
	const paramNames = extractParamNames(config.path);
	const paramsSchema = (config.params ??
		z.object(
			Object.fromEntries(paramNames.map((n) => [n, z.string()])),
		)) as ParamsSchemaFor<P>;
	const querySchema = config.query;
	const method = config.method ?? "POST";

	const compositeSchema = z.object({
		body: bodySchema,
		headers: z.record(z.string(), z.string()),
		url: z.string(),
		method: z.string().default(method),
		params: paramsSchema,
		query: querySchema ?? z.object({}),
	});

	const handler = config.handler;
	const callable = function callTrigger(
		payload: Parameters<typeof handler>[0],
	): Promise<HttpTriggerResult> {
		return handler(payload);
	};
	attachTriggerMetadata(callable, {
		path: config.path,
		method,
		body: bodySchema,
		params: paramsSchema,
		query: querySchema,
		schema: compositeSchema,
	});
	return callable as unknown as HttpTrigger<
		P,
		B extends z.ZodType ? B : z.ZodUnknown,
		ParamsSchemaFor<P>,
		Q extends z.ZodObject<z.ZodRawShape> ? Q : z.ZodObject<Record<never, never>>
	>;
}

interface TriggerMetadata {
	path: string;
	method: string;
	body: z.ZodType;
	params: z.ZodType;
	query: z.ZodType | undefined;
	schema: z.ZodType;
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
			value: key === "query" ? (value ?? z.object({})) : value,
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
// Trigger union
// ---------------------------------------------------------------------------

type Trigger = HttpTrigger;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
	HttpTriggerPayload,
	HttpTriggerResult,
	Manifest,
} from "@workflow-engine/core";
export type { Action, EnvRef, ExtractParams, HttpTrigger, Trigger, Workflow };
export {
	ACTION_BRAND,
	action,
	defineWorkflow,
	env,
	extractParamNames,
	HTTP_TRIGGER_BRAND,
	httpTrigger,
	isAction,
	isHttpTrigger,
	isWorkflow,
	ManifestSchema,
	WORKFLOW_BRAND,
	z,
};
