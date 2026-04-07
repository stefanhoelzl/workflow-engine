import type { Event, EventQueue } from "../event-queue/index.js";
import type { Logger } from "../logger.js";
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
	readonly #logger: Logger;

	// biome-ignore lint/complexity/useMaxParams: internal constructor, all params are required dependencies
	constructor(
		event: Event,
		emit: (
			type: string,
			payload: unknown,
			options?: EmitOptions,
		) => Promise<void>,
		fetch: typeof globalThis.fetch,
		env: Record<string, string | undefined>,
		logger: Logger,
	) {
		this.event = event;
		this.#emit = emit;
		this.#fetch = fetch;
		this.env = env;
		this.#logger = logger;
	}

	emit(type: string, payload: unknown, options?: EmitOptions): Promise<void> {
		return this.#emit(type, payload, options);
	}

	async fetch(
		url: string | URL,
		init?: RequestInit,
	): Promise<Response> {
		const method = init?.method ?? "GET";
		this.#logger.info("fetch.start", {
			correlationId: this.event.correlationId,
			url: url.toString(),
			method,
		});
		if (init?.body) {
			this.#logger.trace("fetch.request.body", {
				correlationId: this.event.correlationId,
				body: init.body,
			});
		}
		const start = performance.now();
		try {
			const response = await this.#fetch(url, init);
			const durationMs = Math.round(performance.now() - start);
			this.#logger.info("fetch.completed", {
				correlationId: this.event.correlationId,
				url: url.toString(),
				method,
				status: response.status,
				durationMs,
			});
			return response;
		} catch (error) {
			const durationMs = Math.round(performance.now() - start);
			this.#logger.error("fetch.failed", {
				correlationId: this.event.correlationId,
				url: url.toString(),
				method,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});
			throw error;
		}
	}
}

class ContextFactory {
	readonly #queue: EventQueue;
	readonly #fetch: typeof globalThis.fetch;
	readonly #env: Record<string, string | undefined>;
	readonly #logger: Logger;

	constructor(queue: EventQueue, fetch: typeof globalThis.fetch, env: Record<string, string | undefined>, logger: Logger) {
		this.#queue = queue;
		this.#fetch = fetch;
		this.#env = env;
		this.#logger = logger;
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
		}, this.#fetch, this.#env, this.#logger);

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
		const logData: Record<string, unknown> = {
			correlationId,
			eventId: event.id,
			type,
		};
		if (event.parentEventId !== undefined) {
			logData.parentEventId = event.parentEventId;
		}
		if (event.targetAction !== undefined) {
			logData.targetAction = event.targetAction;
		}
		this.#logger.info("event.emitted", logData);
		this.#logger.trace("event.emitted.payload", { correlationId, payload });
		return this.#queue.enqueue(event);
	}
}

export type { Context };
export { ActionContext, ContextFactory, HttpTriggerContext };
