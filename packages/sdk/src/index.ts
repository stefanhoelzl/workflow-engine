import Ajv2020 from "ajv/dist/2020.js";
// biome-ignore lint/style/noExportedImports: z is re-exported for workflow authors alongside locally defined exports
import { z } from "zod";

// --- Event types ---

type EventDefs = Record<string, z.ZodType>;

interface Event<Payload = unknown> {
	name: string;
	payload: Payload;
}

// --- Path param extraction ---

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

// --- Trigger types ---

interface TriggerDef<S extends z.ZodType = z.ZodType> {
	type: string;
	schema: S;
	path: string;
	method: string;
	response?:
		| {
				status?: number | undefined;
				body?: unknown;
		  }
		| undefined;
}

interface TriggerConfig {
	name: string;
	type: string;
	path: string;
	method: string;
	params: string[];
	response?:
		| {
				status?: number | undefined;
				body?: unknown;
		  }
		| undefined;
}

type HttpPayloadSchema<
	B extends z.ZodType,
	P extends z.ZodType,
	Q extends z.ZodType = z.ZodObject<Record<never, never>>,
> = z.ZodObject<{
	body: B;
	headers: z.ZodRecord<z.ZodString, z.ZodString>;
	url: z.ZodString;
	method: z.ZodDefault<z.ZodString>;
	params: P;
	query: Q;
}>;

function detectArrayFields(
	querySchema: z.ZodObject<z.ZodRawShape>,
): Set<string> {
	const jsonSchema = z.toJSONSchema(querySchema, {}) as {
		properties?: Record<string, { type?: string }>;
	};
	const arrayFields = new Set<string>();
	if (jsonSchema.properties) {
		for (const [key, prop] of Object.entries(jsonSchema.properties)) {
			if (prop.type === "array") {
				arrayFields.add(key);
			}
		}
	}
	return arrayFields;
}

