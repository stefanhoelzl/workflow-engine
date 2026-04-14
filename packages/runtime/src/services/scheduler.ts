import {
	sandbox as defaultSandbox,
	type MethodMap,
	type Sandbox,
	type SandboxOptions,
} from "@workflow-engine/sandbox";
import type { Action } from "../actions/index.js";
import type { ActionContext } from "../context/index.js";
import type { RuntimeEvent } from "../event-bus/index.js";
import type { WorkQueue } from "../event-bus/work-queue.js";
import type { EventSource } from "../event-source.js";
import type { Service } from "./index.js";

type ActionContextFactory = (
	event: RuntimeEvent,
	actionName: string,
	env: Record<string, string>,
) => ActionContext;

type SandboxFactory = (
	source: string,
	methods: MethodMap,
	options?: SandboxOptions,
) => Promise<Sandbox>;

interface SchedulerOptions {
	sandboxFactory?: SandboxFactory;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled lifecycle logic
// biome-ignore lint/complexity/useMaxParams: factory dependencies are all required
function createScheduler(
	workQueue: WorkQueue,
	source: EventSource,
	actionSource: { readonly actions: Action[] },
	createContext: ActionContextFactory,
	options: SchedulerOptions = {},
): Service {
	const sandboxFactory: SandboxFactory =
		options.sandboxFactory ?? defaultSandbox;
	let running = false;
	let loopPromise: Promise<void> | null = null;
	const ac = new AbortController();
	const sandboxes = new Map<string, Sandbox>();

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

		const action = actionSource.actions.find(
			(a) => a.name === event.targetAction && a.on === event.type,
		);

		if (!action) {
			await source.transition(event, { state: "done", result: "skipped" });
			return;
		}

		await executeAction(event, action);
	}

	async function fanOut(event: RuntimeEvent): Promise<void> {
		const matching = actionSource.actions.filter((a) => a.on === event.type);

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

	function pruneStaleSandboxes(): void {
		const liveSources = new Set(actionSource.actions.map((a) => a.source));
		for (const [src, sb] of sandboxes) {
			if (!liveSources.has(src)) {
				sb.dispose();
				sandboxes.delete(src);
			}
		}
	}

	async function getOrCreateSandbox(action: Action): Promise<Sandbox> {
		const existing = sandboxes.get(action.source);
		if (existing) {
			return existing;
		}
		pruneStaleSandboxes();
		const created = await sandboxFactory(
			action.source,
			{},
			{ filename: `${action.name}.js` },
		);
		sandboxes.set(action.source, created);
		return created;
	}

	async function executeAction(
		event: RuntimeEvent,
		action: Action,
	): Promise<void> {
		const ctx = createContext(event, action.name, action.env);
		const guestCtx = {
			event: { name: ctx.event.type, payload: ctx.event.payload },
			env: ctx.env,
		};
		const sb = await getOrCreateSandbox(action);
		const result = await sb.run(action.exportName, guestCtx, {
			emit: async (...args: unknown[]) => {
				const [type, payload] = args as [string, unknown];
				await source.derive(event, type, payload, action.name);
			},
		});
		if (result.ok) {
			await source.transition(event, {
				state: "done",
				result: "succeeded",
				logs: result.logs,
			});
		} else {
			await source.transition(event, {
				state: "done",
				result: "failed",
				error: result.error,
				logs: result.logs,
			});
		}
	}

	function disposeAll(): void {
		for (const sb of sandboxes.values()) {
			sb.dispose();
		}
		sandboxes.clear();
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
			disposeAll();
		},
	};
}

export { createScheduler };
