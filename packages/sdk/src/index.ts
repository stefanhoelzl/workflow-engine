// biome-ignore lint/style/noExportedImports: z is re-exported for workflow authors alongside locally defined exports
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";

// --- Event types ---

type EventDefs = Record<string, z.ZodType>;

interface Event<Payload = unknown> {
	name: string;
	payload: Payload;
}

// --- Trigger types ---

interface HttpTriggerInput<E extends string> {
	type: "http";
	path: string;
	method?: string;
	event: E;
	response?: {
		status?: number;
		body?: unknown;
	};
}

type TriggerInput<E extends string> = HttpTriggerInput<E>;

type TriggerConfig = TriggerInput<string> & { name: string };

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

function env(nameOrOpts?: string | { default: string }, opts?: { default: string }): EnvRef {
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
			event: z.string(),
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
			handler: z.string(),
			on: z.string(),
			emits: z.array(z.string()),
			env: z.record(z.string(), z.string()),
		}),
	),
	module: z.string(),
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
	events: Array<{ name: string; schema: object }>;
	triggers: TriggerConfig[];
	actions: CompiledAction[];
}

// --- WorkflowBuilder (single-phase) ---

interface WorkflowBuilder<E extends EventDefs, WorkflowEnv extends string = never> {
	event<Name extends string, S extends z.ZodType>(
		name: Name,
		schema: S,
	): WorkflowBuilder<E & Record<Name, S>, WorkflowEnv>;

	env<V extends Record<string, string | EnvRef>>(
		config: V,
	): WorkflowBuilder<E, WorkflowEnv | (keyof V & string)>;

	trigger(
		name: string,
		config: TriggerInput<keyof E & string>,
	): WorkflowBuilder<E, WorkflowEnv>;

	action<
		K extends keyof E & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		ActionEnv extends Record<string, string | EnvRef> = Record<never, never>,
	>(config: {
		name?: string;
		on: K;
		emits?: Emits;
		env?: ActionEnv;
		handler: (
			ctx: ActionContext<
				z.infer<E[K]>,
				Pick<EventPayloads<E>, Emits[number] & string>,
				WorkflowEnv | (keyof ActionEnv & string)
			>,
		) => Promise<void>;
	}): (
		ctx: ActionContext<
			z.infer<E[K]>,
			Pick<EventPayloads<E>, Emits[number] & string>,
			WorkflowEnv | (keyof ActionEnv & string)
		>,
	) => Promise<void>;

	compile(): CompileOutput;
}

// --- WorkflowBuilderImpl ---

class WorkflowBuilderImpl {
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

	constructor(envSource: Record<string, string | undefined>) {
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

	trigger(name: string, input: TriggerInput<string>): this {
		this.#triggers.push({ ...input, name });
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
	return (g.process as { env: Record<string, string | undefined> } | undefined)?.env ?? {};
}

// biome-ignore lint/complexity/noBannedTypes: empty object is the correct initial state for accumulated event defs
function createWorkflow(envSource?: Record<string, string | undefined>): WorkflowBuilder<{}, never> {
	// biome-ignore lint/complexity/noBannedTypes: empty object is the correct initial state for accumulated event defs
	return new WorkflowBuilderImpl(envSource ?? getDefaultEnvSource()) as unknown as WorkflowBuilder<{}, never>;
}

export { z, createWorkflow, env, ENV_REF, ManifestSchema };
export type { Event, EnvRef, Manifest, CompileOutput, CompiledAction, TriggerConfig, WorkflowBuilder, ActionContext };
