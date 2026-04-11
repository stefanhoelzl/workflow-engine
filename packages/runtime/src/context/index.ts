import type { RuntimeEvent } from "../event-bus/index.js";
import type { EventSource } from "../event-source.js";

class ActionContext {
	readonly event: RuntimeEvent;
	readonly env: Record<string, string>;
	readonly #emit: (type: string, payload: unknown) => Promise<void>;

	constructor(
		event: RuntimeEvent,
		emit: (type: string, payload: unknown) => Promise<void>,
		env: Record<string, string>,
	) {
		this.event = event;
		this.#emit = emit;
		this.env = env;
	}

	emit(type: string, payload: unknown): Promise<void> {
		return this.#emit(type, payload);
	}
}

function createActionContext(
	source: EventSource,
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
			env,
		);
}

export { ActionContext, createActionContext };
