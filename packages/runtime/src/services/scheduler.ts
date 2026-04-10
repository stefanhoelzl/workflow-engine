import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { RuntimeEvent } from "../event-bus/index.js";
import type { WorkQueue } from "../event-bus/work-queue.js";
import type { EventSource } from "../event-source.js";
import type { Sandbox } from "../sandbox/index.js";
import type { Service } from "./index.js";

type ActionContextFactory = (event: RuntimeEvent, actionName: string, env: Record<string, string>) => ActionContext;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled lifecycle logic
// biome-ignore lint/complexity/useMaxParams: factory dependencies are all required
function createScheduler(
	workQueue: WorkQueue,
	source: EventSource,
	actions: Action[],
	createContext: ActionContextFactory,
	sandbox: Sandbox,
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
		await source.transition(event, { state: "processing" });

		if (event.targetAction === undefined) {
			await fanOut(event);
			return;
		}

		const action = actions.find(
			(a) => a.name === event.targetAction && a.on === event.type,
		);

		if (!action) {
			await source.transition(event, { state: "done", result: "skipped" });
			return;
		}

		await executeAction(event, action);
	}

	async function fanOut(event: RuntimeEvent): Promise<void> {
		const matching = actions.filter((a) => a.on === event.type);

		if (matching.length === 0) {
			await source.transition(event, { state: "done", result: "skipped" });
			return;
		}

		for (const action of matching) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design
			await source.fork(event, { targetAction: action.name });
		}

		await source.transition(event, { state: "done", result: "succeeded" });
	}

	async function executeAction(event: RuntimeEvent, action: Action): Promise<void> {
		const ctx = createContext(event, action.name, action.env);
		const result = await sandbox.spawn(action.source, ctx, { filename: `${action.name}.js` });
		if (result.ok) {
			await source.transition(event, { state: "done", result: "succeeded" });
		} else {
			await source.transition(event, {
				state: "done",
				result: "failed",
				error: result.error,
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
