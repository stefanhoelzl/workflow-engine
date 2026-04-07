import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { Event, EventQueue } from "../event-queue/index.js";
import type { Logger } from "../logger.js";

type ActionContextFactory = (event: Event) => ActionContext;

class Scheduler {
	readonly #queue: EventQueue;
	readonly #actions: Action[];
	readonly #createContext: ActionContextFactory;
	readonly #logger: Logger;
	#running = false;
	#loopPromise: Promise<void> | null = null;

	constructor(
		queue: EventQueue,
		actions: Action[],
		createContext: ActionContextFactory,
		logger: Logger,
	) {
		this.#queue = queue;
		this.#actions = actions;
		this.#createContext = createContext;
		this.#logger = logger;
	}

	start(): void {
		if (this.#running) {
			return;
		}
		this.#running = true;
		this.#loopPromise = this.#loop();
	}

	stop(): void {
		this.#running = false;
	}

	get stopped(): Promise<void> {
		return this.#loopPromise ?? Promise.resolve();
	}

	async #loop(): Promise<void> {
		while (this.#running) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential event processing by design
			const event = await this.#queue.dequeue();
			if (!this.#running) {
				await this.#queue.ack(event.id);
				break;
			}
			await this.#processEvent(event);
		}
	}

	async #processEvent(event: Event): Promise<void> {
		const matches = this.#actions.filter((a) => a.match(event));

		if (matches.length > 1) {
			this.#logger.error("event.ambiguous-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				actions: matches.map((a) => a.name),
			});
			await this.#queue.fail(event.id);
			return;
		}

		const action = matches.find(() => true);
		if (!action) {
			this.#logger.warn("event.no-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
			});
			await this.#queue.ack(event.id);
			return;
		}

		await this.#executeAction(event, action);
	}

	async #executeAction(event: Event, action: Action): Promise<void> {
		this.#logger.info("action.started", {
			correlationId: event.correlationId,
			eventId: event.id,
			action: action.name,
		});
		const start = performance.now();
		try {
			const ctx = this.#createContext(event);
			await action.handler(ctx);
			const durationMs = Math.round(performance.now() - start);
			this.#logger.info("action.completed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				durationMs,
			});
			await this.#queue.ack(event.id);
		} catch (error) {
			const durationMs = Math.round(performance.now() - start);
			this.#logger.error("action.failed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});
			await this.#queue.fail(event.id);
		}
	}
}

export { Scheduler };
