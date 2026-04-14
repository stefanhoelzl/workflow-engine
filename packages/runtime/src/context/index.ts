import type { RuntimeEvent } from "../event-bus/index.js";

class ActionContext {
	readonly event: RuntimeEvent;
	readonly env: Record<string, string>;

	constructor(event: RuntimeEvent, env: Record<string, string>) {
		this.event = event;
		this.env = env;
	}
}

function createActionContext(): (
	event: RuntimeEvent,
	actionName: string,
	env: Record<string, string>,
) => ActionContext {
	return (event, _actionName, env) => new ActionContext(event, env);
}

export { ActionContext, createActionContext };
