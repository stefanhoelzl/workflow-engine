import type { Event, EventQueue } from "../event-queue/index.js";
import type { HttpTriggerDefinition } from "../triggers/http.js";

interface EmitOptions {
	targetAction?: string;
}

interface Context {
	emit(type: string, payload: unknown, options?: EmitOptions): Promise<void>;
}

class HttpTriggerContext implements Context {
	readonly request: { body: unknown };
	readonly definition: HttpTriggerDefinition;
	readonly #emit: (
		type: string,
		payload: unknown,
		options?: EmitOptions,
	) => Promise<void>;

	constructor(
		body: unknown,
		definition: HttpTriggerDefinition,
		emit: (
			type: string,
			payload: unknown,
			options?: EmitOptions,
		) => Promise<void>,
	) {
		this.request = { body };
		this.definition = definition;
		this.#emit = emit;
	}

	emit(type: string, payload: unknown, options?: EmitOptions): Promise<void> {
		return this.#emit(type, payload, options);
	}
}

class ActionContext implements Context {
	readonly event: Event;
	readonly env: Record<string, string | undefined>;
	readonly #emit: (
		type: string,
		payload: unknown,
		options?: EmitOptions,
	) => Promise<void>;
	readonly #fetch: typeof globalThis.fetch;

	constructor(
		event: Event,
		emit: (
			type: string,
			payload: unknown,
			options?: EmitOptions,
		) => Promise<void>,
		fetch: typeof globalThis.fetch,
		env: Record<string, string | undefined>,
	) {
		this.event = event;
		this.#emit = emit;
		this.#fetch = fetch;
		this.env = env;
	}

	emit(type: string, payload: unknown, options?: EmitOptions): Promise<void> {
		return this.#emit(type, payload, options);
	}

	fetch(
		url: string | URL,
		init?: RequestInit,
	): Promise<Response> {
		return this.#fetch(url, init);
	}
}

class ContextFactory {
	readonly #queue: EventQueue;
	readonly #fetch: typeof globalThis.fetch;
	readonly #env: Record<string, string | undefined>;

	constructor(queue: EventQueue, fetch: typeof globalThis.fetch, env: Record<string, string | undefined>) {
		this.#queue = queue;
		this.#fetch = fetch;
		this.#env = env;
	}

	httpTrigger = (
		body: unknown,
		definition: HttpTriggerDefinition,
	): HttpTriggerContext => {
		const correlationId = `corr_${crypto.randomUUID()}`;
		return new HttpTriggerContext(
			body,
			definition,
			(type, payload, options) => {
				const targetAction = options?.targetAction;
				return this.#createAndEnqueue(type, payload, correlationId, {
					...(targetAction !== undefined && { targetAction }),
				});
			},
		);
	};

	action = (event: Event): ActionContext =>
		new ActionContext(event, (type, payload, options) => {
			const targetAction = options?.targetAction;
			return this.#createAndEnqueue(type, payload, event.correlationId, {
				parentEventId: event.id,
				...(targetAction !== undefined && { targetAction }),
			});
		}, this.#fetch, this.#env);

	#createAndEnqueue(
		type: string,
		payload: unknown,
		correlationId: string,
		lineage: { targetAction?: string; parentEventId?: string },
	): Promise<void> {
		const event: Event = {
			id: `evt_${crypto.randomUUID()}`,
			type,
			payload,
			correlationId,
			createdAt: new Date(),
		};
		if (lineage.parentEventId !== undefined) {
			event.parentEventId = lineage.parentEventId;
		}
		if (lineage.targetAction !== undefined) {
			event.targetAction = lineage.targetAction;
		}
		return this.#queue.enqueue(event);
	}
}

export type { Context };
export { ActionContext, ContextFactory, HttpTriggerContext };