function coerceQuery(
	raw: unknown,
	arrayFields: Set<string>,
): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null) {
		return {};
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (arrayFields.has(key)) {
			result[key] = Array.isArray(value) ? value : [value];
		} else if (Array.isArray(value)) {
			result[key] = value.at(-1);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function http<
	const P extends string,
	B extends z.ZodType = z.ZodUnknown,
	Q extends z.ZodObject<z.ZodRawShape> = z.ZodObject<Record<never, never>>,
>(config: {
	path: P;
	method?: string;
	body?: B;
	query?: Q;
	params?: z.ZodObject<{ [K in ExtractParams<P>]: z.ZodType }>;
	response?: {
		status?: number;
		body?: unknown;
	};
}): TriggerDef<
	HttpPayloadSchema<
		B extends undefined ? z.ZodUnknown : B,
		ParamsSchemaFor<P>,
		Q
	>
> {
	const bodySchema = (config.body ?? z.unknown()) as B extends undefined
		? z.ZodUnknown
		: B;
	const paramNames = extractParamNames(config.path);
	const paramsSchema =
		config.params ??
		z.object(Object.fromEntries(paramNames.map((n) => [n, z.string()])));
	const method = config.method ?? "POST";

	const querySchema = config.query ?? z.object({});
	const arrayFields = detectArrayFields(
		querySchema as z.ZodObject<z.ZodRawShape>,
	);
	const coercedQuerySchema = z.preprocess(
		(raw) => coerceQuery(raw, arrayFields),
		querySchema,
	);

	const schema = z.object({
		body: bodySchema,
		headers: z.record(z.string(), z.string()),
		url: z.string().meta({ example: "https://example.com" }),
		method: z.string().default(method),
		params: paramsSchema,
		query: coercedQuerySchema,
	});
	return {
		type: "http",
		schema: schema as unknown as HttpPayloadSchema<
			B extends undefined ? z.ZodUnknown : B,
			ParamsSchemaFor<P>,
			Q
		>,
		path: config.path,
		method,
		response: config.response,
	};
}

// --- Action context ---

type EventPayloads<E extends EventDefs> = {
	[K in keyof E & string]: z.infer<E[K]>;
};

interface ActionContext<
	Payload = unknown,
	Events extends Record<string, unknown> = Record<string, unknown>,
	Env extends string = never,
> {
	event: Event<Payload>;
	env: Readonly<Record<Env, string>>;
	emit: <K extends keyof Events & string>(
		type: K,
		payload: Events[K],
	) => Promise<void>;
}

// --- EnvRef ---

const ENV_REF: unique symbol = Symbol("env");

interface EnvRef {
	readonly [ENV_REF]: true;
	readonly name: string | undefined;
	readonly default: string | undefined;
}

function env(
	nameOrOpts?: string | { default: string },
	opts?: { default: string },
): EnvRef {
	if (typeof nameOrOpts === "string") {
		return { [ENV_REF]: true, name: nameOrOpts, default: opts?.default };
	}
	return { [ENV_REF]: true, name: undefined, default: nameOrOpts?.default };
}

function isEnvRef(value: unknown): value is EnvRef {
	return typeof value === "object" && value !== null && ENV_REF in value;
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

// --- Manifest types ---

const ajv = new Ajv2020.default();
// biome-ignore lint/style/noNonNullAssertion: meta-schema is always available in Ajv2020
const validateJsonSchema = ajv.getSchema(
	"https://json-schema.org/draft/2020-12/schema",
)!;

const jsonSchemaValidator = z.custom<Record<string, unknown>>((val) =>
	validateJsonSchema(val),
);

const ManifestSchema = z.object({
	name: z.string(),
	module: z.string(),
	events: z.array(
		z.object({
			name: z.string(),
			schema: jsonSchemaValidator,
		}),
	),
	triggers: z.array(
		z.object({
			name: z.string(),
			type: z.string(),
			path: z.string(),
			method: z.string().default("POST"),
			params: z.array(z.string()),
			response: z
				.object({
					status: z.number().optional(),
					body: z.unknown().optional(),
				})
				.optional(),
		}),
	),
	actions: z.array(
		z.object({
			name: z.string(),
			export: z.string(),
			on: z.string(),
			emits: z.array(z.string()),
			env: z.record(z.string(), z.string()),
		}),
	),
});

type Manifest = z.infer<typeof ManifestSchema>;

// --- Compile output ---

interface CompiledAction {
	name: string | undefined;
	on: string;
	emits: string[];
	env: Record<string, string>;
	handler: (...args: unknown[]) => Promise<void>;
}

interface CompileOutput {
	name: string;
	events: Array<{ name: string; schema: object }>;
	triggers: TriggerConfig[];
	actions: CompiledAction[];
}

// --- Phase-typed builder ---

type AllEvents<T extends EventDefs, E extends EventDefs> = T & E;

interface ActionConfig<
	T extends EventDefs,
	E extends EventDefs,
	K extends keyof AllEvents<T, E> & string,
	Emits extends ReadonlyArray<keyof E & string>,
	WorkflowEnv extends string,
	ActionEnv extends Record<string, string | EnvRef>,
> {
	name?: string;
	on: K;
	emits?: Emits;
	env?: ActionEnv;
	handler: (
		ctx: ActionContext<
			z.infer<AllEvents<T, E>[K]>,
			Pick<EventPayloads<E>, Emits[number] & string>,
			WorkflowEnv | (keyof ActionEnv & string)
		>,
	) => Promise<void>;
}

type ActionReturn<
	T extends EventDefs,
	E extends EventDefs,
	K extends keyof AllEvents<T, E> & string,
	Emits extends ReadonlyArray<keyof E & string>,
	WorkflowEnv extends string,
	ActionEnv extends Record<string, string | EnvRef>,
> = (
	ctx: ActionContext<
		z.infer<AllEvents<T, E>[K]>,
		Pick<EventPayloads<E>, Emits[number] & string>,
		WorkflowEnv | (keyof ActionEnv & string)
	>,
) => Promise<void>;

interface TriggerPhase<
	// biome-ignore lint/complexity/noBannedTypes: empty initial state for accumulated event defs
	T extends EventDefs = {},
	WorkflowEnv extends string = never,
> {
	trigger<Name extends string, S extends z.ZodType>(
		name: Name extends keyof T ? never : Name,
		config: TriggerDef<S>,
	): TriggerPhase<T & Record<Name, S>, WorkflowEnv>;

	event<Name extends string, S extends z.ZodType>(
		name: Name extends keyof T ? never : Name,
		schema: S,
	): EventPhase<T, Record<Name, S>, WorkflowEnv>;

	env<V extends Record<string, string | EnvRef>>(
		config: V,
	): TriggerPhase<T, WorkflowEnv | (keyof V & string)>;

	action<
		K extends keyof T & string,
		const Emits extends readonly never[] = readonly [],
		ActionEnv extends Record<string, string | EnvRef> = Record<never, never>,
	>(
		// biome-ignore lint/complexity/noBannedTypes: no action events defined yet in TriggerPhase
		config: ActionConfig<T, {}, K, Emits, WorkflowEnv, ActionEnv>,
		// biome-ignore lint/complexity/noBannedTypes: no action events defined yet in TriggerPhase
	): ActionReturn<T, {}, K, Emits, WorkflowEnv, ActionEnv>;

	compile(): CompileOutput;
}

interface EventPhase<
	T extends EventDefs,
	E extends EventDefs,
	WorkflowEnv extends string = never,
> {
	event<Name extends string, S extends z.ZodType>(
		name: Name extends keyof T | keyof E ? never : Name,
		schema: S,
	): EventPhase<T, E & Record<Name, S>, WorkflowEnv>;

	env<V extends Record<string, string | EnvRef>>(
		config: V,
	): EventPhase<T, E, WorkflowEnv | (keyof V & string)>;

	action<
		K extends keyof AllEvents<T, E> & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		ActionEnv extends Record<string, string | EnvRef> = Record<never, never>,
	>(
		config: ActionConfig<T, E, K, Emits, WorkflowEnv, ActionEnv>,
	): ActionReturn<T, E, K, Emits, WorkflowEnv, ActionEnv>;

	compile(): CompileOutput;
}

interface ActionPhase<
	T extends EventDefs,
	E extends EventDefs,
	WorkflowEnv extends string = never,
> {
	action<
		K extends keyof AllEvents<T, E> & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		ActionEnv extends Record<string, string | EnvRef> = Record<never, never>,
	>(
		config: ActionConfig<T, E, K, Emits, WorkflowEnv, ActionEnv>,
	): ActionReturn<T, E, K, Emits, WorkflowEnv, ActionEnv>;

	compile(): CompileOutput;
}

// --- WorkflowBuilderImpl ---

class WorkflowBuilderImpl {
	readonly #name: string;
	readonly #events: Record<string, z.ZodType> = {};
	readonly #triggers: TriggerConfig[] = [];
	readonly #workflowEnv: Record<string, string> = {};
	readonly #envSource: Record<string, string | undefined>;
	readonly #actions: Array<{
		name: string | undefined;
		on: string;
		emits: string[];
		env: Record<string, string>;
		handler: (...args: unknown[]) => Promise<void>;
	}> = [];

	constructor(name: string, envSource: Record<string, string | undefined>) {
		this.#name = name;
		this.#envSource = envSource;
	}

	event(name: string, schema: z.ZodType): this {
		this.#events[name] = schema;
		return this;
	}

	env(config: Record<string, string | EnvRef>): this {
		Object.assign(this.#workflowEnv, resolveEnvRecord(config, this.#envSource));
		return this;
	}

	trigger(name: string, def: TriggerDef): this {
		this.#events[name] = def.schema;
		this.#triggers.push({
			name,
			type: def.type,
			path: def.path,
			method: def.method,
			params: extractParamNames(def.path),
			response: def.response,
		});
		return this;
	}

	action(config: {
		name?: string;
		on: string;
		emits?: readonly string[];
		env?: Record<string, string | EnvRef>;
		handler: (...args: unknown[]) => Promise<void>;
	}): (...args: unknown[]) => Promise<void> {
		// The real SDK is used at authoring time (type checking, IDE completion)
		// and at manifest-build time (compile()). The ctx.emit runtime shim lives
		// in vite-plugin/src/sdk-stub.js, which replaces this module when the
		// action is bundled for sandbox execution. Keeping the runtime wrapping
		// in a single place avoids the two copies drifting. vite-plugin maps
		// named exports to actions via reference equality (fn === action.handler),
		// which still holds here because we register and return the same handler.
		this.#actions.push({
			name: config.name,
			on: config.on,
			emits: config.emits ? [...config.emits] : [],
			env: config.env ? resolveEnvRecord(config.env, this.#envSource) : {},
			handler: config.handler,
		});
		return config.handler;
	}

	compile(): CompileOutput {
		const events = Object.entries(this.#events).map(([name, schema]) => ({
			name,
			schema: z.toJSONSchema(schema, {}) as object,
		}));

		return {
			name: this.#name,
			events,
			triggers: [...this.#triggers],
			actions: this.#actions.map((a) => ({
				name: a.name,
				on: a.on,
				emits: [...a.emits],
				env: { ...this.#workflowEnv, ...a.env },
				handler: a.handler,
			})),
		};
	}
}

// --- Factory ---

function getDefaultEnvSource(): Record<string, string | undefined> {
	const g = globalThis as Record<string, unknown>;
	return (
		(g.process as { env: Record<string, string | undefined> } | undefined)
			?.env ?? {}
	);
}

function createWorkflow(
	name: string,
	envSource?: Record<string, string | undefined>,
	// biome-ignore lint/complexity/noBannedTypes: empty initial state for accumulated event defs
): TriggerPhase<{}, never> {
	return new WorkflowBuilderImpl(
		name,
		envSource ?? getDefaultEnvSource(),
		// biome-ignore lint/complexity/noBannedTypes: empty initial state for accumulated event defs
	) as unknown as TriggerPhase<{}, never>;
}

export type {
	ActionContext,
	ActionPhase,
	CompiledAction,
	CompileOutput,
	EnvRef,
	Event,
	EventPhase,
	ExtractParams,
	Manifest,
	TriggerConfig,
	TriggerDef,
	TriggerPhase,
};
export {
	createWorkflow,
	ENV_REF,
	env,
	extractParamNames,
	http,
	ManifestSchema,
	z,
};
