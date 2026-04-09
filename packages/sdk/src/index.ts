// biome-ignore lint/style/noExportedImports: z is re-exported for workflow authors alongside locally defined exports
import { z } from "zod";

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

// --- Workflow config (output) ---

interface ActionConfig {
	name: string;
	on: {
		name: string;
		schema: z.ZodType;
	};
	emits: string[];
	env: string[];
	handler: (ctx: {
		event: Event;
		emit: (type: string, payload: unknown) => Promise<void>;
		env: Record<string, string | undefined>;
		fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
	}) => Promise<void>;
}

interface WorkflowConfig {
	events: Record<string, z.ZodType>;
	triggers: TriggerConfig[];
	actions: ActionConfig[];
}

// --- Phase interfaces ---

interface StartPhase {
	event<Name extends string, S extends z.ZodType>(
		name: Name,
		schema: S,
	): EventPhase<Record<Name, S>>;
}

interface EventPhase<E extends EventDefs> {
	event<Name extends string, S extends z.ZodType>(
		name: Name,
		schema: S,
	): EventPhase<E & Record<Name, S>>;

	trigger(
		name: string,
		config: TriggerInput<keyof E & string>,
	): TriggerPhase<E>;
}

interface TriggerPhase<E extends EventDefs> {
	trigger(
		name: string,
		config: TriggerInput<keyof E & string>,
	): TriggerPhase<E>;

	action<
		K extends keyof E & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		const Env extends readonly string[] = readonly [],
	>(
		name: string,
		config: {
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
		},
	): ActionPhase<E>;
}

interface ActionPhase<E extends EventDefs> {
	action<
		K extends keyof E & string,
		const Emits extends ReadonlyArray<keyof E & string> = readonly [],
		const Env extends readonly string[] = readonly [],
	>(
		name: string,
		config: {
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
		},
	): ActionPhase<E>;

	build(): WorkflowConfig;
}

// --- WorkflowBuilder ---

class WorkflowBuilder {
	readonly #events: Record<string, z.ZodType> = {};
	readonly #triggers: TriggerConfig[] = [];
	readonly #actions: ActionConfig[] = [];

	event(name: string, schema: z.ZodType): this {
		this.#events[name] = schema;
		return this;
	}

	trigger(name: string, input: TriggerInput<string>): this {
		this.#triggers.push({ ...input, name });
		return this;
	}

	action(
		name: string,
		config: {
			on: string;
			emits?: readonly string[];
			env?: readonly string[];
			handler: (ctx: {
				event: Event;
				emit: (type: string, payload: unknown) => Promise<void>;
				env: Record<string, string | undefined>;
				fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
			}) => Promise<void>;
		},
	): this {
		const eventName = config.on;
		this.#actions.push({
			name,
			// biome-ignore lint/style/noNonNullAssertion: type system guarantees config.on is a valid key in events
			on: { name: eventName, schema: this.#events[eventName]! },
			emits: config.emits ? [...config.emits] : [],
			env: config.env ? [...config.env] : [],
			handler: config.handler as ActionConfig["handler"],
		});
		return this;
	}

	build(): WorkflowConfig {
		return {
			events: { ...this.#events },
			triggers: [...this.#triggers],
			actions: [...this.#actions],
		};
	}
}

// --- Factory ---

function workflow(): StartPhase {
	return new WorkflowBuilder() as unknown as StartPhase;
}

export { z, workflow };
export type { Event, WorkflowConfig };
