import Ajv2020 from "ajv/dist/2020.js";
// biome-ignore lint/style/noExportedImports: z is re-exported for workflow authors alongside locally defined exports
import { z } from "zod";

// --- Event types ---

type EventDefs = Record<string, z.ZodType>;

interface Event<Payload = unknown> {
	name: string;
	payload: Payload;
}

// --- Trigger types ---

interface TriggerDef<S extends z.ZodType = z.ZodType> {
	type: string;
	schema: S;
	path: string;
	method?: string | undefined;
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
	method?: string | undefined;
	response?:
		| {
				status?: number | undefined;
				body?: unknown;
		  }
		| undefined;
}

interface HttpTriggerInput<B extends z.ZodType = z.ZodType> {
	path: string;
	method?: string;
	body?: B;
	response?: {
		status?: number;
		body?: unknown;
	};
}

type HttpPayloadSchema<B extends z.ZodType> = z.ZodObject<{
	body: B;
	headers: z.ZodRecord<z.ZodString, z.ZodString>;
	url: z.ZodString;
	method: z.ZodString;
}>;

function http<B extends z.ZodType = z.ZodUnknown>(
	config: HttpTriggerInput<B>,
): TriggerDef<HttpPayloadSchema<B extends undefined ? z.ZodUnknown : B>> {
	const bodySchema = (config.body ?? z.unknown()) as B extends undefined
		? z.ZodUnknown
		: B;
	const schema = z.object({
		body: bodySchema,
		headers: z.record(z.string(), z.string()),
		url: z.string(),
		method: z.string(),
	});
	return {
		type: "http",
		schema: schema as HttpPayloadSchema<B extends undefined ? z.ZodUnknown : B>,
		path: config.path,
		method: config.method,
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
	emit: <K extends keyof Events & string>(
		type: K,
		payload: Events[K],
	) => Promise<void>;
	env: Readonly<Record<Env, string>>;
	fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
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
			method: z.string().optional(),
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
			module: z.string(),
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
	Manifest,
	TriggerConfig,
	TriggerDef,
	TriggerPhase,
};
export { createWorkflow, ENV_REF, env, http, ManifestSchema, z };
