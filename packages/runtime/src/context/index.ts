import type { EventBus, RuntimeEvent } from "../event-bus/index.js";
import type { Logger } from "../logger.js";
import type { HttpTriggerResolved } from "../triggers/http.js";
import { PayloadValidationError } from "./errors.js";

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

interface Schema {
	parse(data: unknown): unknown;
}

class ContextFactory {
	readonly #bus: EventBus;
	readonly #schemas: Record<string, Schema>;
	readonly #fetch: typeof globalThis.fetch;
	readonly #env: Record<string, string | undefined>;
	readonly #logger: Logger;

	// biome-ignore lint/complexity/useMaxParams: internal constructor, all params are required dependencies
	constructor(bus: EventBus, schemas: Record<string, Schema>, fetch: typeof globalThis.fetch, env: Record<string, string | undefined>, logger: Logger) {
		this.#bus = bus;
		this.#schemas = schemas;
		this.#fetch = fetch;
		this.#env = env;
		this.#logger = logger;
	}

	httpTrigger = (
		body: unknown,
		definition: HttpTriggerResolved,
	): HttpTriggerContext => {
		const correlationId = `corr_${crypto.randomUUID()}`;
		return new HttpTriggerContext(
			body,
			definition,
			(type, payload, options) => {
				const targetAction = options?.targetAction;
				return this.#createAndEmit(type, payload, correlationId, {
					...(targetAction !== undefined && { targetAction }),
				});
			},
		);
	};

	action = (event: RuntimeEvent): ActionContext =>
		new ActionContext(event, (type, payload, options) => {
			const targetAction = options?.targetAction;
			return this.#createAndEmit(type, payload, event.correlationId, {
				parentEventId: event.id,
				...(targetAction !== undefined && { targetAction }),
			});
		}, this.#fetch, this.#env, this.#logger);

	#validate(type: string, payload: unknown): unknown {
		const schema = this.#schemas[type];
		if (!schema) {
			throw new PayloadValidationError(type, []);
		}
		try {
			return schema.parse(payload);
		} catch (error) {
			const issues =
				error instanceof Error && "issues" in error && Array.isArray((error as { issues: unknown[] }).issues)
					? (error as { issues: { path: (string | number)[]; message: string }[] }).issues.map(
							(issue) => ({
								path: issue.path.join("."),
								message: issue.message,
							}),
						)
					: [];
			throw new PayloadValidationError(type, issues, error instanceof Error ? error : undefined);
		}
	}

	async #createAndEmit(
		type: string,
		payload: unknown,
		correlationId: string,
		lineage: { targetAction?: string; parentEventId?: string },
	): Promise<void> {
		const parsed = this.#validate(type, payload);
		const event: RuntimeEvent = {
			id: `evt_${crypto.randomUUID()}`,
			type,
			payload: parsed,
			correlationId,
			createdAt: new Date(),
			state: "pending",
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
		return await this.#bus.emit(event);
	}
}

export type { Context };
export { ActionContext, ContextFactory, HttpTriggerContext };
