import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { EventBus, RuntimeEvent } from "../event-bus/index.js";
import type { WorkQueue } from "../event-bus/work-queue.js";
import type { Logger } from "../logger.js";
import type { Service } from "./index.js";

type ActionContextFactory = (event: RuntimeEvent) => ActionContext;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled lifecycle logic
// biome-ignore lint/complexity/useMaxParams: factory requires all dependencies
function createScheduler(
	workQueue: WorkQueue,
	bus: EventBus,
	actions: Action[],
	createContext: ActionContextFactory,
	logger: Logger,
): Service {
	let running = false;
	let loopPromise: Promise<void> | null = null;
	const ac = new AbortController();

	async function loop(): Promise<void> {
		while (running) {
			let event: RuntimeEvent;
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sequential event processing by design
				event = await workQueue.dequeue(ac.signal);
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					break;
				}
				throw e;
			}
			await processEvent(event);
		}
	}

	async function processEvent(event: RuntimeEvent): Promise<void> {
		await bus.emit({ ...event, state: "processing" });

		const matches = actions.filter((a) => a.match(event));

		if (matches.length > 1) {
			logger.error("event.ambiguous-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				actions: matches.map((a) => a.name),
			});
			await bus.emit({ ...event, state: "failed", error: "ambiguous match" });
			return;
		}

		const action = matches.find(() => true);
		if (!action) {
			logger.warn("event.no-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
			});
			await bus.emit({ ...event, state: "skipped" });
			return;
		}

		await executeAction(event, action);
	}

	async function executeAction(event: RuntimeEvent, action: Action): Promise<void> {
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
			await bus.emit({ ...event, state: "done" });
		} catch (error) {
			const durationMs = Math.round(performance.now() - start);
			logger.error("action.failed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});
			await bus.emit({
				...event,
				state: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
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
