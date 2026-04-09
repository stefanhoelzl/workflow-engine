import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { EventBus, RuntimeEvent } from "../event-bus/index.js";
import type { WorkQueue } from "../event-bus/work-queue.js";
import type { EventFactory } from "../event-factory.js";
import type { Logger } from "../logger.js";
import type { Service } from "./index.js";

type ActionContextFactory = (event: RuntimeEvent, actionName: string) => ActionContext;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled lifecycle logic
// biome-ignore lint/complexity/useMaxParams: factory requires all dependencies
function createScheduler(
	workQueue: WorkQueue,
	bus: EventBus,
	actions: Action[],
	eventFactory: EventFactory,
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

		if (event.targetAction === undefined) {
			await fanOut(event);
			return;
		}

		const action = actions.find(
			(a) => a.name === event.targetAction && a.on === event.type,
		);

		if (!action) {
			logger.warn("event.no-match", {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
			});
			await bus.emit({ ...event, state: "done", result: "skipped" });
			return;
		}

		await executeAction(event, action);
	}

	async function fanOut(event: RuntimeEvent): Promise<void> {
		const matching = actions.filter((a) => a.on === event.type);

		if (matching.length === 0) {
			logger.warn("event.fanout.skipped", {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
			});
			await bus.emit({ ...event, state: "done", result: "skipped" });
			return;
		}

		logger.info("event.fanout", {
			correlationId: event.correlationId,
			eventId: event.id,
			type: event.type,
			targets: matching.length,
		});

		for (const action of matching) {
			const forked = eventFactory.fork(event, { targetAction: action.name });
			// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design
			await bus.emit(forked);
		}

		await bus.emit({ ...event, state: "done", result: "succeeded" });
	}

	async function executeAction(event: RuntimeEvent, action: Action): Promise<void> {
		logger.info("action.started", {
			correlationId: event.correlationId,
			eventId: event.id,
			action: action.name,
		});
		const start = performance.now();
		try {
			const ctx = createContext(event, action.name);
			await action.handler(ctx);
			const durationMs = Math.round(performance.now() - start);
			logger.info("action.completed", {
				correlationId: event.correlationId,
				eventId: event.id,
				action: action.name,
				durationMs,
			});
			await bus.emit({ ...event, state: "done", result: "succeeded" });
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
				state: "done",
				result: "failed",
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
