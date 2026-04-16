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
 * The vite-plugin calls `__setActionName(exportName)` after discovering
 * the action export:
 *
 * `action({...})` returns a callable carrying the brand + its schemas and
 * handler. The callable, when invoked at runtime inside the sandbox, does
 * three things in order:
 *   1. Notify the host via `globalThis.__hostCallAction(name, input)` —
 *      the host validates input against the manifest's input JSON Schema
 *      and audit-logs the invocation. The host does NOT dispatch the
 *      handler.
 *   2. Call the user-provided `handler(input)` directly (a plain JS
 *      function call, same QuickJS context, no nested `sandbox.run()`).
 *   3. Validate the handler's return value against the captured output
 *      Zod schema (via the Zod bundle that ships inlined in the workflow
 *      bundle) and return the validated output to the caller.
 *
 * The `__hostCallAction` global is looked up lazily so that:
 *   - The SDK module can be imported in Node at build/test time where no
 *     such global exists.
 *   - The vite-plugin can install `__hostCallAction` in the sandbox and
 *     a `name` on each action before the workflow is invoked.
 *
 * The action's `name` starts out as `undefined`. The vite-plugin walks the
 * workflow module's exports, identifies each action by `ACTION_BRAND`, and
 * writes the export name into the callable via the mutable `name` slot
 * (using the `__setActionName(name)` helper). Once assigned, `name` is
 * frozen — subsequent calls to `__setActionName` are a no-op when the new
 * value matches or throw otherwise. This protects against accidental
 * re-naming while keeping the single-pass build simple.
 */

interface Action<I = unknown, O = unknown> {
	(input: I): Promise<O>;
	readonly [ACTION_BRAND]: true;
	readonly input: z.ZodType<I>;
	readonly output: z.ZodType<O>;
	readonly handler: (input: I) => Promise<O>;
	readonly name: string;
	__setActionName(name: string): void;
}

interface ActionMetadata<I, O> {
	readonly callable: (input: I) => Promise<O>;
	readonly input: z.ZodType<I>;
	readonly output: z.ZodType<O>;
	readonly handler: (input: I) => Promise<O>;
	readonly getName: () => string;
	readonly setName: (name: string) => void;
}

function attachActionMetadata<I, O>(meta: ActionMetadata<I, O>): Action<I, O> {
	const { callable } = meta;
	Object.defineProperty(callable, ACTION_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "input", {
		value: meta.input,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "output", {
		value: meta.output,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "handler", {
		value: meta.handler,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(callable, "name", {
		get: meta.getName,
		configurable: true,
	});
	Object.defineProperty(callable, "__setActionName", {
		value: meta.setName,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return callable as unknown as Action<I, O>;
}

function action<I, O>(config: {
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	handler: (input: I) => Promise<O>;
}): Action<I, O> {
	let assignedName: string | undefined;
	const outputSchema = config.output;
	const handler = config.handler;
	const callable = async function callAction(input: I): Promise<O> {
		if (assignedName === undefined) {
			throw new Error(
				"Action was invoked before the build system assigned it a name",
			);
		}
		return (await dispatchAction(
			assignedName,
			input,
			handler as (input: unknown) => Promise<unknown>,
			outputSchema,
		)) as O;
	};
	const setName = (name: string) => {
		if (assignedName !== undefined) {
			if (assignedName === name) {
				return;
			}
			throw new Error(
				`Action already bound to name "${assignedName}"; refusing to rebind to "${name}"`,
			);
		}
		assignedName = name;
	};
	return attachActionMetadata({
		callable,
		input: config.input,
		output: config.output,
		handler: config.handler,
		getName: () => assignedName ?? "",
		setName,
	});
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

interface HttpTrigger<
	Path extends string = string,
	Body extends z.ZodType = z.ZodType,
	Params extends z.ZodType = z.ZodType,
	Query extends z.ZodType = z.ZodType,
> {
	readonly [HTTP_TRIGGER_BRAND]: true;
	readonly path: Path;
	readonly method: string;
	readonly body: Body;
	readonly params: Params;
	readonly query: Query | undefined;
	// Full composite payload schema (body + headers + url + method + params +
	// query). Serialized to JSON Schema in the manifest for the trigger UI.
	readonly schema: z.ZodType;
	readonly handler: (
		payload: HttpTriggerPayload<
			z.infer<Body>,
			z.infer<Params> & Record<string, string>,
			z.infer<Query> & Record<string, unknown>
		>,
	) => Promise<HttpTriggerResult>;
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

	const trigger: HttpTrigger<
		P,
		B extends z.ZodType ? B : z.ZodUnknown,
		ParamsSchemaFor<P>,
		Q extends z.ZodObject<z.ZodRawShape> ? Q : z.ZodObject<Record<never, never>>
	> = {
		[HTTP_TRIGGER_BRAND]: true,
		path: config.path,
		method,
		body: bodySchema,
		params: paramsSchema,
		query: (querySchema ?? z.object({})) as Q extends z.ZodObject<z.ZodRawShape>
			? Q
			: z.ZodObject<Record<never, never>>,
		schema: compositeSchema,
		handler: config.handler as HttpTrigger<
			P,
			B extends z.ZodType ? B : z.ZodUnknown,
			ParamsSchemaFor<P>,
			Q extends z.ZodObject<z.ZodRawShape>
				? Q
				: z.ZodObject<Record<never, never>>
		>["handler"],
	};
	return Object.freeze(trigger);
}

function isHttpTrigger(value: unknown): value is HttpTrigger {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[HTTP_TRIGGER_BRAND] === true
	);
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
