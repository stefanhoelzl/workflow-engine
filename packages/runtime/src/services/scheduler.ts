import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { Event, EventQueue } from "../event-queue/index.js";
import type { Logger } from "../logger.js";
import type { Service } from "./index.js";

type ActionContextFactory = (event: Event) => ActionContext;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled lifecycle logic
function createScheduler(
	queue: EventQueue,
	actions: Action[],
	createContext: ActionContextFactory,
	logger: Logger,
): Service {
	let running = false;
	let loopPromise: Promise<void> | null = null;
	const ac = new AbortController();

	async function loop(): Promise<void> {
		while (running) {
			let event: Event;
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sequential event processing by design
				event = await queue.dequeue(ac.signal);
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					break;
				}
				throw e;
			}
			await processEvent(event);
		}
	}

	async function processEvent(event: Event): Promise<void> {
		const matches = actions.filter((a) => a.match(event));

		if (matches.length > 1) {
			logger.error("event.ambiguous-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				actions: matches.map((a) => a.name),
			});
			await queue.fail(event.id);
			return;
		}

		const action = matches.find(() => true);
		if (!action) {
			logger.warn("event.no-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
			});
			await queue.ack(event.id);
			return;
		}

		await executeAction(event, action);
	}

	async function executeAction(event: Event, action: Action): Promise<void> {
		logger.info("action.started", {
			correlationId: event.correlationId,
			eventId: event.id,
			action: action.name,
		});
		const start = performance.now();
		try {
			const ctx = createContext(event);
			await action.handler(ctx);
			const durationMs = Math.round(performance.now() - start);
			logger.info("action.completed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				durationMs,
			});
			await queue.ack(event.id);
		} catch (error) {
			const durationMs = Math.round(performance.now() - start);
			logger.error("action.failed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});
			await queue.fail(event.id);
		}
	}

	return {
		start(): Promise<void> {
			if (running) {
				return loopPromise ?? Promise.resolve();
			}
			running = true;
			loopPromise = loop();
			return loopPromise;
		},
		async stop(): Promise<void> {
			running = false;
			ac.abort();
			await loopPromise;
		},
	};
}

export { createScheduler };
