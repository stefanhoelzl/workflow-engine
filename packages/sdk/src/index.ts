// biome-ignore lint/style/noExportedImports: z is re-exported for workflow authors alongside locally defined exports
import { z } from "zod";

// --- Event types ---

type EventDefs = Record<string, z.ZodType>;

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

// --- Action context ---

interface EventDefinition<Payload> {
	name: string;
	payload: Payload;
}

interface ActionContext<
	Payload = unknown,
	Emits extends string = never,
	Env extends string = never,
> {
	event: EventDefinition<Payload>;
	emit: [Emits] extends [never]
		? never
		: (type: Emits, payload: unknown) => Promise<void>;
	env: [Env] extends [never] ? never : Record<Env, string | undefined>;
	fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

// --- Action types ---

type ActionInput<E extends EventDefs, EventKey extends string> = {
	[K in keyof E & EventKey]: {
		on: K;
		emits?: ReadonlyArray<keyof E & EventKey>;
		env?: readonly string[];
		handler: (
			ctx: ActionContext<z.infer<E[K]>, never, string>,
		) => Promise<void>;
	};
}[keyof E & EventKey];

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
		event: EventDefinition<unknown>;
		emit: (type: string, payload: unknown) => Promise<void>;
		env: Record<string, string | undefined>;
		fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
	}) => Promise<void>;
}

interface WorkflowConfig {
	events: Record<string, z.ZodType>;
	triggers: TriggerInput<string>[];
	actions: ActionConfig[];
}

// --- defineWorkflow ---

function defineWorkflow<E extends EventDefs>(config: {
	events: E;
	triggers: Record<string, TriggerInput<keyof E & string>>;
	actions: Record<string, ActionInput<E, keyof E & string>>;
}): WorkflowConfig {
	const triggers = Object.values(config.triggers);

	const actions = Object.entries(config.actions).map(([name, action]) => {
		const eventName = action.on as string;
		return {
			name,
			// biome-ignore lint/style/noNonNullAssertion: type system guarantees action.on is a valid key in config.events
			on: { name: eventName, schema: config.events[eventName]! },
			emits: action.emits ? [...action.emits] : [],
			env: action.env ? [...action.env] : [],
			handler: action.handler as WorkflowConfig["actions"][number]["handler"],
		};
	});

	return {
		events: config.events,
		triggers,
		actions,
	};
}

export { z, defineWorkflow };
export type { WorkflowConfig };
