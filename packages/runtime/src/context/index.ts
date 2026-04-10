import type { RuntimeEvent } from "../event-bus/index.js";
import type { EventSource } from "../event-source.js";
import type { Logger } from "../logger.js";

class ActionContext {
	readonly event: RuntimeEvent;
	readonly env: Record<string, string>;
	readonly #emit: (type: string, payload: unknown) => Promise<void>;
	readonly #fetch: typeof globalThis.fetch;
	readonly #logger: Logger;

	// biome-ignore lint/complexity/useMaxParams: internal constructor, all params are required dependencies
	constructor(
		event: RuntimeEvent,
		emit: (type: string, payload: unknown) => Promise<void>,
		fetch: typeof globalThis.fetch,
		env: Record<string, string>,
		logger: Logger,
	) {
		this.event = event;
		this.#emit = emit;
		this.#fetch = fetch;
		this.env = env;
		this.#logger = logger;
	}

	emit(type: string, payload: unknown): Promise<void> {
		return this.#emit(type, payload);
	}

	async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
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

function createActionContext(
	source: EventSource,
	fetch: typeof globalThis.fetch,
	logger: Logger,
): (
	event: RuntimeEvent,
	actionName: string,
	env: Record<string, string>,
) => ActionContext {
	return (event, actionName, env) =>
		new ActionContext(
			event,
			async (type, payload) => {
				await source.derive(event, type, payload, actionName);
			},
			fetch,
			env,
			logger,
		);
}

export { ActionContext, createActionContext };
