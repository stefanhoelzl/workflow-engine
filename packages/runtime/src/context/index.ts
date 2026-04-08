import type { EventBus, RuntimeEvent } from "../event-bus/index.js";
import type { EventFactory } from "../event-factory.js";
import type { Logger } from "../logger.js";
import type { HttpTriggerResolved } from "../triggers/http.js";

interface EmitOptions {
	targetAction?: string;
}

interface Context {
	emit(type: string, payload: unknown, options?: EmitOptions): Promise<void>;
}

class HttpTriggerContext implements Context {
	readonly request: { body: unknown };
	readonly definition: HttpTriggerResolved;
	readonly #emit: (
		type: string,
		payload: unknown,
		options?: EmitOptions,
	) => Promise<void>;

	constructor(
		body: unknown,
		definition: HttpTriggerResolved,
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
	readonly event: RuntimeEvent;
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
		event: RuntimeEvent,
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
	readonly #bus: EventBus;
	readonly #eventFactory: EventFactory;
	readonly #fetch: typeof globalThis.fetch;
	readonly #env: Record<string, string | undefined>;
	readonly #logger: Logger;

	// biome-ignore lint/complexity/useMaxParams: internal constructor, all params are required dependencies
	constructor(bus: EventBus, eventFactory: EventFactory, fetch: typeof globalThis.fetch, env: Record<string, string | undefined>, logger: Logger) {
		this.#bus = bus;
		this.#eventFactory = eventFactory;
		this.#fetch = fetch;
		this.#env = env;
		this.#logger = logger;
	}

	httpTrigger = (
		body: unknown,
		definition: HttpTriggerResolved,
	): HttpTriggerContext => new HttpTriggerContext(
			body,
			definition,
			async (type, payload, options) => {
				const event = this.#eventFactory.create(type, payload);
				if (options?.targetAction !== undefined) {
					event.targetAction = options.targetAction;
				}
				this.#logEmit(event, payload);
				await this.#bus.emit(event);
			},
		);

	action = (event: RuntimeEvent): ActionContext =>
		new ActionContext(event, async (type, payload, options) => {
			const derived = this.#eventFactory.derive(event, type, payload);
			if (options?.targetAction !== undefined) {
				derived.targetAction = options.targetAction;
			}
			this.#logEmit(derived, payload);
			await this.#bus.emit(derived);
		}, this.#fetch, this.#env, this.#logger);

	#logEmit(event: RuntimeEvent, payload: unknown): void {
		const logData: Record<string, unknown> = {
			correlationId: event.correlationId,
			eventId: event.id,
			type: event.type,
		};
		if (event.parentEventId !== undefined) {
			logData.parentEventId = event.parentEventId;
		}
		if (event.targetAction !== undefined) {
			logData.targetAction = event.targetAction;
		}
		this.#logger.info("event.emitted", logData);
		this.#logger.trace("event.emitted.payload", { correlationId: event.correlationId, payload });
	}
}

export type { Context };
export { ActionContext, ContextFactory, HttpTriggerContext };
