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
			env: z.array(z.string()),
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
	env: string[];
	handler: (...args: unknown[]) => Promise<void>;
}

interface CompileOutput {
	events: Array<{ name: string; schema: object }>;
	triggers: TriggerConfig[];
	actions: CompiledAction[];
}

// --- WorkflowBuilder (single-phase) ---

interface WorkflowBuilder<E extends EventDefs> {
	event<Name extends string, S extends z.ZodType>(
		name: Name,
		schema: S,
	): WorkflowBuilder<E & Record<Name, S>>;

	trigger(
		name: string,
		config: TriggerInput<keyof E & string>,
	): WorkflowBuilder<E>;

	action<
		K extends keyof E & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		const Env extends readonly string[] = readonly [],
	>(config: {
		name?: string;
		on: K;
		emits?: Emits;
		env?: Env;
		handler: (
			ctx: ActionContext<
				z.infer<E[K]>,
				Pick<EventPayloads<E>, Emits[number] & string>,
				Env[number]
			>,
		) => Promise<void>;
	}): (
		ctx: ActionContext<
			z.infer<E[K]>,
			Pick<EventPayloads<E>, Emits[number] & string>,
			Env[number]
		>,
	) => Promise<void>;

	compile(): CompileOutput;
}

// --- WorkflowBuilderImpl ---

class WorkflowBuilderImpl {
	readonly #events: Record<string, z.ZodType> = {};
	readonly #triggers: TriggerConfig[] = [];
	readonly #actions: Array<{
		name: string | undefined;
		on: string;
		emits: string[];
		env: string[];
		handler: (...args: unknown[]) => Promise<void>;
	}> = [];

	event(name: string, schema: z.ZodType): this {
		this.#events[name] = schema;
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
		env?: readonly string[];
		handler: (...args: unknown[]) => Promise<void>;
	}): (...args: unknown[]) => Promise<void> {
		this.#actions.push({
			name: config.name,
			on: config.on,
			emits: config.emits ? [...config.emits] : [],
			env: config.env ? [...config.env] : [],
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
				env: [...a.env],
				handler: a.handler,
			})),
		};
	}
}

// --- Factory ---

// biome-ignore lint/complexity/noBannedTypes: empty object is the correct initial state for accumulated event defs
function createWorkflow(): WorkflowBuilder<{}> {
	// biome-ignore lint/complexity/noBannedTypes: empty object is the correct initial state for accumulated event defs
	return new WorkflowBuilderImpl() as unknown as WorkflowBuilder<{}>;
}

export { z, createWorkflow, ManifestSchema };
export type { Event, Manifest, CompileOutput, CompiledAction, TriggerConfig, WorkflowBuilder, ActionContext };
